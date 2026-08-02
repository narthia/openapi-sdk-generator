import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliIo } from "../../src/cli/index.ts";
import type * as GenerateModule from "../../src/generator/generate.ts";
import type {
  GenerateOptions,
  GenerateResult,
  SharedOptions,
} from "../../src/generator/generate.ts";
import { runCli } from "../../src/cli/index.ts";

// `runCli` builds its options object from an explicit allow-list rather than
// spreading the config file, so a shared option is silently dropped if it is not
// listed there. Intercept `generateSdk` to assert on exactly what the CLI passes.
const { calls } = vi.hoisted(() => ({ calls: [] as GenerateOptions[] }));

vi.mock("../../src/generator/generate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof GenerateModule>();
  return {
    ...actual,
    generateSdk: vi.fn<(options: GenerateOptions) => Promise<GenerateResult>>((options) => {
      calls.push(options);
      return Promise.resolve({ files: [], warnings: [] });
    }),
  };
});

const fixture = fileURLToPath(new URL("../fixtures/petstore-3.0.json", import.meta.url));

function captureIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (m) => out.push(m), err: (m) => err.push(m) }, out, err };
}

/**
 * A non-default value for every shared option. Typing this as
 * `Record<keyof SharedOptions, unknown>` makes it a **type error** to add a field
 * to `SharedOptions` without covering it here, which is the point: the CLI's
 * allow-list is hand-maintained and TypeScript cannot otherwise catch an
 * omitted optional field.
 */
const sharedCases = (outDir: string): Record<keyof SharedOptions, unknown> => ({
  output: outDir,
  clean: false,
  header: false,
  normalizeVersion: true,
  runtimePackage: "my-runtime",
  importExtension: "js",
  runtime: "package",
  // A non-default transports map (forge is never the default) so a dropped key
  // fails the assertion below (`undefined` vs the object).
  transports: { forge: { product: "jira" } },
});

describe("CLI option forwarding", () => {
  const dirs: string[] = [];
  const makeDir = async () => {
    const dir = await mkdtemp(join(tmpdir(), "narthia-fwd-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(async () => {
    calls.length = 0;
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("forwards every shared option from a config file", async () => {
    const dir = await makeDir();
    const expected = sharedCases(join(dir, "sdk"));
    const cfg = join(dir, "sdk.config.json");
    await writeFile(cfg, JSON.stringify({ input: fixture, ...expected }));

    const { io } = captureIo();
    expect(await runCli(["-c", cfg], io)).toBe(0);

    expect(calls).toHaveLength(1);
    const received = calls[0] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(
        received[key],
        `shared option \`${key}\` was not forwarded from the config file to generateSdk`
      ).toEqual(value);
    }
  });

  it("forwards every shared option from a config file in multi-input mode", async () => {
    const dir = await makeDir();
    const expected = sharedCases(join(dir, "sdk"));
    const cfg = join(dir, "sdk.config.json");
    await writeFile(cfg, JSON.stringify({ inputs: { catalog: { input: fixture } }, ...expected }));

    const { io } = captureIo();
    expect(await runCli(["-c", cfg], io)).toBe(0);

    expect(calls).toHaveLength(1);
    const received = calls[0] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(
        received[key],
        `shared option \`${key}\` was not forwarded in multi-input mode`
      ).toEqual(value);
    }
  });

  it("forwards every per-target option from a config file", async () => {
    const dir = await makeDir();
    const cfg = join(dir, "sdk.config.json");
    const expected = {
      input: fixture,
      name: "createFromConfig",
      collisionCase: "camelCase",
      transports: { http: { auth: { bearer: { field: "apiToken" } } } },
    };
    await writeFile(cfg, JSON.stringify({ output: join(dir, "sdk"), ...expected }));

    const { io } = captureIo();
    expect(await runCli(["-c", cfg], io)).toBe(0);

    const received = calls[0] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) {
      expect(received[key], `per-target option \`${key}\` was not forwarded`).toEqual(value);
    }
  });
});
