import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { normalizeApiVersion } from "../../src/generator/emit/emit-index.ts";
import { GENERATED_HEADER } from "../../src/generator/emit/emit-types.ts";
import { generateSdk } from "../../src/index.ts";

const execFileAsync = promisify(execFile);
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe("generateSdk emit (petstore)", () => {
  // Package mode keeps these snapshots focused on codegen (no inlined runtime).
  const generate = () => generateSdk({ input: fixture("petstore-3.0.json"), runtime: "package" });

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
      "config.ts",
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
      runtime: "package",
    });
    const index = files.find((f) => f.path === "index.ts")!.contents;
    expect(index).toContain('from "./config.js"');
    expect(index).toContain("export function createPetstore(config: SdkConfig = {})");
    expect(index).toContain(
      "export type CreatePetstoreClient = ReturnType<typeof createPetstore>;"
    );
    expect(index).toContain('from "./services/pets.js"');
    expect(index).toContain('from "./types/index.js"');

    // The runtimePackage specifier lands in the config module (package mode).
    const config = files.find((f) => f.path === "config.ts")!.contents;
    expect(config).toContain('from "my-runtime/client"');

    const service = files.find((f) => f.path === "services/pets.ts")!.contents;
    expect(service).toContain('from "../types/index.js"');
  });
});

describe("normalizeApiVersion", () => {
  // Left column is what a provider publishes; right is what should be documented.
  const cases: [version: string, normalized: string][] = [
    // The real-world shape: a full 40-char git sha.
    ["1001.0.0-SNAPSHOT-b5920d1eaef179a2bd7f107d8da95822cab568b5", "1001.0.0"],
    // A short sha is a build id too.
    ["1001.0.0-SNAPSHOT-b5920d1e", "1001.0.0"],
    ["1001.0.0-SNAPSHOT-b5920d1", "1001.0.0"],
    // Bare -SNAPSHOT is stable across deploys, so it is not churn: keep it.
    ["1001.0.0-SNAPSHOT", "1001.0.0-SNAPSHOT"],
    // Below a git short sha, or not hex: a meaningful prerelease tag, not a build id.
    ["1.0.0-SNAPSHOT-b5920d", "1.0.0-SNAPSHOT-b5920d"],
    ["1.0.0-SNAPSHOT-rc2", "1.0.0-SNAPSHOT-rc2"],
    ["1.0.0-SNAPSHOT-2024.11.03", "1.0.0-SNAPSHOT-2024.11.03"],
    // Ordinary versions are untouched.
    ["1.0.0", "1.0.0"],
    ["1.2.3-beta.1", "1.2.3-beta.1"],
    ["v2", "v2"],
    ["2024-11-03", "2024-11-03"],
    // Only a trailing build id is stripped.
    [
      "1.0.0-SNAPSHOT-b5920d1eaef179a2bd7f107d8da95822cab568b5+meta",
      "1.0.0-SNAPSHOT-b5920d1eaef179a2bd7f107d8da95822cab568b5+meta",
    ],
  ];

  it.each(cases)("normalizes %s to %s", (version, normalized) => {
    expect(normalizeApiVersion(version)).toBe(normalized);
  });

  it("never reduces a version to nothing", () => {
    // A version that is only a build id keeps its original text.
    expect(normalizeApiVersion("-SNAPSHOT-b5920d1eaef179a2bd7f107d8da95822")).toBe(
      "-SNAPSHOT-b5920d1eaef179a2bd7f107d8da95822"
    );
  });
});

describe("normalizeVersion option", () => {
  const snapshotSpec = (version: string) => ({
    openapi: "3.1.0",
    info: { title: "Catalog", version },
    paths: {
      "/things": {
        get: {
          operationId: "listThings",
          tags: ["things"],
          responses: { "204": { description: "ok" } },
        },
      },
    },
  });
  const buildSha = "1001.0.0-SNAPSHOT-b5920d1eaef179a2bd7f107d8da95822cab568b5";
  const indexOf = (files: { path: string; contents: string }[]) =>
    files.find((f) => f.path === "index.ts")!.contents;

  it("embeds the version verbatim by default", async () => {
    const { files } = await generateSdk({ input: snapshotSpec(buildSha) });
    expect(indexOf(files)).toContain(`(API version ${buildSha})`);
  });

  it("strips the build id when enabled", async () => {
    const { files } = await generateSdk({ input: snapshotSpec(buildSha), normalizeVersion: true });
    const index = indexOf(files);
    expect(index).toContain("(API version 1001.0.0)");
    expect(index).not.toContain("SNAPSHOT");
  });

  it("leaves a plain semver untouched when enabled", async () => {
    const { files } = await generateSdk({ input: snapshotSpec("1.2.3"), normalizeVersion: true });
    expect(indexOf(files)).toContain("(API version 1.2.3)");
  });

  it("produces identical output across two different build shas", async () => {
    // The churn this option exists to prevent: same API, different deploy.
    const [a, b] = await Promise.all([
      generateSdk({
        input: snapshotSpec("1001.0.0-SNAPSHOT-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
        normalizeVersion: true,
      }),
      generateSdk({
        input: snapshotSpec("1001.0.0-SNAPSHOT-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
        normalizeVersion: true,
      }),
    ]);
    expect(a.files).toEqual(b.files);
  });

  it("differs across those same two shas without the option", async () => {
    const [a, b] = await Promise.all([
      generateSdk({
        input: snapshotSpec("1001.0.0-SNAPSHOT-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      }),
      generateSdk({
        input: snapshotSpec("1001.0.0-SNAPSHOT-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      }),
    ]);
    expect(a.files).not.toEqual(b.files);
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

  it("renders collision suffixes in camelCase when collisionCase is 'camelCase'", async () => {
    const { files } = await generateSdk({ input: collisionSpec, collisionCase: "camelCase" });
    const service = files.find((f) => f.path === "services/items.ts")!.contents;

    expect(service).toContain("statusPath: string;");
    expect(service).toContain("statusQuery?: string;");
    expect(service).toContain("const { statusPath, statusQuery, ...body } = params;");
    expect(service).toContain("pathParams: { status: statusPath }");
    expect(service).toContain("query: { status: statusQuery }");
    // Body property `status` is untouched regardless of collisionCase.
    expect(service).not.toContain("status_path");
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

describe("header option", () => {
  // Default runtime ("generate") so the inlined client/ and transport/ files,
  // which take a different header code path, are covered too.
  const withHeader = () => generateSdk({ input: fixture("petstore-3.0.json") });
  const noHeader = () => generateSdk({ input: fixture("petstore-3.0.json"), header: false });

  it("emits the header by default", async () => {
    const { files } = await withHeader();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.contents.startsWith(`${GENERATED_HEADER}\n\n`)).toBe(true);
    }
  });

  it("omits only the header and its blank line with `header: false`", async () => {
    const [on, off] = await Promise.all([withHeader(), noHeader()]);

    expect(off.files.map((f) => f.path)).toEqual(on.files.map((f) => f.path));
    // The sole difference is the header prefix: every body is byte-identical.
    for (const [i, file] of off.files.entries()) {
      expect(`${GENERATED_HEADER}\n\n${file.contents}`).toBe(on.files[i]!.contents);
    }
  });

  it("leaves no stray blank first line", async () => {
    const { files } = await noHeader();
    for (const file of files) {
      expect(file.contents).not.toContain(GENERATED_HEADER);
      expect(file.contents.startsWith("\n")).toBe(false);
      expect(file.contents.endsWith("\n")).toBe(true);
    }
  });

  it("starts the barrel at its first export", async () => {
    const { files } = await noHeader();
    expect(files.find((f) => f.path === "types/index.ts")!.contents).toBe(
      ['export * from "./common";', 'export * from "./pets";', 'export * from "./store";', ""].join(
        "\n"
      )
    );
  });

  it("treats `header: true` as the default", async () => {
    const [explicit, implicit] = await Promise.all([
      generateSdk({ input: fixture("petstore-3.0.json"), header: true }),
      withHeader(),
    ]);
    expect(explicit.files).toEqual(implicit.files);
  });

  it("compiles with the header omitted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "narthia-sdk-nohdr-"));
    headerDirs.push(dir);
    await generateSdk({
      input: fixture("petstore-3.0.json"),
      output: join(dir, "sdk"),
      header: false,
    });
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
        },
        include: ["sdk/**/*.ts"],
      }),
      "utf8"
    );
    const tscBin = join(fileURLToPath(new URL("../..", import.meta.url)), "node_modules/.bin/tsc");
    await expect(execFileAsync(tscBin, ["-p", dir], { cwd: dir })).resolves.toBeDefined();
  }, 60_000);

  const headerDirs: string[] = [];
  afterAll(async () => {
    await Promise.all(headerDirs.map((d) => rm(d, { recursive: true, force: true })));
  });
});

describe("generated code validity", () => {
  const dirs: string[] = [];
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const tsc = join(repoRoot, "node_modules/.bin/tsc");

  afterAll(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const writeTsconfig = async (dir: string, paths?: Record<string, string[]>) => {
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
          ...(paths ? { paths } : {}),
        },
        include: ["sdk/**/*.ts"],
      }),
      "utf8"
    );
  };

  it("generate mode: self-contained output compiles with NO package mapping", async () => {
    const dir = await mkdtemp(join(tmpdir(), "narthia-sdk-gen-"));
    dirs.push(dir);
    // Default runtime: "generate" — the runtime is inlined, so tsc needs no paths.
    await generateSdk({ input: fixture("petstore-3.0.json"), output: join(dir, "sdk") });
    await writeTsconfig(dir);
    await expect(execFileAsync(tsc, ["-p", dir], { cwd: dir })).resolves.toBeDefined();
  }, 60_000);

  it("package mode: compiles against the runtime package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "narthia-sdk-pkg-"));
    dirs.push(dir);
    await generateSdk({
      input: fixture("petstore-3.0.json"),
      output: join(dir, "sdk"),
      runtime: "package",
      runtimePackage: "@narthia/openapi-sdk-generator",
    });
    await writeTsconfig(dir, {
      "@narthia/openapi-sdk-generator/client": [join(repoRoot, "src/client/index.ts")],
    });
    await expect(execFileAsync(tsc, ["-p", dir], { cwd: dir })).resolves.toBeDefined();
  }, 60_000);
});
