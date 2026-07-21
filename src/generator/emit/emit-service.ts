import type { IrOperation, IrParam, IrService } from "../ir.ts";
import type { EmitContext } from "./ts-writer.ts";
import { collectRefs } from "../ir.ts";
/** Emits one `services/<name>.ts` file per service: a factory returning JSDoc'd methods. */
import { buildJsDoc } from "../jsdoc.ts";
import { propertyKey } from "../names.ts";
import { GENERATED_HEADER, operationTypes } from "./emit-types.ts";
import { printProperty, printType, relativeImport } from "./ts-writer.ts";

export function emitService(service: IrService, ctx: EmitContext): string {
  const usedTypes = new Set<string>();
  for (const op of service.operations) {
    for (const type of operationTypes(op)) collectRefs(type, usedTypes);
  }

  const parts: string[] = [GENERATED_HEADER, ""];
  parts.push(`import type { ClientContext } from "${ctx.runtimePackage}/client";`);
  if (usedTypes.size > 0) {
    const names = [...usedTypes].sort().join(", ");
    parts.push(`import type { ${names} } from "${relativeImport(ctx, "../types", true)}";`);
  }
  parts.push("");

  const factoryDoc = buildJsDoc({
    summary: service.docs.description ?? `Operations of the \`${service.name}\` service.`,
  });
  if (factoryDoc) parts.push(factoryDoc);
  parts.push(`export function create${service.pascalName}Service(ctx: ClientContext) {`);
  parts.push("  return {");
  for (const op of service.operations) {
    parts.push(emitOperation(op), "");
  }
  if (parts[parts.length - 1] === "") parts.pop();
  parts.push("  };");
  parts.push("}");
  return `${parts.join("\n")}\n`;
}

function emitOperation(op: IrOperation): string {
  const indent = "    ";
  const lines: string[] = [];

  const doc = buildJsDoc(
    {
      summary: op.docs.summary,
      description: op.docs.description,
      params: paramDocs(op),
      returns: op.response.description,
      deprecated: op.docs.deprecated,
      see: op.docs.externalDocs
        ? { url: op.docs.externalDocs.url, description: op.docs.externalDocs.description }
        : undefined,
    },
    indent
  );
  if (doc) lines.push(doc);

  const options = optionsSignature(op, indent);
  const returnType =
    op.response.type.kind === "void" ? "void" : printType(op.response.type, indent);
  lines.push(`${indent}${op.methodName}(${options}): Promise<${returnType}> {`);
  lines.push(...requestCall(op, `${indent}  `));
  lines.push(`${indent}},`);
  return lines.join("\n");
}

/** `@param` entries for everything that carries a description. */
function paramDocs(op: IrOperation): { name: string; description?: string }[] {
  const docs: { name: string; description?: string }[] = [];
  const groups: [string, IrParam[]][] = [
    ["path", op.pathParams],
    ["query", op.queryParams],
    ["headers", op.headerParams],
  ];
  for (const [group, params] of groups) {
    for (const param of params) {
      if (param.docs.description) {
        docs.push({ name: `options.${group}.${param.name}`, description: param.docs.description });
      }
    }
  }
  if (op.body?.docs.description) {
    docs.push({ name: "options.body", description: op.body.docs.description });
  }
  return docs;
}

interface OptionsShape {
  hasOptions: boolean;
  /** True when every group is optional, making the whole options object optional. */
  optional: boolean;
}

function optionsShape(op: IrOperation): OptionsShape {
  const hasOptions = true; // signal/extensions are always available
  const required =
    op.pathParams.length > 0 ||
    op.queryParams.some((p) => p.required) ||
    op.headerParams.some((p) => p.required) ||
    (op.body !== undefined && op.body.required);
  return { hasOptions, optional: !required };
}

function optionsSignature(op: IrOperation, indent: string): string {
  const inner = `${indent}  `;
  const groupLines: string[] = [];

  const paramGroup = (label: string, params: IrParam[]): void => {
    if (params.length === 0) return;
    const groupOptional = params.every((p) => !p.required) ? "?" : "";
    const propLines = params.flatMap((param) =>
      printProperty(
        {
          name: param.name,
          type: param.type,
          required: param.required,
          docs: param.docs,
        },
        `${inner}  `
      )
    );
    groupLines.push(`${inner}${label}${groupOptional}: {`, ...propLines, `${inner}};`);
  };

  paramGroup("path", op.pathParams);
  paramGroup("query", op.queryParams);
  paramGroup("headers", op.headerParams);
  if (op.body) {
    const optional = op.body.required ? "" : "?";
    groupLines.push(`${inner}body${optional}: ${printType(op.body.type, inner)};`);
  }
  groupLines.push(`${inner}signal?: AbortSignal;`);
  groupLines.push(`${inner}extensions?: Record<string, unknown>;`);

  const { optional } = optionsShape(op);
  return `options${optional ? "?" : ""}: {\n${groupLines.join("\n")}\n${indent}}`;
}

function requestCall(op: IrOperation, indent: string): string[] {
  const { optional } = optionsShape(op);
  const access = optional ? "options?." : "options.";
  const inner = `${indent}  `;

  const fields: string[] = [`${inner}method: "${op.httpMethod}",`, `${inner}path: "${op.path}",`];
  if (op.pathParams.length > 0) fields.push(`${inner}pathParams: ${access}path,`);
  if (op.queryParams.length > 0) fields.push(`${inner}query: ${access}query,`);
  if (op.headerParams.length > 0) fields.push(`${inner}headers: ${access}headers,`);
  if (op.body) {
    fields.push(`${inner}body: ${access}body,`);
    if (op.body.bodyType !== "json") fields.push(`${inner}bodyType: "${op.body.bodyType}",`);
  }
  if (op.response.responseType !== "json") {
    fields.push(`${inner}responseType: "${op.response.responseType}",`);
  }
  fields.push(`${inner}signal: ${access}signal,`);
  fields.push(`${inner}extensions: ${access}extensions,`);

  return [`${indent}return ctx.request({`, ...fields, `${indent}});`];
}

/** Re-exported for the index emitter: `pets` → `createPetsService`. */
export function serviceFactoryName(service: IrService): string {
  return `create${service.pascalName}Service`;
}

/** Property key for the service on the SDK object (quoted if needed). */
export function serviceProperty(service: IrService): string {
  return propertyKey(service.name);
}
