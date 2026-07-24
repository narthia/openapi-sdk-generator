import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CliIo } from "../../src/cli/index.ts";
import { buildAuthOption, runCli } from "../../src/cli/index.ts";

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

  it("rejects invalid --collision-case", async () => {
    const { io, err } = captureIo();
    const out = await makeOut();
    expect(await runCli(["-i", fixture, "-o", out, "--collision-case", "kebab-case"], io)).toBe(1);
    expect(err.join("\n")).toContain("--collision-case must be one of");
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

  it("generates renamed basic auth via flags", async () => {
    const { io } = captureIo();
    const outDir = await makeOut();
    expect(
      await runCli(
        [
          "-i",
          fixture,
          "-o",
          outDir,
          "--auth-type",
          "basic",
          "--basic-username-field",
          "email",
          "--basic-password-field",
          "apitoken",
        ],
        io
      )
    ).toBe(0);
    const index = await readFile(join(outDir, "index.ts"), "utf8");
    expect(index).toContain("email: string;");
    expect(index).toContain("apitoken: string;");
  });
});

describe("buildAuthOption", () => {
  it("returns undefined auth when --auth-type is absent", () => {
    expect(buildAuthOption({})).toEqual({ auth: undefined });
  });

  it("builds a multi-scheme map option (case-insensitive types)", () => {
    const result = buildAuthOption({
      "auth-type": "bearer, apiKey",
      "apikey-name": "X-API-Key",
      "apikey-in": "header",
      "bearer-field": "accessToken",
    });
    expect(result.auth).toEqual({
      bearer: { field: "accessToken" },
      apiKey: { in: "header", name: "X-API-Key", field: undefined },
    });
  });

  it("errors when apiKey has no name", () => {
    expect(buildAuthOption({ "auth-type": "apiKey" }).error).toContain("--apikey-name is required");
  });

  it("errors on an unknown auth type", () => {
    expect(buildAuthOption({ "auth-type": "oauth" }).error).toContain(
      'must be "bearer", "basic", or "apiKey"'
    );
  });
});
