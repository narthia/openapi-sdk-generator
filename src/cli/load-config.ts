/**
 * Discovery and loading of an `openapi-sdk.config.*` file for the CLI. JSON files
 * are read directly; `.js`/`.mjs`/`.cjs`/`.ts`/`.mts` are loaded with native
 * dynamic `import()` (no extra dependency). A `.ts` config relies on Node's
 * built-in type stripping (Node >=22.6), so `.mjs`/`.js`/`.json` are the portable
 * choices on older runtimes.
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { GenerateOptions } from "../generator/generate.ts";

/** Default config file names, in discovery order. */
export const CONFIG_BASENAMES = [
  "openapi-sdk.config.ts",
  "openapi-sdk.config.mts",
  "openapi-sdk.config.mjs",
  "openapi-sdk.config.js",
  "openapi-sdk.config.cjs",
  "openapi-sdk.config.json",
];

/**
 * Resolve the config file path: the `explicit` path when given (error if it does
 * not exist), otherwise the first {@link CONFIG_BASENAMES} entry found in `cwd`.
 * Returns an absolute path, or `undefined` when no config is present.
 */
export async function resolveConfigPath(
  explicit: string | undefined,
  cwd: string
): Promise<string | undefined> {
  if (explicit !== undefined) {
    const abs = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!(await fileExists(abs))) throw new Error(`Config file not found: ${explicit}`);
    return abs;
  }
  for (const name of CONFIG_BASENAMES) {
    const abs = resolve(cwd, name);
    if (await fileExists(abs)) return abs;
  }
  return undefined;
}

/** Load a config file and return its options object. */
export async function loadConfig(path: string): Promise<Partial<GenerateOptions>> {
  if (path.endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new Error(`Failed to parse config "${path}": ${(error as Error).message}`);
    }
    return asConfigObject(parsed, path);
  }

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
  } catch (error) {
    const message = (error as Error).message;
    if (path.endsWith(".ts") || path.endsWith(".mts")) {
      throw new Error(
        `Failed to load TypeScript config "${path}": ${message}. ` +
          "Running a .ts config needs Node >=22.6 (native type stripping); " +
          "otherwise use a .mjs, .js, or .json config."
      );
    }
    throw new Error(`Failed to load config "${path}": ${message}`);
  }
  const value = "default" in mod ? mod["default"] : mod;
  return asConfigObject(value, path);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function asConfigObject(value: unknown, path: string): Partial<GenerateOptions> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Config "${path}" must export an options object.`);
  }
  return value as Partial<GenerateOptions>;
}
