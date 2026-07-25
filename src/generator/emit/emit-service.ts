import type { IrOperation, IrParam, IrService } from "../ir.ts";
import type { CollisionCase, EmitContext } from "./ts-writer.ts";
import { collectRefs } from "../ir.ts";
/** Emits one `services/<name>.ts` file per service: a factory returning JSDoc'd methods. */
import { buildJsDoc } from "../jsdoc.ts";
import { camelCase, propertyKey, snakeCase } from "../names.ts";
import { headerLines, operationTypes } from "./emit-types.ts";
import {
  clientBase,
  printProperty,
  printType,
  relativeImport,
  runtimeClientImport,
} from "./ts-writer.ts";

export function emitService(service: IrService, ctx: EmitContext): string {
  const usedTypes = new Set<string>();
  for (const op of service.operations) {
    for (const type of operationTypes(op)) collectRefs(type, usedTypes);
  }

  const parts: string[] = headerLines(ctx);
  parts.push(
    `import type { ClientContext } from "${runtimeClientImport(ctx, clientBase(ctx.subdirDepth + 1))}";`
  );
  if (usedTypes.size > 0) {
    const names = [...usedTypes].sort().join(", ");
    parts.push(`import type { ${names} } from "${relativeImport(ctx, "../types", true)}";`);
  }
  parts.push("");

  // Standalone, tree-shakeable functions (client passed as the first argument):
  // `import { getPet } from ".../services/pets"` pulls in only what you use.
  for (const op of service.operations) {
    parts.push(emitStandaloneOperation(op, ctx), "");
  }

  // Ergonomic grouped factory: methods delegate to the standalone functions and
  // keep the `(params, options)` signature. Wired by `createSdk`.
  const factoryDoc = buildJsDoc({
    summary: service.docs.description ?? `Operations of the \`${service.name}\` service.`,
  });
  if (factoryDoc) parts.push(factoryDoc);
  parts.push(`export function create${service.pascalName}Service(ctx: ClientContext) {`);
  parts.push("  return {");
  for (const op of service.operations) {
    parts.push(emitDelegatingMethod(op, ctx), "");
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
 * Merge path params, query params, and (spread) body properties into the first
 * `params` argument. Body properties keep their names; a path/query param that
 * collides with a body property (or with each other) is suffixed with its
 * location, rendered in the configured {@link CollisionCase} (`id_path` /
 * `status_query` for `snake_case`, `idPath` / `statusQuery` for `camelCase`).
 * Headers, `signal`, and `extensions` live in the separate `options` argument,
 * so they never collide with data.
 */
function computeFlatPlan(op: IrOperation, collisionCase: CollisionCase): FlatPlan {
  const used = new Set<string>();

  // Reserve the emitted function's own identifiers: the argument names (`ctx`,
  // `params`, `options`) and the `params` object we destructure locals out of.
  // A path/query param named one of these must be suffixed, otherwise its
  // destructured local would shadow/collide with the argument it comes from
  // (e.g. `const { params } = params` for a spec param literally named `params`).
  for (const reserved of ["ctx", "params", "options"]) used.add(reserved);

  const bodySpread = op.body?.spreadProps !== undefined;
  if (op.body?.spreadProps) for (const name of op.body.spreadProps) used.add(name);
  if (op.body && !bodySpread) used.add("body");

  const suffixed = (tsName: string, location: "path" | "query"): string => {
    const combined = `${tsName} ${location}`;
    return collisionCase === "camelCase" ? camelCase(combined) : snakeCase(combined);
  };

  const assign = (tsName: string, location: "path" | "query"): string => {
    let name = used.has(tsName) ? suffixed(tsName, location) : tsName;
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

/** True when the operation has data for the first (`params`) argument. */
function hasData(op: IrOperation): boolean {
  return op.pathParams.length > 0 || op.queryParams.length > 0 || op.body !== undefined;
}

/** Whether the `params` argument can be optional (nothing in it is required). */
function paramsOptional(op: IrOperation): boolean {
  const required =
    op.pathParams.length > 0 ||
    op.queryParams.some((p) => p.required) ||
    (op.body !== undefined && op.body.required);
  return !required;
}

/** JSDoc block for an operation, shared by the standalone function and the factory method. */
function operationDoc(op: IrOperation, plan: FlatPlan, indent: string): string | undefined {
  return buildJsDoc(
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
}

/** The standalone, tree-shakeable function: `op(ctx, params?, options?)`. */
function emitStandaloneOperation(op: IrOperation, ctx: EmitContext): string {
  const plan = computeFlatPlan(op, ctx.collisionCase);
  const lines: string[] = [];

  const doc = operationDoc(op, plan, "");
  if (doc) lines.push(doc);

  const args: string[] = ["ctx: ClientContext"];
  if (hasData(op)) args.push(paramsSignature(op, plan, ""));
  args.push(`options?: ${optionsType(op, "")}`);

  const returnType = op.response.type.kind === "void" ? "void" : printType(op.response.type, "");
  lines.push(`export function ${op.methodName}(${args.join(", ")}): Promise<${returnType}> {`);
  lines.push(...requestCall(op, plan, "  "));
  lines.push("}");
  return lines.join("\n");
}

/** The factory method: same `(params?, options?)` signature, delegating to the standalone function. */
function emitDelegatingMethod(op: IrOperation, ctx: EmitContext): string {
  const indent = "    ";
  const plan = computeFlatPlan(op, ctx.collisionCase);
  const lines: string[] = [];

  const doc = operationDoc(op, plan, indent);
  if (doc) lines.push(doc);

  // Two args: data first (path/query/body), request options second. When the
  // operation has no data, only the `options` argument is emitted.
  const args: string[] = [];
  if (hasData(op)) args.push(paramsSignature(op, plan, indent));
  args.push(`options?: ${optionsType(op, indent)}`);

  const returnType =
    op.response.type.kind === "void" ? "void" : printType(op.response.type, indent);
  lines.push(`${indent}${op.methodName}(${args.join(", ")}): Promise<${returnType}> {`);

  const callArgs = ["ctx"];
  if (hasData(op)) callArgs.push("params");
  callArgs.push("options");
  lines.push(`${indent}  return ${op.methodName}(${callArgs.join(", ")});`);
  lines.push(`${indent}},`);
  return lines.join("\n");
}

/** `@param` entries for everything that carries a description. */
function paramDocs(op: IrOperation, plan: FlatPlan): { name: string; description?: string }[] {
  const docs: { name: string; description?: string }[] = [];
  for (const { param, local } of plan.params) {
    if (param.docs.description) {
      docs.push({ name: `params.${local}`, description: param.docs.description });
    }
  }
  // Spread body properties are documented on their own type; only a
  // single-argument (non-spread) body needs a `@param params.body` line.
  if (op.body && !plan.bodySpread && op.body.docs.description) {
    docs.push({ name: "params.body", description: op.body.docs.description });
  }
  for (const param of op.headerParams) {
    if (param.docs.description) {
      docs.push({ name: `options.headers.${param.name}`, description: param.docs.description });
    }
  }
  return docs;
}

/** The `params` (data) argument: path/query flat + spread/keyed body. */
function paramsSignature(op: IrOperation, plan: FlatPlan, indent: string): string {
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

  // Non-spreadable body (array/binary/union/primitive) stays a single `body` key.
  if (op.body && !plan.bodySpread) {
    const optional = op.body.required ? "" : "?";
    literalLines.push(`${inner}body${optional}: ${printType(op.body.type, inner)};`);
  }

  const opt = paramsOptional(op) ? "?" : "";

  // Spread body with extra path/query params → intersect body with the literal.
  if (plan.bodySpread && op.body) {
    if (literalLines.length === 0) return `params${opt}: ${printType(op.body.type, indent)}`;
    const literal = `{\n${literalLines.join("\n")}\n${indent}}`;
    return `params${opt}: ${printType(op.body.type, indent)} & ${literal}`;
  }
  const literal = `{\n${literalLines.join("\n")}\n${indent}}`;
  return `params${opt}: ${literal}`;
}

/** The `options` (request-control) argument type, present on every method. */
function optionsType(op: IrOperation, indent: string): string {
  const inner = `${indent}  `;
  const lines: string[] = [`${inner}headers?: ${headersType(op, inner)};`];
  lines.push(`${inner}signal?: AbortSignal;`);
  lines.push(`${inner}extensions?: Record<string, unknown>;`);
  return `{\n${lines.join("\n")}\n${indent}}`;
}

/**
 * Per-request headers type: any string/number/boolean header may be set to
 * override or add to the client's default headers. When the spec declares
 * header params, they appear as typed (and possibly required) known keys.
 */
function headersType(op: IrOperation, indent: string): string {
  const record = "Record<string, string | number | boolean>";
  if (op.headerParams.length === 0) return record;
  const inner = `${indent}  `;
  const propLines = op.headerParams.flatMap((param) =>
    printProperty(
      { name: param.name, type: param.type, required: param.required, docs: param.docs },
      inner
    )
  );
  return `{\n${propLines.join("\n")}\n${indent}} & ${record}`;
}

function requestCall(op: IrOperation, plan: FlatPlan, indent: string): string[] {
  const inner = `${indent}  `;
  const lines: string[] = [];

  // Pull path/query params (and, for a spread body, the leftover `...body`) out
  // of `params` so they can be referenced as plain locals below.
  const locals = plan.params.map((p) => p.local);
  const destructured = [...locals];
  const spreadRest = Boolean(op.body) && plan.bodySpread && locals.length > 0;
  let bodyExpr: string | undefined;

  if (op.body) {
    if (plan.bodySpread) {
      bodyExpr = locals.length > 0 ? "body" : "params"; // no locals → params IS the body
    } else {
      destructured.push("body");
      bodyExpr = "body";
    }
  }

  if (destructured.length > 0) {
    const source = paramsOptional(op) ? "params ?? {}" : "params";
    const rest = spreadRest ? ", ...body" : "";
    lines.push(`${indent}const { ${destructured.join(", ")}${rest} } = ${source};`);
  }

  const fields: string[] = [`${inner}method: "${op.httpMethod}",`, `${inner}path: "${op.path}",`];
  if (op.pathParams.length > 0) fields.push(`${inner}pathParams: { ${paramMap(plan, "path")} },`);
  if (op.queryParams.length > 0) fields.push(`${inner}query: { ${paramMap(plan, "query")} },`);
  fields.push(`${inner}headers: options?.headers,`);
  if (op.body) {
    fields.push(`${inner}body: ${bodyExpr},`);
    if (op.body.bodyType !== "json") fields.push(`${inner}bodyType: "${op.body.bodyType}",`);
  }
  if (op.response.responseType !== "json") {
    fields.push(`${inner}responseType: "${op.response.responseType}",`);
  }
  fields.push(`${inner}signal: options?.signal,`);
  fields.push(`${inner}extensions: options?.extensions,`);

  lines.push(`${indent}return ctx.request({`, ...fields, `${indent}});`);
  return lines;
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
