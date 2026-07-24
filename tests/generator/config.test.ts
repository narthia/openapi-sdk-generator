import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CliIo } from "../../src/cli/index.ts";
import { runCli } from "../../src/cli/index.ts";
import { loadConfig, resolveConfigPath } from "../../src/cli/load-config.ts";
import { defineConfig } from "../../src/index.ts";

const fixture = fileURLToPath(new URL("../fixtures/petstore-3.0.json", import.meta.url));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (m) => out.push(m), err: (m) => err.push(m) }, out, err };
}

describe("defineConfig", () => {
  it("returns its input unchanged", () => {
    const config = defineConfig({ input: "./openapi.json", output: "./sdk", name: "createApi" });
    expect(config).toEqual({ input: "./openapi.json", output: "./sdk", name: "createApi" });
  });
});

describe("resolveConfigPath / loadConfig", () => {
  const dirs: string[] = [];
  const makeDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "narthia-cfg-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("returns undefined when no config exists", async () => {
    const dir = await makeDir();
    expect(await resolveConfigPath(undefined, dir)).toBeUndefined();
  });

  it("auto-discovers openapi-sdk.config.json in cwd", async () => {
    const dir = await makeDir();
    const path = join(dir, "openapi-sdk.config.json");
    await writeFile(path, "{}");
    expect(await resolveConfigPath(undefined, dir)).toBe(path);
  });

  it("throws when an explicit config is missing", async () => {
    const dir = await makeDir();
    await expect(resolveConfigPath("nope.json", dir)).rejects.toThrow(/Config file not found/);
  });

  it("loads a JSON config", async () => {
    const dir = await makeDir();
    const path = join(dir, "c.json");
    await writeFile(path, JSON.stringify({ name: "createJson", collisionCase: "camelCase" }));
    expect(await loadConfig(path)).toEqual({ name: "createJson", collisionCase: "camelCase" });
  });

  it("loads an .mjs config's default export", async () => {
    const dir = await makeDir();
    const path = join(dir, "c.mjs");
    await writeFile(path, 'export default { name: "createMjs" };\n');
    expect(await loadConfig(path)).toEqual({ name: "createMjs" });
  });

  it("rejects a non-object config", async () => {
    const dir = await makeDir();
    const path = join(dir, "c.json");
    await writeFile(path, "[1, 2, 3]");
    await expect(loadConfig(path)).rejects.toThrow(/must export an options object/);
  });
});

describe("runCli with a config file", () => {
  const dirs: string[] = [];
  const makeDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "narthia-cfgcli-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("takes input/output from an explicit --config file", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    const cfg = join(dir, "sdk.config.json");
    await writeFile(
      cfg,
      JSON.stringify({ input: fixture, output: outDir, name: "createFromConfig" })
    );

    const { io } = captureIo();
    expect(await runCli(["-c", cfg], io)).toBe(0);
    const index = await readFile(join(outDir, "index.ts"), "utf8");
    expect(index).toContain("export function createFromConfig");
  });

  it("lets CLI flags override config values", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    const cfg = join(dir, "sdk.config.json");
    await writeFile(cfg, JSON.stringify({ input: fixture, output: outDir, name: "fromConfig" }));

    const { io } = captureIo();
    expect(await runCli(["-c", cfg, "-n", "fromFlag"], io)).toBe(0);
    const index = await readFile(join(outDir, "index.ts"), "utf8");
    expect(index).toContain("export function fromFlag");
    expect(index).not.toContain("export function fromConfig");
  });

  it("auto-discovers a config in the working directory", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await writeFile(
      join(dir, "openapi-sdk.config.json"),
      JSON.stringify({ input: fixture, output: outDir })
    );

    const { io } = captureIo();
    expect(await runCli([], io, dir)).toBe(0);
    await expect(stat(join(outDir, "index.ts"))).resolves.toBeDefined();
  });

  it("applies auth from the config file", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    const cfg = join(dir, "sdk.config.json");
    await writeFile(
      cfg,
      JSON.stringify({
        input: fixture,
        output: outDir,
        auth: { basic: { usernameField: "email", passwordField: "apiToken" } },
      })
    );

    const { io } = captureIo();
    expect(await runCli(["-c", cfg], io)).toBe(0);
    const index = await readFile(join(outDir, "index.ts"), "utf8");
    expect(index).toContain("email: string;");
    expect(index).toContain("apiToken: string;");
  });

  it("lets CLI auth flags override config auth", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    const cfg = join(dir, "sdk.config.json");
    await writeFile(cfg, JSON.stringify({ input: fixture, output: outDir, auth: { basic: {} } }));

    const { io } = captureIo();
    expect(await runCli(["-c", cfg, "--auth-type", "bearer"], io)).toBe(0);
    const index = await readFile(join(outDir, "index.ts"), "utf8");
    expect(index).toContain("token: ValueOrFactory;");
    expect(index).not.toContain("username: string;");
  });

  it("errors when input/output are absent from both flags and config", async () => {
    const dir = await makeDir();
    const { io, err } = captureIo();
    expect(await runCli([], io, dir)).toBe(1);
    expect(err.join("\n")).toContain("both input and output are required");
  });

  it("errors when an explicit --config is missing", async () => {
    const { io, err } = captureIo();
    expect(await runCli(["-c", "/no/such/config.json"], io)).toBe(1);
    expect(err.join("\n")).toContain("Config file not found");
  });
});
