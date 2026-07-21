#!/usr/bin/env node
/* eslint-disable no-console -- this is a CLI; console is its output channel */
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
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

const HELP = `openapi-sdk-generator — generate a TypeScript SDK from an OpenAPI 3.0/3.1 spec

Usage:
  openapi-sdk-generator --input <path|url> --output <dir> [options]

Options:
  -i, --input <path|url>   OpenAPI 3.0/3.1 spec (JSON file path or http(s) URL)   [required]
  -o, --output <dir>       Directory to write the generated SDK into              [required]
  -n, --name <name>        Name of the generated SDK factory (default: createSdk)
      --runtime <pkg>      Runtime import specifier (default: @narthia/openapi-sdk-generator)
      --import-ext <ext>   Relative-import extension: "" | js | ts (default: "")
  -h, --help               Show this help
  -v, --version            Print the version

Examples:
  openapi-sdk-generator -i ./openapi.json -o ./src/sdk
  openapi-sdk-generator -i https://api.example.com/openapi.json -o ./sdk --import-ext js`;

/**
 * Run the CLI with an explicit argv (defaults to `process.argv` tail).
 * Returns the process exit code; never calls `process.exit` itself so it stays testable.
 */
export async function runCli(
  argv: string[] = process.argv.slice(2),
  io: CliIo = defaultIo
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

  try {
    const result = await generateSdk({
      input: values.input,
      output: values.output,
      name: values.name,
      runtimePackage: values.runtime,
      importExtension: importExtension as "" | "js" | "ts" | undefined,
    });

    for (const warning of result.warnings) io.err(`Warning: ${warning}`);
    io.out(`Generated ${result.files.length} file(s) into ${values.output}`);
    return 0;
  } catch (error) {
    io.err(`Error: ${(error as Error).message}`);
    return 1;
  }
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
