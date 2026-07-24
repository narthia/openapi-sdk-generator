import type { IrProperty, IrType } from "../ir.ts";
/** IrType → TypeScript source printing, shared by the type and service emitters. */
import { buildJsDoc } from "../jsdoc.ts";
import { propertyKey } from "../names.ts";

const INDENT = "  ";

/** Case style for the suffix applied to a collided path/query param name. */
export type CollisionCase = "snake_case" | "camelCase";

/**
 * A fully resolved auth scheme (all field-name defaults applied) that the index
 * emitter turns into a bespoke config type and a runtime-auth adapter.
 */
export type ResolvedAuthScheme =
  | { type: "bearer"; key: string; field: string }
  | { type: "apiKey"; key: string; in: "header" | "query"; name: string; field: string }
  | { type: "basic"; key: string; usernameField: string; passwordField: string };

/** The auth schemes a generated SDK supports (the client uses exactly one). */
export interface ResolvedAuth {
  schemes: ResolvedAuthScheme[];
}

/** Options shared by every emitted file. */
export interface EmitContext {
  /** Import specifier of the runtime package, e.g. `@narthia/openapi-sdk-generator`. */
  runtimePackage: string;
  /** Extension appended to relative imports: "" (none), "js", or "ts". */
  importExtension: "" | "js" | "ts";
  /** Name of the generated SDK factory, e.g. `createSdk`. */
  sdkName: string;
  /** Case used to render a collided path/query param name (`snake_case` → `status_query`, `camelCase` → `statusQuery`). */
  collisionCase: CollisionCase;
  /** Resolved auth model, or `undefined` to emit the generic runtime `ClientConfig`. */
  auth?: ResolvedAuth;
}

/** Render a relative import specifier honoring the configured extension. */
export function relativeImport(ctx: EmitContext, path: string, isDirectory = false): string {
  if (ctx.importExtension === "") return path;
  return isDirectory ? `${path}/index.${ctx.importExtension}` : `${path}.${ctx.importExtension}`;
}

/** Print a type for a value/annotation position. `indent` is the current line's indentation. */
export function printType(type: IrType, indent = ""): string {
  switch (type.kind) {
    case "ref":
      return type.name;
    case "string":
    case "number":
    case "boolean":
    case "null":
    case "unknown":
    case "never":
    case "void":
      return type.kind;
    case "literal":
      return JSON.stringify(type.value);
    case "binary":
      return "Blob";
    case "array": {
      const items = printType(type.items, indent);
      return needsParens(type.items) ? `(${items})[]` : `${items}[]`;
    }
    case "union":
      return type.variants.map((v) => printType(v, indent)).join(" | ");
    case "intersection":
      return type.members
        .map((m) => (m.kind === "union" ? `(${printType(m, indent)})` : printType(m, indent)))
        .join(" & ");
    case "object":
      return printObjectType(type, indent);
  }
}

function needsParens(type: IrType): boolean {
  return type.kind === "union" || type.kind === "intersection";
}

function printObjectType(type: Extract<IrType, { kind: "object" }>, indent: string): string {
  const { properties, additionalProperties } = type;

  if (properties.length === 0) {
    if (additionalProperties === undefined || additionalProperties === true) {
      return "Record<string, unknown>";
    }
    return `Record<string, ${printType(additionalProperties, indent)}>`;
  }

  const inner = indent + INDENT;
  const lines: string[] = ["{"];
  for (const prop of properties) {
    lines.push(...printProperty(prop, inner));
  }
  if (additionalProperties === true) {
    lines.push(`${inner}[key: string]: unknown;`);
  }
  lines.push(`${indent}}`);
  const body = lines.join("\n");

  // A typed additionalProperties can't share an object literal with narrower
  // props, so it becomes an intersection.
  if (additionalProperties !== undefined && additionalProperties !== true) {
    return `${body} & Record<string, ${printType(additionalProperties, indent)}>`;
  }
  return body;
}

/** Print one property line (with its JSDoc) of an object type. */
export function printProperty(prop: IrProperty, indent: string): string[] {
  const lines: string[] = [];
  const doc = buildJsDoc(
    {
      description: prop.docs.description,
      deprecated: prop.docs.deprecated,
      default: prop.docs.default,
      format: prop.docs.format,
      example: prop.docs.example,
    },
    indent
  );
  if (doc) lines.push(doc);
  const optional = prop.required ? "" : "?";
  lines.push(`${indent}${propertyKey(prop.name)}${optional}: ${printType(prop.type, indent)};`);
  return lines;
}
