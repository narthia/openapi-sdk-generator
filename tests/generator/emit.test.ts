import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { generateSdk } from "../../src/index.ts";

const execFileAsync = promisify(execFile);
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe("generateSdk emit (petstore)", () => {
  const generate = () => generateSdk({ input: fixture("petstore-3.0.json") });

  it("emits the expected file tree", async () => {
    const { files, warnings } = await generate();
    // No types/health.ts: the health response is an anonymous inline object.
    expect(files.map((f) => f.path)).toEqual([
      "types/common.ts",
      "types/pets.ts",
      "types/store.ts",
      "types/index.ts",
      "services/pets.ts",
      "services/store.ts",
      "services/health.ts",
      "index.ts",
    ]);
    expect(warnings).toEqual([]);
  });

  it("matches file snapshots", async () => {
    const { files } = await generate();
    for (const file of files) {
      await expect(file.contents).toMatchFileSnapshot(
        `__snapshots__/petstore/${file.path.replace(/\//g, "__")}.snap`
      );
    }
  });

  it("emits identical output for the 3.0 and 3.1 fixtures", async () => {
    const [v30, v31] = await Promise.all([
      generateSdk({ input: fixture("petstore-3.0.json") }),
      generateSdk({ input: fixture("petstore-3.1.json") }),
    ]);
    expect(v30.files).toEqual(v31.files);
  });

  it("honors name, runtimePackage, and importExtension options", async () => {
    const { files } = await generateSdk({
      input: fixture("petstore-3.0.json"),
      name: "createPetstore",
      runtimePackage: "my-runtime",
      importExtension: "js",
    });
    const index = files.find((f) => f.path === "index.ts")!.contents;
    expect(index).toContain('from "my-runtime/client"');
    expect(index).toContain("export function createPetstore(config: ClientConfig = {})");
    expect(index).toContain(
      "export type CreatePetstoreClient = ReturnType<typeof createPetstore>;"
    );
    expect(index).toContain('from "./services/pets.js"');
    expect(index).toContain('from "./types/index.js"');

    const service = files.find((f) => f.path === "services/pets.ts")!.contents;
    expect(service).toContain('from "../types/index.js"');
  });
});

describe("flat method arguments", () => {
  // Path `status`, query `status`, and a body property `status` all collide.
  const collisionSpec = {
    openapi: "3.1.0",
    info: { title: "t", version: "1" },
    paths: {
      "/items/{status}": {
        post: {
          operationId: "updateItem",
          tags: ["items"],
          parameters: [
            { name: "status", in: "path", required: true, schema: { type: "string" } },
            { name: "status", in: "query", schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status", "name"],
                  properties: { status: { type: "string" }, name: { type: "string" } },
                },
              },
            },
          },
          responses: { "204": { description: "ok" } },
        },
      },
    },
  };

  it("suffixes colliding path/query params and never renames body properties", async () => {
    const { files } = await generateSdk({ input: collisionSpec });
    const service = files.find((f) => f.path === "services/items.ts")!.contents;

    // Body keeps `status` and `name`; path becomes status_path, query status_query.
    expect(service).toContain("status_path: string;");
    expect(service).toContain("status_query?: string;");
    // Destructure pulls the renamed params out of `params`; the rest is the body.
    expect(service).toContain("const { status_path, status_query, ...body } = params;");
    // Request maps them back to their wire names (runtime routing of the
    // destructure+rest pattern is exercised end-to-end in e2e.test.ts).
    expect(service).toContain("pathParams: { status: status_path }");
    expect(service).toContain("query: { status: status_query }");
    expect(service).toContain("body: body,");
  });
});

describe("type partitioning", () => {
  it("puts shared types in common, exclusive types in per-service files", async () => {
    const { files } = await generateSdk({ input: fixture("petstore-3.0.json") });
    const contentsOf = (path: string) => files.find((f) => f.path === path)!.contents;

    // Error is referenced by pets and store → common.
    expect(contentsOf("types/common.ts")).toContain("export interface Error {");
    // Pet/NewPet/Category are pets-only; Order is store-only.
    const pets = contentsOf("types/pets.ts");
    expect(pets).toContain("export type Pet =");
    expect(pets).toContain("export interface NewPet {");
    expect(pets).toContain("export interface Category {");
    expect(contentsOf("types/store.ts")).toContain("export interface Order {");
    // Barrel re-exports every file.
    expect(contentsOf("types/index.ts")).toBe(
      [
        "// Generated by @narthia/openapi-sdk-generator. Do not edit manually.",
        "",
        'export * from "./common";',
        'export * from "./pets";',
        'export * from "./store";',
        "",
      ].join("\n")
    );
  });

  it("promotes types referenced by common types into common (ref closure)", async () => {
    const { files } = await generateSdk({
      input: {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {
          "/a": {
            get: {
              operationId: "getA",
              tags: ["a"],
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Shared" } },
                  },
                },
              },
            },
          },
          "/b": {
            get: {
              operationId: "getB",
              tags: ["b"],
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Shared" } },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Shared: {
              type: "object",
              properties: { nested: { $ref: "#/components/schemas/Nested" } },
            },
            // Nested is only reachable through Shared (common) → must be common too.
            Nested: { type: "object", properties: { x: { type: "string" } } },
          },
        },
      },
    });
    const common = files.find((f) => f.path === "types/common.ts")!.contents;
    expect(common).toContain("export interface Shared {");
    expect(common).toContain("export interface Nested {");
    expect(files.some((f) => f.path === "types/a.ts" || f.path === "types/b.ts")).toBe(false);
  });

  it("keeps unreferenced schemas in common so nothing is dropped", async () => {
    const { files } = await generateSdk({
      input: {
        openapi: "3.1.0",
        info: { title: "t", version: "1" },
        paths: {},
        components: {
          schemas: { Orphan: { type: "object", properties: { a: { type: "string" } } } },
        },
      },
    });
    expect(files.find((f) => f.path === "types/common.ts")!.contents).toContain(
      "export interface Orphan {"
    );
  });
});

describe("generated code validity", () => {
  let dir: string;

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("passes tsc --noEmit", async () => {
    dir = await mkdtemp(join(tmpdir(), "narthia-sdk-gen-"));
    await generateSdk({
      input: fixture("petstore-3.0.json"),
      output: join(dir, "sdk"),
      // Point the runtime import at this repo's sources so tsc can resolve it
      // without a package install.
      runtimePackage: "@narthia/openapi-sdk-generator",
    });

    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          lib: ["es2023", "dom", "dom.iterable"],
          paths: {
            "@narthia/openapi-sdk-generator/client": [join(repoRoot, "src/client/index.ts")],
          },
        },
        include: ["sdk/**/*.ts"],
      }),
      "utf8"
    );

    const tsc = join(repoRoot, "node_modules/.bin/tsc");
    await expect(execFileAsync(tsc, ["-p", dir], { cwd: dir })).resolves.toBeDefined();
  }, 60_000);
});
