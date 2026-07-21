import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EmitContext } from "./emit/ts-writer.ts";
import type { SpecInput } from "./load.ts";
import { detectVersion } from "./detect.ts";
import { emitIndex } from "./emit/emit-index.ts";
import { emitService } from "./emit/emit-service.ts";
import { emitTypesFolder, partitionSchemas } from "./emit/emit-types.ts";
import { buildIr } from "./ir.ts";
import { loadSpec } from "./load.ts";

/** Options for {@link generateSdk}. */
export interface GenerateOptions {
  /** OpenAPI 3.0/3.1 spec: a file path, an http(s) URL, or an in-memory object. */
  input: SpecInput;
  /** Output directory. When omitted, files are only returned in memory. */
  output?: string;
  /**
   * Name of the generated SDK factory function.
   * @default "createSdk"
   */
  name?: string;
  /**
   * Import specifier for the runtime package in generated code.
   * @default "@narthia/openapi-sdk-generator"
   */
  runtimePackage?: string;
  /**
   * Extension appended to relative imports in emitted code: `""` (extensionless,
   * bundler-friendly), `"js"` (strict `nodenext` consumers), or `"ts"`.
   * @default ""
   */
  importExtension?: "" | "js" | "ts";
}

export interface GeneratedFile {
  /** Path relative to the output directory, e.g. `types/common.ts`. */
  path: string;
  contents: string;
}

export interface GenerateResult {
  files: GeneratedFile[];
  /** Non-fatal warnings (naming collisions, skipped params, ...). */
  warnings: string[];
}

/**
 * Generate a fully typed, JSDoc-documented TypeScript SDK from an OpenAPI
 * 3.0/3.1 document.
 *
 * @example
 * ```ts
 * import { generateSdk } from "@narthia/openapi-sdk-generator";
 *
 * await generateSdk({
 *   input: "https://api.example.com/openapi.json",
 *   output: "./src/sdk",
 * });
 * ```
 */
export async function generateSdk(options: GenerateOptions): Promise<GenerateResult> {
  const spec = await loadSpec(options.input);
  const mode = detectVersion(spec);
  const ir = buildIr(spec, mode);

  const ctx: EmitContext = {
    runtimePackage: options.runtimePackage ?? "@narthia/openapi-sdk-generator",
    importExtension: options.importExtension ?? "",
    sdkName: options.name ?? "createSdk",
  };

  const partition = partitionSchemas(ir);
  const files: GeneratedFile[] = [];

  const typeFiles =
    ir.schemas.length > 0 ? emitTypesFolder(ir, partition, ctx) : new Map<string, string>();
  for (const [path, contents] of typeFiles) {
    files.push({ path, contents });
  }
  for (const service of ir.services) {
    files.push({
      path: `services/${service.fileName}.ts`,
      contents: emitService(service, ctx),
    });
  }
  files.push({ path: "index.ts", contents: emitIndex(ir, ctx, typeFiles.size > 0) });

  if (options.output !== undefined) {
    for (const file of files) {
      const target = join(options.output, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, "utf8");
    }
  }

  return { files, warnings: ir.warnings };
}
