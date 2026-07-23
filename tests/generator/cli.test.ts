import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CliIo } from "../../src/cli/index.ts";
import { runCli } from "../../src/cli/index.ts";

const fixture = fileURLToPath(new URL("../fixtures/petstore-3.0.json", import.meta.url));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (m) => out.push(m), err: (m) => err.push(m) }, out, err };
}

describe("runCli", () => {
  const tmpDirs: string[] = [];
  const makeOut = async () => {
    const dir = await mkdtemp(join(tmpdir(), "narthia-cli-"));
    tmpDirs.push(dir);
    return join(dir, "sdk");
  };

  afterEach(async () => {
    await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("prints help and exits 0", async () => {
    const { io, out } = captureIo();
    expect(await runCli(["--help"], io)).toBe(0);
    expect(out.join("\n")).toContain("Usage:");
  });

  it("prints the version and exits 0", async () => {
    const { io, out } = captureIo();
    expect(await runCli(["--version"], io)).toBe(0);
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("requires input and output", async () => {
    const { io, err } = captureIo();
    expect(await runCli([], io)).toBe(1);
    expect(err.join("\n")).toContain("both --input and --output are required");
  });

  it("rejects invalid --import-ext", async () => {
    const { io, err } = captureIo();
    const out = await makeOut();
    expect(await runCli(["-i", fixture, "-o", out, "--import-ext", "mjs"], io)).toBe(1);
    expect(err.join("\n")).toContain("--import-ext must be one of");
  });

  it("rejects unknown flags", async () => {
    const { io, err } = captureIo();
    expect(await runCli(["--nope"], io)).toBe(1);
    expect(err.join("\n")).toContain("--help");
  });

  it("generates files to disk and reports the count", async () => {
    const { io, out } = captureIo();
    const outDir = await makeOut();
    expect(await runCli(["-i", fixture, "-o", outDir, "-n", "createPetstore"], io)).toBe(0);
    expect(out.join("\n")).toMatch(/Generated \d+ file\(s\) into/);

    await expect(stat(join(outDir, "index.ts"))).resolves.toBeDefined();
    const index = await readFile(join(outDir, "index.ts"), "utf8");
    expect(index).toContain("export function createPetstore");
  });

  it("reports generation errors and exits 1", async () => {
    const { io, err } = captureIo();
    const outDir = await makeOut();
    expect(await runCli(["-i", "/no/such/spec.json", "-o", outDir], io)).toBe(1);
    expect(err.join("\n")).toContain("Failed to read OpenAPI spec file");
  });
});
