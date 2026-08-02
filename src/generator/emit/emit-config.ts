/**
 * Emits the generated SDK's `config.ts`: the SDK config type (`SdkConfig`) and a
 * thin `createClient` that delegates to the runtime `createClient`.
 *
 * This module holds no service references, so importing `createClient` from it
 * stays tree-shakeable. Both `createSdk` (in `index.ts`) and the standalone
 * operation path use this same `createClient`. Backend concerns (`baseUrl`, auth)
 * live on the transport, so this config carries only cross-cutting options.
 */
import type { EmitContext } from "./ts-writer.ts";
import { headerLines } from "./emit-types.ts";
import { clientBase, runtimeClientImport } from "./ts-writer.ts";

export function emitConfig(ctx: EmitContext): string {
  const clientImport = runtimeClientImport(ctx, clientBase(ctx.subdirDepth));
  const parts: string[] = headerLines(ctx);

  parts.push(`import { ApiError, createClient as createRuntimeClient } from "${clientImport}";`);
  parts.push(`import type { ClientConfig, ClientContext, Transport } from "${clientImport}";`);
  parts.push("");
  // Re-export the runtime surface so `./config` is a complete entry point for
  // the standalone (tree-shakeable) path.
  parts.push("export { ApiError };");
  parts.push("export type { ClientConfig, ClientContext, Transport };");
  parts.push("");
  parts.push("/** Configuration for `createSdk` and `createClient`. */");
  parts.push("export type SdkConfig = ClientConfig;");
  parts.push("");
  parts.push("/** Create a client context for this SDK. */");
  parts.push("export function createClient(config: SdkConfig) {");
  parts.push("  return createRuntimeClient(config);");
  parts.push("}");

  return `${parts.join("\n")}\n`;
}
