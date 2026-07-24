import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { GenerateOptions } from "../../src/index.ts";
import { generateSdk, normalizeTargets } from "../../src/generator/generate.ts";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixture31 = fileURLToPath(new URL("../fixtures/petstore-3.1.json", import.meta.url));
const fixture30 = fileURLToPath(new URL("../fixtures/petstore-3.0.json", import.meta.url));

async function generate(options: GenerateOptions) {
  const { files } = await generateSdk(options);
  return {
    paths: files.map((f) => f.path),
    get: (p: string) => files.find((f) => f.path === p)?.contents,
  };
}

const twoInputs = {
  jira: {
    input: fixture31,
    name: "createJira",
    auth: { basic: { usernameField: "email", passwordField: "apiToken" } },
  },
  billing: { input: fixture30, name: "createBilling", auth: { bearer: {} } },
} as const;

describe("normalizeTargets", () => {
  it("maps a single input to a flat target", () => {
    const targets = normalizeTargets({ input: fixture31 });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.subdir).toBe("");
  });

  it("maps inputs to kebab-cased subfolders", () => {
    const targets = normalizeTargets({ inputs: { myApi: { input: fixture31 } } });
    expect(targets[0]!.subdir).toBe("my-api");
  });

  it("throws when both input and inputs are given", () => {
    const invalid = { input: fixture31, inputs: { a: { input: fixture30 } } } as unknown;
    expect(() => normalizeTargets(invalid as GenerateOptions)).toThrow(
      /either `input`.*or `inputs`/
    );
  });

  it("throws on empty inputs", () => {
    expect(() => normalizeTargets({ inputs: {} })).toThrow(/at least one entry/);
  });

  it("throws when input keys collide on a folder name", () => {
    expect(() =>
      normalizeTargets({ inputs: { myApi: { input: fixture31 }, "my-api": { input: fixture30 } } })
    ).toThrow(/collide on folder/);
  });
});

describe("multi-input generate mode", () => {
  it("emits one shared runtime and a subtree per input", async () => {
    const { paths } = await generate({ inputs: twoInputs });

    // Shared runtime at the root, emitted once.
    expect(paths).toContain("client/client.ts");
    expect(paths).toContain("transport/http.ts");
    expect(paths.filter((p) => p === "client/client.ts")).toHaveLength(1);

    // Per-input subtrees.
    expect(paths).toContain("jira/index.ts");
    expect(paths).toContain("jira/config.ts");
    expect(paths).toContain("jira/services/pets.ts");
    expect(paths).toContain("billing/index.ts");
    expect(paths).toContain("billing/config.ts");
  });

  it("gives each input its own auth in its own config", async () => {
    const { get } = await generate({ inputs: twoInputs });
    const jira = get("jira/config.ts")!;
    expect(jira).toContain("email: string;");
    expect(jira).toContain("apiToken: string;");
    const billing = get("billing/config.ts")!;
    expect(billing).toContain("token: ValueOrFactory;");
    expect(billing).not.toContain("email: string;");
  });

  it("uses depth-correct relative imports to the shared runtime", async () => {
    const { get } = await generate({ inputs: twoInputs });
    expect(get("jira/config.ts")!).toContain('from "../client"');
    expect(get("jira/services/pets.ts")!).toContain('from "../../client"');
    // Within-subdir imports are unchanged.
    expect(get("jira/index.ts")!).toContain('from "./config"');
  });
});

describe("multi-input package mode", () => {
  it("imports the package from every subtree and emits no runtime", async () => {
    const { paths, get } = await generate({ runtime: "package", inputs: twoInputs });
    expect(paths.some((p) => p.startsWith("client/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("transport/"))).toBe(false);
    expect(get("jira/config.ts")!).toContain('from "@narthia/openapi-sdk-generator/client"');
    expect(get("jira/services/pets.ts")!).toContain('from "@narthia/openapi-sdk-generator/client"');
  });
});

describe("multi-input compiles", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("passes tsc --noEmit over the whole tree with no package mapping", async () => {
    dir = await mkdtemp(join(tmpdir(), "narthia-multi-"));
    await generateSdk({ output: join(dir, "sdk"), inputs: twoInputs });
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
    const tsc = join(repoRoot, "node_modules/.bin/tsc");
    await expect(execFileAsync(tsc, ["-p", dir], { cwd: dir })).resolves.toBeDefined();
  }, 60_000);
});
