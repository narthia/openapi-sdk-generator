/**
 * Emits the generated SDK's `transports/forge.ts`: a thin, product-bound wrapper
 * over the package's Forge transport. The generator can't infer the Atlassian
 * product from an arbitrary OpenAPI spec, so the product is chosen at generate
 * time (`transports.forge.product`) and baked into the wrapper, alongside a
 * default identity (`as`). The caller then imports a single `forge` factory from
 * `<sdk>/transports/forge` - parallel to `<sdk>/transports/http`.
 *
 * Unlike `http`, the Forge transport is never inlined: it depends on the
 * `@forge/api` peer dependency, so the wrapper imports it from the package
 * subpath in both `"generate"` and `"package"` runtime modes.
 */
import type { EmitContext, ForgeProduct } from "./ts-writer.ts";
import { headerLines } from "./emit-types.ts";
import { clientBase, runtimeClientImport } from "./ts-writer.ts";

/** Package factory that builds the transport for each Forge product. */
const PRODUCT_FACTORY: Record<ForgeProduct, string> = {
  jira: "forgeJira",
  confluence: "forgeConfluence",
  bitbucket: "forgeBitbucket",
};

export function emitTransportForge(ctx: EmitContext): string {
  const forge = ctx.forge!;
  const factory = PRODUCT_FACTORY[forge.product];
  const forgeImport = `${ctx.runtimePackage}/transports/forge`;
  // The wrapper sits one level below the SDK root (`transports/`), so it reaches
  // the client one level deeper than `config.ts`/`index.ts`.
  const clientImport = runtimeClientImport(ctx, clientBase(ctx.subdirDepth + 1));

  const parts: string[] = headerLines(ctx);
  parts.push(`import { ${factory} } from "${forgeImport}";`);
  parts.push(`import type { ForgeTransportOptions } from "${forgeImport}";`);
  parts.push(`import type { Transport } from "${clientImport}";`);
  parts.push("");
  parts.push(`/** Options for this SDK's {@link forge} transport. */`);
  parts.push("export interface ForgeOptions extends ForgeTransportOptions {}");
  parts.push("");
  parts.push(
    `/** Atlassian Forge transport for this SDK (product: \`${forge.product}\`, default identity: \`${forge.as}\`). */`
  );
  parts.push("export function forge(options: ForgeOptions = {}): Transport {");
  parts.push(`  return ${factory}({ as: options.as ?? ${JSON.stringify(forge.as)} });`);
  parts.push("}");
  parts.push("");
  parts.push(`export { forgeAs } from "${forgeImport}";`);
  parts.push(`export type { ForgeAuthContext, ForgeCallOptions } from "${forgeImport}";`);

  return `${parts.join("\n")}\n`;
}
