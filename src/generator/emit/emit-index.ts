import type { IrDocument, IrService } from "../ir.ts";
import type { EmitContext } from "./ts-writer.ts";
/** Emits the generated SDK's `index.ts`: the `createSdk` factory wiring all services. */
import { buildJsDoc } from "../jsdoc.ts";
import { serviceFactoryName, serviceProperty } from "./emit-service.ts";
import { GENERATED_HEADER } from "./emit-types.ts";
import { relativeImport } from "./ts-writer.ts";

export function emitIndex(doc: IrDocument, ctx: EmitContext, hasTypes: boolean): string {
  const parts: string[] = [GENERATED_HEADER, ""];

  parts.push(`import { createClient, type ClientConfig } from "${ctx.runtimePackage}/client";`);
  for (const service of doc.services) {
    parts.push(
      `import { ${serviceFactoryName(service)} } from "${relativeImport(
        ctx,
        `./services/${service.fileName}`
      )}";`
    );
  }
  parts.push("");
  if (hasTypes) parts.push(`export * from "${relativeImport(ctx, "./types", true)}";`);
  parts.push(`export { ApiError } from "${ctx.runtimePackage}/client";`);
  parts.push(
    `export type { ClientConfig, ClientContext, Transport } from "${ctx.runtimePackage}/client";`
  );
  parts.push("");

  const doc_ = buildJsDoc({
    summary: `Create a \`${doc.info.title}\` SDK client (API version ${doc.info.version}).`,
    description: doc.info.description,
    params: [{ name: "config", description: "Base URL, transport, auth, and default headers." }],
  });
  if (doc_) parts.push(doc_);
  parts.push(`export function ${ctx.sdkName}(config: ClientConfig = {}) {`);
  parts.push("  const ctx = createClient(config);");
  parts.push("  return {");
  for (const service of doc.services) {
    parts.push(...serviceEntry(service));
  }
  parts.push("  };");
  parts.push("}");
  parts.push("");
  parts.push(`export type ${sdkTypeName(ctx)} = ReturnType<typeof ${ctx.sdkName}>;`);
  return `${parts.join("\n")}\n`;
}

function serviceEntry(service: IrService): string[] {
  const lines: string[] = [];
  const doc = buildJsDoc({ summary: service.docs.description }, "    ");
  if (doc) lines.push(doc);
  lines.push(`    ${serviceProperty(service)}: ${serviceFactoryName(service)}(ctx),`);
  return lines;
}

function sdkTypeName(ctx: EmitContext): string {
  const name = ctx.sdkName;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}Client`;
}
