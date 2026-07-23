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

/**
 * A single flat argument projected from a path/query parameter, with a local
 * name that is unique within the method's options object.
 */
interface FlatParam {
  param: IrParam;
  local: string;
  group: "path" | "query";
}

interface FlatPlan {
  /** Path + query params, flattened, with collision-resolved local names. */
  params: FlatParam[];
  /** True when the body's properties are spread into the flat options object. */
  bodySpread: boolean;
}

/**
 * Merge path params, query params, and (spread) body properties into one flat
 * options object. Body properties keep their names; a path/query param that
 * collides with a body property (or with each other) is suffixed with its
 * location (`id_path`, `status_query`). Headers stay in a nested `headers`
 * group; `signal`/`extensions` are reserved sibling keys.
 */
function computeFlatPlan(op: IrOperation): FlatPlan {
  const used = new Set<string>(["signal", "extensions"]);
  if (op.headerParams.length > 0) used.add("headers");

  const bodySpread = op.body?.spreadProps !== undefined;
  if (op.body?.spreadProps) for (const name of op.body.spreadProps) used.add(name);
  if (op.body && !bodySpread) used.add("body");

  const assign = (tsName: string, suffix: string): string => {
    let name = used.has(tsName) ? `${tsName}_${suffix}` : tsName;
    while (used.has(name)) name = `${name}_`;
    used.add(name);
    return name;
  };

  const params: FlatParam[] = [];
  for (const param of op.pathParams) {
    params.push({ param, local: assign(param.tsName, "path"), group: "path" });
  }
  for (const param of op.queryParams) {
    params.push({ param, local: assign(param.tsName, "query"), group: "query" });
  }
  return { params, bodySpread };
}

/** Whether the whole `options` object can be optional (nothing required). */
function optionsOptional(op: IrOperation): boolean {
  const required =
    op.pathParams.length > 0 ||
    op.queryParams.some((p) => p.required) ||
    op.headerParams.some((p) => p.required) ||
    (op.body !== undefined && op.body.required);
  return !required;
}

function emitOperation(op: IrOperation): string {
  const indent = "    ";
  const plan = computeFlatPlan(op);
  const lines: string[] = [];

  const doc = buildJsDoc(
    {
      summary: op.docs.summary,
      description: op.docs.description,
      params: paramDocs(op, plan),
      returns: op.response.description,
      deprecated: op.docs.deprecated,
      see: op.docs.externalDocs
        ? { url: op.docs.externalDocs.url, description: op.docs.externalDocs.description }
        : undefined,
    },
    indent
  );
  if (doc) lines.push(doc);

  const options = optionsSignature(op, plan, indent);
  const returnType =
    op.response.type.kind === "void" ? "void" : printType(op.response.type, indent);
  lines.push(`${indent}${op.methodName}(${options}): Promise<${returnType}> {`);
  lines.push(...requestCall(op, plan, `${indent}  `));
  lines.push(`${indent}},`);
  return lines.join("\n");
}

/** `@param` entries for everything that carries a description. */
function paramDocs(op: IrOperation, plan: FlatPlan): { name: string; description?: string }[] {
  const docs: { name: string; description?: string }[] = [];
  for (const { param, local } of plan.params) {
    if (param.docs.description) {
      docs.push({ name: `options.${local}`, description: param.docs.description });
    }
  }
  for (const param of op.headerParams) {
    if (param.docs.description) {
      docs.push({ name: `options.headers.${param.name}`, description: param.docs.description });
    }
  }
  // Spread body properties are documented on their own type; only a
  // single-argument (non-spread) body needs a `@param options.body` line.
  if (op.body && !plan.bodySpread && op.body.docs.description) {
    docs.push({ name: "options.body", description: op.body.docs.description });
  }
  return docs;
}

function optionsSignature(op: IrOperation, plan: FlatPlan, indent: string): string {
  const inner = `${indent}  `;
  const literalLines: string[] = [];

  // Flat path + query params.
  for (const { param, local } of plan.params) {
    literalLines.push(
      ...printProperty(
        { name: local, type: param.type, required: param.required, docs: param.docs },
        inner
      )
    );
  }

  // Headers stay a nested group.
  if (op.headerParams.length > 0) {
    const groupOptional = op.headerParams.every((p) => !p.required) ? "?" : "";
    const propLines = op.headerParams.flatMap((param) =>
      printProperty(
        { name: param.name, type: param.type, required: param.required, docs: param.docs },
        `${inner}  `
      )
    );
    literalLines.push(`${inner}headers${groupOptional}: {`, ...propLines, `${inner}};`);
  }

  // Non-spreadable body (array/binary/union/primitive) stays a single `body` key.
  if (op.body && !plan.bodySpread) {
    const optional = op.body.required ? "" : "?";
    literalLines.push(`${inner}body${optional}: ${printType(op.body.type, inner)};`);
  }

  literalLines.push(`${inner}signal?: AbortSignal;`);
  literalLines.push(`${inner}extensions?: Record<string, unknown>;`);

  const literal = `{\n${literalLines.join("\n")}\n${indent}}`;
  const opt = optionsOptional(op) ? "?" : "";

  // Spread body → intersect the body type with the control/param literal.
  if (plan.bodySpread && op.body) {
    return `options${opt}: ${printType(op.body.type, indent)} & ${literal}`;
  }
  return `options${opt}: ${literal}`;
}

function requestCall(op: IrOperation, plan: FlatPlan, indent: string): string[] {
  const inner = `${indent}  `;

  // Destructure known keys; a spread body captures everything left over.
  const names = plan.params.map((p) => p.local);
  if (op.headerParams.length > 0) names.push("headers");
  names.push("signal", "extensions");
  if (op.body && !plan.bodySpread) names.push("body");
  const rest = plan.bodySpread ? ", ...body" : "";
  const source = optionsOptional(op) ? "options ?? {}" : "options";
  const destructure = `${indent}const { ${names.join(", ")}${rest} } = ${source};`;

  const fields: string[] = [`${inner}method: "${op.httpMethod}",`, `${inner}path: "${op.path}",`];
  if (op.pathParams.length > 0) {
    fields.push(`${inner}pathParams: { ${paramMap(plan, "path")} },`);
  }
  if (op.queryParams.length > 0) {
    fields.push(`${inner}query: { ${paramMap(plan, "query")} },`);
  }
  if (op.headerParams.length > 0) fields.push(`${inner}headers,`);
  if (op.body) {
    fields.push(`${inner}body,`);
    if (op.body.bodyType !== "json") fields.push(`${inner}bodyType: "${op.body.bodyType}",`);
  }
  if (op.response.responseType !== "json") {
    fields.push(`${inner}responseType: "${op.response.responseType}",`);
  }
  fields.push(`${inner}signal,`);
  fields.push(`${inner}extensions,`);

  return [destructure, `${indent}return ctx.request({`, ...fields, `${indent}});`];
}

/** `{ wireName: localName }` entries mapping flat args back to their wire names. */
function paramMap(plan: FlatPlan, group: "path" | "query"): string {
  return plan.params
    .filter((p) => p.group === group)
    .map(({ param, local }) => {
      const key = propertyKey(param.name);
      return key === local ? key : `${key}: ${local}`;
    })
    .join(", ");
}

/** Re-exported for the index emitter: `pets` → `createPetsService`. */
export function serviceFactoryName(service: IrService): string {
  return `create${service.pascalName}Service`;
}

/** Property key for the service on the SDK object (quoted if needed). */
export function serviceProperty(service: IrService): string {
  return propertyKey(service.name);
}
