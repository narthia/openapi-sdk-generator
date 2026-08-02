/**
 * Emits the generated SDK's `transports/http.ts`: the SDK's HTTP transport
 * factory. When the SDK has auth, this is a spec-typed `http` (named-scheme auth
 * like `{ bearerAuth: token }`) that adapts to the runtime `AuthConfig` via
 * `toRuntimeAuth` and delegates to the package's generic `http`. Without auth, it
 * simply re-exports the generic `http`, so callers always import it from the same
 * `<sdk>/transports/http` path.
 */
import type { EmitContext } from "./ts-writer.ts";
import {
  AUTH_ADAPTER_NAME,
  authConfigTypeName,
  authNeedsValueOrFactory,
  emitAuthAdapter,
  emitAuthConfigType,
} from "./emit-auth.ts";
import { headerLines } from "./emit-types.ts";
import { clientBase, runtimeClientImport, runtimeTransportImport } from "./ts-writer.ts";

export function emitTransportHttp(ctx: EmitContext): string {
  const genericImport = runtimeTransportImport(ctx, "http");
  const parts: string[] = headerLines(ctx);

  // The wrapper sits one level below the SDK root (`transports/`), so it reaches
  // the client one level deeper than `config.ts`/`index.ts`.
  const clientImport = runtimeClientImport(ctx, clientBase(ctx.subdirDepth + 1));

  if (!ctx.auth) {
    parts.push(`export { http } from "${genericImport}";`);
    parts.push(`export type { HttpOptions } from "${genericImport}";`);
    return `${parts.join("\n")}\n`;
  }

  const typeImports = ["AuthConfig", "Transport"];
  if (authNeedsValueOrFactory(ctx.auth)) typeImports.push("ValueOrFactory");
  typeImports.sort();

  const authType = authConfigTypeName(ctx);

  parts.push(`import { http as httpTransport } from "${genericImport}";`);
  parts.push(`import type { ${typeImports.join(", ")} } from "${clientImport}";`);
  parts.push("");
  parts.push(...emitAuthConfigType(ctx.auth, ctx));
  parts.push("");
  parts.push(...emitAuthAdapter(ctx.auth, ctx));
  parts.push("");
  parts.push(`/** Options for this SDK's {@link http} transport. */`);
  parts.push("export interface HttpOptions {");
  parts.push("  /** Base URL requests are resolved against, e.g. `https://api.example.com/v2`. */");
  parts.push("  baseUrl: string;");
  parts.push(`  /** Authentication applied to every request. */`);
  parts.push(`  auth?: ${authType};`);
  parts.push("  /** Custom fetch implementation (polyfill, mock, or instrumented). */");
  parts.push("  fetch?: typeof globalThis.fetch;");
  parts.push(
    "  /** Extra fetch options merged into every request (e.g. `cache`, `credentials`). */"
  );
  parts.push('  fetchOptions?: Omit<RequestInit, "method" | "headers" | "body" | "signal">;');
  parts.push("}");
  parts.push("");
  parts.push("/** HTTP transport for this SDK, with typed auth. */");
  parts.push("export function http(options: HttpOptions): Transport {");
  parts.push("  const { auth, ...rest } = options;");
  parts.push(
    `  return httpTransport({ ...rest, auth: auth ? ${AUTH_ADAPTER_NAME}(auth) : undefined });`
  );
  parts.push("}");

  return `${parts.join("\n")}\n`;
}
