/**
 * Emits the generated SDK's `config.ts`: the SDK config type and a tailored
 * `createClient` that applies the configured auth (field renames + scheme
 * selection) before delegating to the runtime `createClient`.
 *
 * This module holds no service references, so importing `createClient` from it
 * stays tree-shakeable. Both `createSdk` (in `index.ts`) and the standalone
 * operation path use this same `createClient`, so auth behaves identically
 * whichever entry point you use.
 */
import type { EmitContext } from "./ts-writer.ts";
import {
  AUTH_ADAPTER_NAME,
  authConfigTypeName,
  authNeedsValueOrFactory,
  emitAuthAdapter,
  emitAuthConfigType,
} from "./emit-auth.ts";
import { GENERATED_HEADER } from "./emit-types.ts";
import { runtimeClientImport } from "./ts-writer.ts";

export function emitConfig(ctx: EmitContext): string {
  const clientImport = runtimeClientImport(ctx, "./client");
  const parts: string[] = [GENERATED_HEADER, ""];

  const typeImports = ["ClientConfig", "ClientContext", "Transport"];
  if (ctx.auth) {
    typeImports.push("AuthConfig");
    if (authNeedsValueOrFactory(ctx.auth)) typeImports.push("ValueOrFactory");
  }
  typeImports.sort();

  parts.push(`import { ApiError, createClient as createRuntimeClient } from "${clientImport}";`);
  parts.push(`import type { ${typeImports.join(", ")} } from "${clientImport}";`);
  parts.push("");
  // Re-export the runtime surface so `./config` is a complete entry point for
  // the standalone (tree-shakeable) path.
  parts.push("export { ApiError };");
  parts.push("export type { ClientConfig, ClientContext, Transport };");
  parts.push("");

  if (ctx.auth) {
    parts.push(...emitAuthConfigType(ctx.auth, ctx));
    parts.push("");
    parts.push(...emitAuthAdapter(ctx.auth, ctx));
    parts.push("");
    parts.push("/** Configuration for `createSdk` and `createClient`. */");
    parts.push(
      `export type SdkConfig = Omit<ClientConfig, "auth"> & { auth?: ${authConfigTypeName(ctx)} };`
    );
    parts.push("");
    parts.push("/** Create a client context that applies the configured auth. */");
    parts.push("export function createClient(config: SdkConfig = {}) {");
    parts.push("  const { auth, ...rest } = config;");
    parts.push(
      `  return createRuntimeClient(auth ? { ...rest, auth: ${AUTH_ADAPTER_NAME}(auth) } : rest);`
    );
    parts.push("}");
  } else {
    parts.push("/** Configuration for `createSdk` and `createClient`. */");
    parts.push("export type SdkConfig = ClientConfig;");
    parts.push("");
    parts.push("/** Create a client context for this SDK. */");
    parts.push("export function createClient(config: SdkConfig = {}) {");
    parts.push("  return createRuntimeClient(config);");
    parts.push("}");
  }

  return `${parts.join("\n")}\n`;
}
