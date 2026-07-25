import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CliIo } from "../../src/cli/index.ts";
import { runCli } from "../../src/cli/index.ts";
import { GENERATED_HEADER } from "../../src/generator/emit/emit-types.ts";
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

  it("cleans by default", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await seedStale(outDir);

    const { io } = captureIo();
    expect(await runCli(["-i", fixture, "-o", outDir], io)).toBe(0);

    await expect(stat(join(outDir, "services", "stale.ts"))).rejects.toThrow(/ENOENT/);
  });

  it("--clean none overrides `clean: true` from the config file", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await seedStale(outDir);
    const cfg = join(dir, "sdk.config.json");
    await writeFile(cfg, JSON.stringify({ input: fixture, output: outDir, clean: true }));

    const { io } = captureIo();
    expect(await runCli(["-c", cfg, "--clean", "none"], io)).toBe(0);

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

describe('output cleaning: "generated"', () => {
  const dirs: string[] = [];
  const makeDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "narthia-prune-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** A file carrying the generated header, as an earlier run would have left it. */
  const writeGenerated = async (path: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${GENERATED_HEADER}\n\nexport const fromAnEarlierRun = true;\n`, "utf8");
  };

  /** A file the user maintains by hand: no header. */
  const writeByHand = async (path: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "export const mine = true;\n", "utf8");
  };

  it("removes generated files this run no longer emits", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await writeGenerated(join(outDir, "services", "dropped-service.ts"));

    await generateSdk({ input: fixture, output: outDir, clean: "generated" });

    await expect(stat(join(outDir, "services", "dropped-service.ts"))).rejects.toThrow(/ENOENT/);
    await expect(stat(join(outDir, "index.ts"))).resolves.toBeDefined();
  });

  it("keeps hand-written files without listing them anywhere", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await writeByHand(join(outDir, "helpers.ts"));
    await writeByHand(join(outDir, "custom", "retry.ts"));

    await generateSdk({ input: fixture, output: outDir, clean: "generated" });

    await expect(stat(join(outDir, "helpers.ts"))).resolves.toBeDefined();
    await expect(stat(join(outDir, "custom", "retry.ts"))).resolves.toBeDefined();
    await expect(stat(join(outDir, "index.ts"))).resolves.toBeDefined();
  });

  it("keeps a hand-written file that sits beside a pruned generated one", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await writeGenerated(join(outDir, "legacy", "old-service.ts"));
    await writeByHand(join(outDir, "legacy", "notes.md"));

    await generateSdk({ input: fixture, output: outDir, clean: "generated" });

    // The generated sibling goes; the directory survives for the hand-written file.
    await expect(stat(join(outDir, "legacy", "old-service.ts"))).rejects.toThrow(/ENOENT/);
    await expect(stat(join(outDir, "legacy", "notes.md"))).resolves.toBeDefined();
  });

  it("drops directories left empty after pruning", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await writeGenerated(join(outDir, "dropped-input", "services", "gone.ts"));

    await generateSdk({ input: fixture, output: outDir, clean: "generated" });

    // The whole now-empty subtree is removed, not just the file.
    await expect(stat(join(outDir, "dropped-input"))).rejects.toThrow(/ENOENT/);
  });

  it("does not touch a file whose header was removed by the user", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    // Taking ownership by stripping the header opts a file out of pruning.
    await writeByHand(join(outDir, "services", "adopted.ts"));

    await generateSdk({ input: fixture, output: outDir, clean: "generated" });

    await expect(stat(join(outDir, "services", "adopted.ts"))).resolves.toBeDefined();
  });

  it("works on a fresh directory", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");

    await expect(
      generateSdk({ input: fixture, output: outDir, clean: "generated" })
    ).resolves.toBeDefined();
    await expect(stat(join(outDir, "index.ts"))).resolves.toBeDefined();
  });

  it("prunes a dropped input's subtree in multi-input mode", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await writeGenerated(join(outDir, "billing", "index.ts"));
    await writeByHand(join(outDir, "billing", "overrides.ts"));

    // `billing` is no longer configured; only `jira` is generated.
    await generateSdk({
      output: outDir,
      clean: "generated",
      inputs: { jira: { input: fixture } },
    });

    await expect(stat(join(outDir, "billing", "index.ts"))).rejects.toThrow(/ENOENT/);
    await expect(stat(join(outDir, "billing", "overrides.ts"))).resolves.toBeDefined();
    await expect(stat(join(outDir, "jira", "index.ts"))).resolves.toBeDefined();
  });

  it("regenerates emitted files unchanged", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await writeGenerated(join(outDir, "index.ts"));

    await generateSdk({ input: fixture, output: outDir, clean: "generated" });

    const { files } = await generateSdk({ input: fixture });
    const expected = files.find((f) => f.path === "index.ts")!.contents;
    expect(await readFile(join(outDir, "index.ts"), "utf8")).toBe(expected);
  });

  it("--clean generated prunes generated files and keeps hand-written ones", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await writeGenerated(join(outDir, "services", "gone.ts"));
    await writeByHand(join(outDir, "mine.ts"));

    const { io } = captureIo();
    expect(await runCli(["-i", fixture, "-o", outDir, "--clean", "generated"], io)).toBe(0);

    await expect(stat(join(outDir, "services", "gone.ts"))).rejects.toThrow(/ENOENT/);
    await expect(stat(join(outDir, "mine.ts"))).resolves.toBeDefined();
  });

  it("--clean none keeps everything", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await writeGenerated(join(outDir, "services", "gone.ts"));

    const { io } = captureIo();
    expect(await runCli(["-i", fixture, "-o", outDir, "--clean", "none"], io)).toBe(0);

    await expect(stat(join(outDir, "services", "gone.ts"))).resolves.toBeDefined();
  });

  it("--clean all empties the directory", async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await writeByHand(join(outDir, "mine.ts"));

    const { io } = captureIo();
    expect(await runCli(["-i", fixture, "-o", outDir, "--clean", "all"], io)).toBe(0);

    await expect(stat(join(outDir, "mine.ts"))).rejects.toThrow(/ENOENT/);
  });

  it("rejects an unknown --clean mode", async () => {
    const dir = await makeDir();
    const { io, err } = captureIo();
    expect(await runCli(["-i", fixture, "-o", join(dir, "sdk"), "--clean", "partial"], io)).toBe(1);
    expect(err.join("\n")).toMatch(/--clean must be one of "all", "generated", or "none"/);
  });

  it('honours `clean: "generated"` from the config file', async () => {
    const dir = await makeDir();
    const outDir = join(dir, "sdk");
    await writeGenerated(join(outDir, "services", "gone.ts"));
    await writeByHand(join(outDir, "mine.ts"));
    const cfg = join(dir, "sdk.config.json");
    await writeFile(cfg, JSON.stringify({ input: fixture, output: outDir, clean: "generated" }));

    const { io } = captureIo();
    expect(await runCli(["-c", cfg], io)).toBe(0);

    await expect(stat(join(outDir, "services", "gone.ts"))).rejects.toThrow(/ENOENT/);
    await expect(stat(join(outDir, "mine.ts"))).resolves.toBeDefined();
  });
});

describe('`header: false` with `clean: "generated"`', () => {
  // Pruning identifies generated files by their header, so the combination would
  // silently prune nothing. It is rejected before any spec is loaded.
  it("throws", async () => {
    await expect(
      generateSdk({ input: fixture, header: false, clean: "generated" })
    ).rejects.toThrow(/cannot be combined with `header: false`/);
  });

  it("throws even without an output directory", async () => {
    await expect(
      generateSdk({ input: fixture, header: false, clean: "generated" })
    ).rejects.toThrow(/`clean: "generated"`/);
  });

  it("allows `header: false` with the other clean modes", async () => {
    await expect(
      generateSdk({ input: fixture, header: false, clean: true })
    ).resolves.toBeDefined();
    await expect(
      generateSdk({ input: fixture, header: false, clean: false })
    ).resolves.toBeDefined();
    await expect(generateSdk({ input: fixture, header: false })).resolves.toBeDefined();
  });

  it('allows `clean: "generated"` with the header left on', async () => {
    await expect(
      generateSdk({ input: fixture, header: true, clean: "generated" })
    ).resolves.toBeDefined();
  });

  it("surfaces the conflict through the CLI", async () => {
    const dir = await mkdtemp(join(tmpdir(), "narthia-hdr-"));
    const { io, err } = captureIo();
    expect(
      await runCli(
        ["-i", fixture, "-o", join(dir, "sdk"), "--no-header", "--clean", "generated"],
        io
      )
    ).toBe(1);
    expect(err.join("\n")).toMatch(/cannot be combined with `header: false`/);
    await rm(dir, { recursive: true, force: true });
  });
});
