#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; console is its output channel */
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import type { AuthOption, GenerateOptions } from "../generator/generate.ts";
import type { RuntimeMode, TransportName } from "./../generator/emit/ts-writer.ts";
import { generateSdk } from "../generator/generate.ts";
import { loadConfig, resolveConfigPath } from "./load-config.ts";

/** Minimal console surface so tests can capture output without touching globals. */
export interface CliIo {
  out: (message: string) => void;
  err: (message: string) => void;
}

const defaultIo: CliIo = {
  out: (message) => console.log(message),
  err: (message) => console.error(message),
};

const HELP = `openapi-sdk-generator - generate a TypeScript SDK from an OpenAPI 3.0/3.1 spec

Usage:
  openapi-sdk-generator --input <path|url> --output <dir> [options]

Options:
  -i, --input <path|url>   OpenAPI 3.0/3.1 spec (JSON file path or http(s) URL)   [required*]
  -o, --output <dir>       Directory to write the generated SDK into              [required*]
  -c, --config <path>      Config file (default: auto-discover openapi-sdk.config.{ts,mjs,js,json})
  -n, --name <name>        Name of the generated SDK factory (default: createSdk)
      --runtime <pkg>      Runtime import specifier (default: @narthia/openapi-sdk-generator)
      --import-ext <ext>   Relative-import extension: "" | js | ts (default: "")
      --collision-case <c> Case for renamed colliding path/query params: snake_case | camelCase (default: snake_case)
      --runtime-mode <m>   Where the runtime lives: generate (into the SDK) | package (default: generate)
      --transports <list>  Comma-separated transports to generate (default: http); first is the default
      --no-clean           Keep existing files in the output dir (default: the dir is emptied first)
  -h, --help               Show this help
  -v, --version            Print the version

  * input and output may come from a config file instead of flags; flags override the config.

Auth (when omitted, schemes are derived from the spec's securitySchemes):
      --auth-type <list>   Comma-separated auth schemes: bearer, basic, apiKey
      --basic-username-field <name>  Rename basic auth's username field (default: username)
      --basic-password-field <name>  Rename basic auth's password field (default: password)
      --bearer-field <name>          Rename the bearer token field (default: token)
      --apikey-field <name>          Rename the apiKey value field (default: value)
      --apikey-in <where>            apiKey location: header | query (default: header)
      --apikey-name <name>           apiKey header/query parameter name (required for apiKey)

Examples:
  openapi-sdk-generator                       # uses ./openapi-sdk.config.ts (or .mjs/.js/.json)
  openapi-sdk-generator -c ./sdk.config.ts
  openapi-sdk-generator -i ./openapi.json -o ./src/sdk
  openapi-sdk-generator -i https://api.example.com/openapi.json -o ./sdk --import-ext js
  openapi-sdk-generator -i ./openapi.json -o ./sdk --auth-type basic --basic-username-field email --basic-password-field apitoken
  openapi-sdk-generator -i ./openapi.json -o ./sdk --auth-type bearer,apiKey --apikey-in header --apikey-name X-API-Key`;

/**
 * Run the CLI with an explicit argv (defaults to `process.argv` tail).
 * Returns the process exit code; never calls `process.exit` itself so it stays testable.
 */
export async function runCli(
  argv: string[] = process.argv.slice(2),
  io: CliIo = defaultIo,
  cwd: string = process.cwd()
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        input: { type: "string", short: "i" },
        output: { type: "string", short: "o" },
        config: { type: "string", short: "c" },
        name: { type: "string", short: "n" },
        runtime: { type: "string" },
        "import-ext": { type: "string" },
        "collision-case": { type: "string" },
        "runtime-mode": { type: "string" },
        transports: { type: "string" },
        "no-clean": { type: "boolean" },
        "auth-type": { type: "string" },
        "basic-username-field": { type: "string" },
        "basic-password-field": { type: "string" },
        "bearer-field": { type: "string" },
        "apikey-field": { type: "string" },
        "apikey-in": { type: "string" },
        "apikey-name": { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    }));
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    io.err('Run "openapi-sdk-generator --help" for usage.');
    return 1;
  }

  if (values.help) {
    io.out(HELP);
    return 0;
  }
  if (values.version) {
    io.out(readVersion());
    return 0;
  }

  const importExtension = values["import-ext"];
  if (importExtension !== undefined && !["", "js", "ts"].includes(importExtension)) {
    io.err(`Error: --import-ext must be one of "", "js", or "ts" (got "${importExtension}").`);
    return 1;
  }

  const collisionCase = values["collision-case"];
  if (collisionCase !== undefined && !["snake_case", "camelCase"].includes(collisionCase)) {
    io.err(
      `Error: --collision-case must be one of "snake_case" or "camelCase" (got "${collisionCase}").`
    );
    return 1;
  }

  const runtimeMode = values["runtime-mode"];
  if (runtimeMode !== undefined && runtimeMode !== "package" && runtimeMode !== "generate") {
    io.err(`Error: --runtime-mode must be one of "package" or "generate" (got "${runtimeMode}").`);
    return 1;
  }

  const transportsFlag = values.transports;
  const transports = transportsFlag
    ? transportsFlag
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  const authResult = buildAuthOption(values);
  if (authResult.error) {
    io.err(`Error: ${authResult.error}`);
    return 1;
  }

  let fileConfig: Partial<GenerateOptions> = {};
  try {
    const configPath = await resolveConfigPath(values.config, cwd);
    if (configPath) fileConfig = await loadConfig(configPath);
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    return 1;
  }

  // Shared options: CLI flags override the config file.
  const output = values.output ?? fileConfig.output;
  const shared = {
    output,
    runtimePackage: values.runtime ?? fileConfig.runtimePackage,
    importExtension:
      (importExtension as "" | "js" | "ts" | undefined) ?? fileConfig.importExtension,
    runtime: (runtimeMode as RuntimeMode | undefined) ?? fileConfig.runtime,
    transports: (transports as TransportName[] | undefined) ?? fileConfig.transports,
    // `--no-clean` is the only direction a flag can express here; without it the
    // config file decides (and `generateSdk` defaults to cleaning).
    clean: values["no-clean"] ? false : fileConfig.clean,
  };

  // Multi-input is config-file only: per-input auth/name/collisionCase come from
  // the config; shared flags above still override. CLI flags for a single input
  // (--input, --auth-*, --name, --collision-case) don't apply here.
  const multiInputs =
    fileConfig.inputs && Object.keys(fileConfig.inputs).length > 0 ? fileConfig.inputs : undefined;

  let generateOptions: GenerateOptions;
  if (multiInputs) {
    if (output === undefined) {
      io.err("Error: output is required (via --output or the config file).");
      io.err('Run "openapi-sdk-generator --help" for usage.');
      return 1;
    }
    generateOptions = { ...shared, inputs: multiInputs };
  } else {
    const input = values.input ?? fileConfig.input;
    if (input === undefined || output === undefined) {
      io.err("Error: both input and output are required (via --input/--output or a config file).");
      io.err('Run "openapi-sdk-generator --help" for usage.');
      return 1;
    }
    generateOptions = {
      ...shared,
      input,
      name: values.name ?? fileConfig.name,
      collisionCase:
        (collisionCase as "snake_case" | "camelCase" | undefined) ?? fileConfig.collisionCase,
      auth: authResult.auth ?? fileConfig.auth,
    };
  }

  try {
    const result = await generateSdk(generateOptions);
    for (const warning of result.warnings) io.err(`Warning: ${warning}`);
    io.out(`Generated ${result.files.length} file(s) into ${output}`);
    return 0;
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
}

/** CLI flag values relevant to auth, as parsed by `parseArgs`. */
type AuthFlags = Record<string, string | boolean | undefined>;

/**
 * Build an {@link AuthOption} from CLI flags. Returns `{ auth: undefined }` when
 * no `--auth-type` is given (so spec-derived schemes apply), or `{ error }` on
 * invalid input. The flags allow at most one scheme per type; the programmatic
 * `generateSdk` API is the same in that regard.
 */
export function buildAuthOption(values: AuthFlags): { auth?: AuthOption; error?: string } {
  const authType = values["auth-type"];
  if (typeof authType !== "string" || authType.trim() === "") return { auth: undefined };

  const apiKeyIn = values["apikey-in"];
  if (apiKeyIn !== undefined && apiKeyIn !== "header" && apiKeyIn !== "query") {
    return { error: `--apikey-in must be one of "header" or "query" (got "${String(apiKeyIn)}").` };
  }

  const auth: AuthOption = {};
  for (const raw of authType
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)) {
    const type = raw.toLowerCase();
    if (type === "bearer") {
      auth.bearer = { field: str(values["bearer-field"]) };
    } else if (type === "basic") {
      auth.basic = {
        usernameField: str(values["basic-username-field"]),
        passwordField: str(values["basic-password-field"]),
      };
    } else if (type === "apikey") {
      const name = str(values["apikey-name"]);
      if (!name) return { error: "--apikey-name is required when --auth-type includes apiKey." };
      auth.apiKey = {
        in: (apiKeyIn as "header" | "query" | undefined) ?? "header",
        name,
        field: str(values["apikey-field"]),
      };
    } else {
      return { error: `--auth-type values must be "bearer", "basic", or "apiKey" (got "${raw}").` };
    }
  }

  if (!auth.basic && !auth.bearer && !auth.apiKey) return { auth: undefined };
  return { auth };
}

/** Coerce a parsed flag value to a defined string, or `undefined`. */
function str(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Run when invoked as a binary (not when imported by tests).
if (isMainModule()) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`Error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  );
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const href = import.meta.url;
  return (
    href === `file://${entry}` || href.endsWith("/cli/index.mjs") || href.endsWith("/cli/index.ts")
  );
}
