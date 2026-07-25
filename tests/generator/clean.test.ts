import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CliIo } from "../../src/cli/index.ts";
import { runCli } from "../../src/cli/index.ts";
import { generateSdk } from "../../src/generator/generate.ts";

const fixture = fileURLToPath(new URL("../fixtures/petstore-3.0.json", import.meta.url));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (m) => out.push(m), err: (m) => err.push(m) }, out, err };
}

describe("output directory cleaning", () => {
  const dirs: string[] = [];
  const makeDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "narthia-clean-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** Seed an output dir with a file that no generate run would produce. */
  const seedStale = async (outDir: string) => {
    await mkdir(join(outDir, "services"), { recursive: true });
    await writeFile(join(outDir, "services", "stale.ts"), "export const stale = true;\n");
  };

  it("removes stale files by default", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await seedStale(outDir);

    await generateSdk({ input: fixture, output: outDir });

    await expect(stat(join(outDir, "services", "stale.ts"))).rejects.toThrow(/ENOENT/);
    await expect(stat(join(outDir, "index.ts"))).resolves.toBeDefined();
  });

  it("keeps existing files with `clean: false`", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await seedStale(outDir);

    await generateSdk({ input: fixture, output: outDir, clean: false });

    await expect(stat(join(outDir, "services", "stale.ts"))).resolves.toBeDefined();
    await expect(stat(join(outDir, "index.ts"))).resolves.toBeDefined();
  });

  it("still overwrites regenerated files with `clean: false`", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "index.ts"), "stale contents");

    await generateSdk({ input: fixture, output: outDir, clean: false });

    const { files } = await generateSdk({ input: fixture });
    const expected = files.find((f) => f.path === "index.ts")!.contents;
    expect(await readFile(join(outDir, "index.ts"), "utf8")).toBe(expected);
  });

  it("works on a fresh directory with `clean: false`", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");

    await expect(
      generateSdk({ input: fixture, output: outDir, clean: false })
    ).resolves.toBeDefined();
    await expect(stat(join(outDir, "index.ts"))).resolves.toBeDefined();
  });

  it("cleans the whole output root in multi-input mode", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await mkdir(join(outDir, "dropped"), { recursive: true });
    await writeFile(join(outDir, "dropped", "index.ts"), "export const gone = true;\n");

    await generateSdk({ output: outDir, inputs: { jira: { input: fixture } } });

    // A previously generated input that is no longer configured is removed.
    await expect(stat(join(outDir, "dropped"))).rejects.toThrow(/ENOENT/);
    await expect(stat(join(outDir, "jira", "index.ts"))).resolves.toBeDefined();
  });

  it("--no-clean keeps existing files", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await seedStale(outDir);

    const { io } = captureIo();
    expect(await runCli(["-i", fixture, "-o", outDir, "--no-clean"], io)).toBe(0);

    await expect(stat(join(outDir, "services", "stale.ts"))).resolves.toBeDefined();
    await expect(stat(join(outDir, "index.ts"))).resolves.toBeDefined();
  });

  it("cleans without --no-clean", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await seedStale(outDir);

    const { io } = captureIo();
    expect(await runCli(["-i", fixture, "-o", outDir], io)).toBe(0);

    await expect(stat(join(outDir, "services", "stale.ts"))).rejects.toThrow(/ENOENT/);
  });

  it("--no-clean overrides `clean: true` from the config file", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await seedStale(outDir);
    const cfg = join(dir, "sdk.config.json");
    await writeFile(cfg, JSON.stringify({ input: fixture, output: outDir, clean: true }));

    const { io } = captureIo();
    expect(await runCli(["-c", cfg, "--no-clean"], io)).toBe(0);

    await expect(stat(join(outDir, "services", "stale.ts"))).resolves.toBeDefined();
  });

  it("honours `clean: false` from the config file", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await seedStale(outDir);
    const cfg = join(dir, "sdk.config.json");
    await writeFile(cfg, JSON.stringify({ input: fixture, output: outDir, clean: false }));

    const { io } = captureIo();
    expect(await runCli(["-c", cfg], io)).toBe(0);

    await expect(stat(join(outDir, "services", "stale.ts"))).resolves.toBeDefined();
  });
});
