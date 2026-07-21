import type { OpenApiMode } from "./detect.ts";

/**
 * Canonical schema shape used by the rest of the generator.
 *
 * Normalization erases the differences between OpenAPI 3.0 and 3.1:
 * - 3.0 `nullable: true` and 3.1 `type: [..., "null"]` both become `types` including `"null"`
 * - `type` is always an array (`types`), never a bare string
 * - 3.1 `const` becomes a single-value `enum`
 * - 3.1 `examples: [x, ...]` collapses to `example: x`
 */
export interface NormalizedSchema {
  $ref?: string;
  /** JSON Schema types; may include "null". Absent = untyped. */
  types?: string[];
  enum?: (string | number | boolean | null)[];
  format?: string;
  items?: NormalizedSchema;
  properties?: Record<string, NormalizedSchema>;
  required?: string[];
  additionalProperties?: NormalizedSchema | boolean;
  allOf?: NormalizedSchema[];
  oneOf?: NormalizedSchema[];
  anyOf?: NormalizedSchema[];
  discriminator?: { propertyName: string };
  title?: string;
  description?: string;
  deprecated?: boolean;
  example?: unknown;
  default?: unknown;
  externalDocs?: { url: string; description?: string };
  contentMediaType?: string;
}

type RawSchema = Record<string, unknown>;

/**
 * Normalize a raw OpenAPI 3.0/3.1 schema object (recursively) into a
 * {@link NormalizedSchema}. Boolean schemas (`true` / `{}`) normalize to `{}`
 * (unknown); `false` normalizes to an empty `enum` (never).
 */
export function normalizeSchema(raw: unknown, mode: OpenApiMode): NormalizedSchema {
  if (raw === true || raw === undefined || raw === null) return {};
  if (raw === false) return { enum: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) return {};

  const schema = raw as RawSchema;
  const out: NormalizedSchema = {};

  if (typeof schema["$ref"] === "string") {
    out.$ref = schema["$ref"];
    // 3.1 allows annotation keywords next to $ref; keep the useful ones.
    copyAnnotations(schema, out);
    return out;
  }

  // --- type / nullable ---
  const rawType = schema["type"];
  let types: string[] | undefined;
  if (typeof rawType === "string") types = [rawType];
  else if (Array.isArray(rawType))
    types = rawType.filter((t): t is string => typeof t === "string");
  if (mode === "3.0" && schema["nullable"] === true) {
    types = [...(types ?? []), "null"];
  }
  if (types && types.length > 0) out.types = [...new Set(types)];

  // --- const / enum ---
  if (schema["const"] !== undefined) {
    out.enum = [schema["const"] as string | number | boolean | null];
  } else if (Array.isArray(schema["enum"])) {
    out.enum = schema["enum"] as (string | number | boolean | null)[];
  }

  if (typeof schema["format"] === "string") out.format = schema["format"];
  if (typeof schema["contentMediaType"] === "string") {
    out.contentMediaType = schema["contentMediaType"];
  }

  // --- children ---
  if (schema["items"] !== undefined) out.items = normalizeSchema(schema["items"], mode);
  if (typeof schema["properties"] === "object" && schema["properties"] !== null) {
    out.properties = {};
    for (const [key, value] of Object.entries(schema["properties"] as RawSchema)) {
      out.properties[key] = normalizeSchema(value, mode);
    }
  }
  if (Array.isArray(schema["required"])) {
    out.required = schema["required"].filter((r): r is string => typeof r === "string");
  }
  const additional = schema["additionalProperties"];
  if (additional !== undefined) {
    out.additionalProperties =
      typeof additional === "boolean" ? additional : normalizeSchema(additional, mode);
  }
  for (const combinator of ["allOf", "oneOf", "anyOf"] as const) {
    const members = schema[combinator];
    if (Array.isArray(members)) {
      out[combinator] = members.map((m) => normalizeSchema(m, mode));
    }
  }
  const discriminator = schema["discriminator"] as { propertyName?: string } | undefined;
  if (discriminator && typeof discriminator.propertyName === "string") {
    out.discriminator = { propertyName: discriminator.propertyName };
  }

  copyAnnotations(schema, out);
  return out;
}

function copyAnnotations(schema: RawSchema, out: NormalizedSchema): void {
  if (typeof schema["title"] === "string") out.title = schema["title"];
  if (typeof schema["description"] === "string") out.description = schema["description"];
  if (schema["deprecated"] === true) out.deprecated = true;
  if (schema["default"] !== undefined) out.default = schema["default"];
  if (schema["example"] !== undefined) {
    out.example = schema["example"];
  } else if (Array.isArray(schema["examples"]) && schema["examples"].length > 0) {
    out.example = schema["examples"][0];
  }
  const externalDocs = schema["externalDocs"] as { url?: string; description?: string } | undefined;
  if (externalDocs && typeof externalDocs.url === "string") {
    out.externalDocs = { url: externalDocs.url, description: externalDocs.description };
  }
}
