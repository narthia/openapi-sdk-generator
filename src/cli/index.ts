#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; console is its output channel */
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import type { AuthOption } from "../generator/generate.ts";
import { generateSdk } from "../generator/generate.ts";

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
  -i, --input <path|url>   OpenAPI 3.0/3.1 spec (JSON file path or http(s) URL)   [required]
  -o, --output <dir>       Directory to write the generated SDK into              [required]
  -n, --name <name>        Name of the generated SDK factory (default: createSdk)
      --runtime <pkg>      Runtime import specifier (default: @narthia/openapi-sdk-generator)
      --import-ext <ext>   Relative-import extension: "" | js | ts (default: "")
      --collision-case <c> Case for renamed colliding path/query params: snake_case | camelCase (default: snake_case)
  -h, --help               Show this help
  -v, --version            Print the version

Auth (when omitted, schemes are derived from the spec's securitySchemes):
      --auth-type <list>   Comma-separated auth schemes: bearer, basic, apiKey
      --basic-username-field <name>  Rename basic auth's username field (default: username)
      --basic-password-field <name>  Rename basic auth's password field (default: password)
      --bearer-field <name>          Rename the bearer token field (default: token)
      --apikey-field <name>          Rename the apiKey value field (default: value)
      --apikey-in <where>            apiKey location: header | query (default: header)
      --apikey-name <name>           apiKey header/query parameter name (required for apiKey)

Examples:
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
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        input: { type: "string", short: "i" },
        output: { type: "string", short: "o" },
        name: { type: "string", short: "n" },
        runtime: { type: "string" },
        "import-ext": { type: "string" },
        "collision-case": { type: "string" },
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

  if (!values.input || !values.output) {
    io.err("Error: both --input and --output are required.");
    io.err('Run "openapi-sdk-generator --help" for usage.');
    return 1;
  }

  const importExtension = values["import-ext"];
  if (importExtension !== undefined && !["", "js", "ts"].includes(importExtension)) {
    io.err(`Error: --import-ext must be one of "", "js", or "ts" (got "${importExtension}").`);
    return 1;
  }

  const collisionCase = values["collision-case"];
  if (collisionCase !== undefined && !["snake_case", "camelCase"].includes(collisionCase)) {
    io.err(
      `Error: --collision-case must be one of "snake_case" or "camelCase" (got "${collisionCase}").`,
    );
    return 1;
  }

  const authResult = buildAuthOption(values);
  if (authResult.error) {
    io.err(`Error: ${authResult.error}`);
    return 1;
  }

  try {
    const result = await generateSdk({
      input: values.input,
      output: values.output,
      name: values.name,
      runtimePackage: values.runtime,
      importExtension: importExtension as "" | "js" | "ts" | undefined,
      collisionCase: collisionCase as "snake_case" | "camelCase" | undefined,
      auth: authResult.auth,
    });

    for (const warning of result.warnings) io.err(`Warning: ${warning}`);
    io.out(`Generated ${result.files.length} file(s) into ${values.output}`);
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
    },
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
