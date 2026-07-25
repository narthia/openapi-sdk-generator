/**
 * Emits the runtime (client core + selected transports) into the generated SDK
 * for `runtime: "generate"` mode, producing a self-contained output with no
 * dependency on this package.
 *
 * The real runtime source (`src/client/*`, `src/transports/*`) is the single
 * source of truth: it is read at generate time and its relative imports are
 * rewritten for the generated layout (`client/*`, `transport/*.ts`) and the
 * configured `importExtension`. The package ships those source dirs (see
 * `files` in package.json) so the built CLI can read them.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EmitContext, TransportName } from "./ts-writer.ts";
import { headerLines } from "./emit-types.ts";
import { defaultTransport } from "./ts-writer.ts";

/** Client-core files copied verbatim (with import rewrites) into `sdk/client/`. */
const CLIENT_FILES = ["index.ts", "client.ts", "errors.ts", "serialize.ts", "types.ts"];

const RUNTIME_ROOT = findRuntimeRoot();

/**
 * Build the generated runtime files. Returns a map of output path → contents,
 * e.g. `client/client.ts`, `transport/http.ts`.
 */
export function emitRuntime(ctx: EmitContext): Map<string, string> {
  const files = new Map<string, string>();

  for (const name of CLIENT_FILES) {
    const src = readFileSync(join(RUNTIME_ROOT, "client", name), "utf8");
    files.set(`client/${name}`, withHeader(rewriteImports(src, ctx), ctx));
  }

  for (const transport of ctx.transports) {
    const src = readFileSync(join(RUNTIME_ROOT, "transports", transport, "index.ts"), "utf8");
    files.set(`transport/${transport}.ts`, withHeader(rewriteImports(src, ctx), ctx));
  }

  return files;
}

/** Rewrite the runtime's relative imports for the generated `client/` + `transport/` layout. */
function rewriteImports(src: string, ctx: EmitContext): string {
  const transport: TransportName = defaultTransport(ctx);
  let out = src
    // client.ts default transport import: `../transports/http/index.ts` → `../transport/http`
    .replaceAll(`../transports/${transport}/index.ts`, `../transport/${transport}`)
    // transport files reference the client types across the folder boundary.
    .replaceAll("../../client/types.ts", "../client/types");

  // Drop the `.ts` extension from the remaining relative (sibling) imports.
  out = out.replace(/from "(\.[^"]+)\.ts"/g, 'from "$1"');

  // Re-apply the configured extension to every relative specifier.
  if (ctx.importExtension !== "") {
    out = out.replace(/from "(\.[^"]+)"/g, (_match, spec: string) => {
      return `from "${spec}.${ctx.importExtension}"`;
    });
  }
  return out;
}

function withHeader(contents: string, ctx: EmitContext): string {
  return [...headerLines(ctx), contents].join("\n");
}

/** Locate the package's `src` dir (which holds the runtime source), walking up from this module. */
function findRuntimeRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "package.json"))) return join(dir, "src");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'Could not locate the runtime source for `runtime: "generate"`. ' +
      'Ensure the package\'s src/client and src/transports are installed, or use `runtime: "package"`.'
  );
}
