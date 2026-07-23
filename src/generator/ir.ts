/**
 * Intermediate representation of an OpenAPI document, plus the spec → IR builder.
 * The IR is the contract between normalization and all emitters.
 */
import type { BodyType, HttpMethod, ResponseType } from "../client/types.ts";
import type { OpenApiMode } from "./detect.ts";
import type { NormalizedSchema } from "./normalize.ts";
import {
  identifier,
  kebabCase,
  NameRegistry,
  pascalCase,
  synthesizeMethodName,
  typeName,
} from "./names.ts";
import { normalizeSchema } from "./normalize.ts";
import { componentSchemaName, derefObject, resolveRef } from "./refs.ts";

export type IrType =
  | { kind: "ref"; name: string }
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "unknown" }
  | { kind: "never" }
  | { kind: "void" }
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "array"; items: IrType }
  | { kind: "object"; properties: IrProperty[]; additionalProperties?: IrType | true }
  | { kind: "union"; variants: IrType[] }
  | { kind: "intersection"; members: IrType[] }
  | { kind: "binary" };

export interface IrDocs {
  summary?: string;
  description?: string;
  deprecated?: boolean;
  externalDocs?: { url: string; description?: string };
  example?: unknown;
  default?: unknown;
  format?: string;
}

export interface IrProperty {
  /** Original wire name (emitted quoted when not a valid identifier). */
  name: string;
  type: IrType;
  required: boolean;
  docs: IrDocs;
}

export interface IrParam {
  /** Original wire name used on the request. */
  name: string;
  /** Sanitized TS identifier for the options object. */
  tsName: string;
  location: "path" | "query" | "header";
  required: boolean;
  type: IrType;
  docs: IrDocs;
}

export interface IrBody {
  type: IrType;
  required: boolean;
  bodyType: BodyType;
  docs: IrDocs;
  /**
   * When set, the body is an object whose properties are spread into the
   * method's flat options object; the array lists its known top-level property
   * names (used for conflict detection). Absent = body is passed as a single
   * `body` argument (non-object bodies: array, binary, union, primitive).
   */
  spreadProps?: string[];
}

export interface IrResponse {
  type: IrType;
  responseType: ResponseType;
  description?: string;
}

export interface IrOperation {
  methodName: string;
  httpMethod: HttpMethod;
  path: string;
  docs: IrDocs;
  pathParams: IrParam[];
  queryParams: IrParam[];
  headerParams: IrParam[];
  body?: IrBody;
  response: IrResponse;
}

export interface IrService {
  /** Property key on the SDK object, e.g. `pets`. */
  name: string;
  /** PascalCase base for factory/type names, e.g. `Pets`. */
  pascalName: string;
  /** Kebab-case file base name, e.g. `user-accounts`. */
  fileName: string;
  docs: IrDocs;
  operations: IrOperation[];
}

export interface IrSchema {
  name: string;
  type: IrType;
  docs: IrDocs;
}

export interface IrDocument {
  info: { title: string; version: string; description?: string };
  /** All named types (component schemas + hoisted anonymous schemas). */
  schemas: IrSchema[];
  services: IrService[];
  /** Non-fatal generation warnings, surfaced by the CLI. */
  warnings: string[];
}

const HTTP_METHODS: HttpMethod[] = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
];

type RawObject = Record<string, unknown>;

/** Build the IR for a validated OpenAPI 3.x document. */
export function buildIr(spec: RawObject, mode: OpenApiMode): IrDocument {
  return new IrBuilder(spec, mode).build();
}

class IrBuilder {
  private readonly typeNames = new NameRegistry();
  /** components.schemas key → claimed TS type name. */
  private readonly schemaNameByKey = new Map<string, string>();
  private readonly schemas: IrSchema[] = [];
  private readonly warnings: string[] = [];
  /** Structural-dedup registry for hoisted anonymous schemas: stable key → type name. */
  private readonly hoistedByShape = new Map<string, string>();
  /** How often each anonymous top-level shape occurs (counted before building). */
  private readonly shapeCounts = new Map<string, number>();

  constructor(
    private readonly spec: RawObject,
    private readonly mode: OpenApiMode
  ) {}

  build(): IrDocument {
    const info = (this.spec["info"] ?? {}) as RawObject;

    // 1. Claim names for all component schemas first so $refs always resolve
    //    to stable names regardless of declaration order.
    const componentSchemas = this.componentSchemas();
    for (const key of Object.keys(componentSchemas)) {
      this.schemaNameByKey.set(key, this.typeNames.claim(typeName(key)));
    }

    // 2. Convert component schemas to named IR types.
    for (const [key, raw] of Object.entries(componentSchemas)) {
      const normalized = normalizeSchema(raw, this.mode);
      this.schemas.push({
        name: this.schemaNameByKey.get(key)!,
        type: this.toType(normalized),
        docs: docsFromSchema(normalized),
      });
    }

    // 3. Count anonymous operation-level shapes so repeated ones can be hoisted.
    this.countAnonymousShapes();

    // 4. Build services from paths.
    const services = this.buildServices();

    return {
      info: {
        title: typeof info["title"] === "string" ? info["title"] : "API",
        version: typeof info["version"] === "string" ? info["version"] : "0.0.0",
        description: typeof info["description"] === "string" ? info["description"] : undefined,
      },
      schemas: this.schemas,
      services,
      warnings: this.warnings,
    };
  }

  private componentSchemas(): RawObject {
    const components = (this.spec["components"] ?? {}) as RawObject;
    return (components["schemas"] ?? {}) as RawObject;
  }

  // --- services / operations ---

  private buildServices(): IrService[] {
    const paths = (this.spec["paths"] ?? {}) as RawObject;
    const tagDocs = new Map<string, IrDocs>();
    for (const tag of (this.spec["tags"] as RawObject[] | undefined) ?? []) {
      if (typeof tag["name"] === "string") {
        tagDocs.set(tag["name"], {
          description: typeof tag["description"] === "string" ? tag["description"] : undefined,
        });
      }
    }

    const services = new Map<string, IrService>();
    const methodRegistries = new Map<string, NameRegistry>();

    for (const [path, rawItem] of Object.entries(paths)) {
      const pathItem = derefObject(this.spec, rawItem) as RawObject;
      const sharedParams = (pathItem["parameters"] as unknown[] | undefined) ?? [];

      for (const httpMethod of HTTP_METHODS) {
        const rawOp = pathItem[httpMethod] as RawObject | undefined;
        if (!rawOp) continue;

        const tags = rawOp["tags"] as string[] | undefined;
        const groupKey = tags?.[0] ?? firstPathSegment(path);
        const serviceName = identifier(groupKey);

        let service = services.get(serviceName);
        if (!service) {
          service = {
            name: serviceName,
            pascalName: pascalCase(groupKey),
            fileName: kebabCase(groupKey),
            docs: tagDocs.get(groupKey) ?? {},
            operations: [],
          };
          services.set(serviceName, service);
          methodRegistries.set(serviceName, new NameRegistry());
        }

        const registry = methodRegistries.get(serviceName)!;
        const operation = this.buildOperation(httpMethod, path, rawOp, sharedParams, registry);
        service.operations.push(operation);
      }
    }

    return [...services.values()];
  }

  private buildOperation(
    httpMethod: HttpMethod,
    path: string,
    rawOp: RawObject,
    sharedParams: unknown[],
    methodNames: NameRegistry
  ): IrOperation {
    const context = `${httpMethod.toUpperCase()} ${path}`;
    const operationId = typeof rawOp["operationId"] === "string" ? rawOp["operationId"] : undefined;
    const baseName = operationId ? identifier(operationId) : synthesizeMethodName(httpMethod, path);
    const methodName = methodNames.claim(baseName);
    if (methodName !== baseName) {
      this.warnings.push(
        `Duplicate method name "${baseName}" (${context}); renamed to "${methodName}".`
      );
    }

    const pathParams: IrParam[] = [];
    const queryParams: IrParam[] = [];
    const headerParams: IrParam[] = [];
    const allParams = [...sharedParams, ...((rawOp["parameters"] as unknown[] | undefined) ?? [])];
    for (const rawParam of allParams) {
      const param = derefObject(this.spec, rawParam) as RawObject;
      const location = param["in"];
      const name = typeof param["name"] === "string" ? param["name"] : "";
      if (location === "cookie") {
        this.warnings.push(`Cookie parameter "${name}" (${context}) is not supported; skipped.`);
        continue;
      }
      if (location !== "path" && location !== "query" && location !== "header") continue;

      const style = param["style"];
      if (location === "query" && typeof style === "string" && style !== "form") {
        this.warnings.push(
          `Query parameter "${name}" (${context}) uses unsupported style "${style}"; serialized as form/explode.`
        );
      }

      const schema = normalizeSchema(param["schema"], this.mode);
      const ir: IrParam = {
        name,
        tsName: identifier(name),
        location,
        required: location === "path" ? true : param["required"] === true,
        type: this.toType(schema, { hoistName: `${pascalCase(methodName)}${pascalCase(name)}` }),
        docs: {
          ...docsFromSchema(schema),
          description:
            typeof param["description"] === "string"
              ? param["description"]
              : docsFromSchema(schema).description,
          deprecated: param["deprecated"] === true || undefined,
        },
      };
      (location === "path" ? pathParams : location === "query" ? queryParams : headerParams).push(
        ir
      );
    }

    return {
      methodName,
      httpMethod,
      path,
      docs: {
        summary: typeof rawOp["summary"] === "string" ? rawOp["summary"] : undefined,
        description: typeof rawOp["description"] === "string" ? rawOp["description"] : undefined,
        deprecated: rawOp["deprecated"] === true || undefined,
        externalDocs: (rawOp["externalDocs"] as IrDocs["externalDocs"]) ?? undefined,
      },
      pathParams,
      queryParams,
      headerParams,
      body: this.buildBody(rawOp, methodName, context),
      response: this.buildResponse(rawOp, methodName, context),
    };
  }

  private buildBody(rawOp: RawObject, methodName: string, context: string): IrBody | undefined {
    const requestBody = derefObject(this.spec, rawOp["requestBody"]) as RawObject | undefined;
    if (!requestBody) return undefined;
    const content = (requestBody["content"] ?? {}) as RawObject;
    const selected = selectContent(content);
    if (!selected) return undefined;
    if (selected.warning) this.warnings.push(`${selected.warning} (${context})`);

    const schema = normalizeSchema((selected.media["schema"] ?? {}) as RawObject, this.mode);
    const type =
      selected.bodyType === "binary" && schema.$ref === undefined && !schema.properties
        ? ({ kind: "binary" } as IrType)
        : this.toType(schema, { hoistName: `${pascalCase(methodName)}Body` });
    return {
      type,
      required: requestBody["required"] === true,
      bodyType: selected.bodyType,
      docs: {
        description:
          typeof requestBody["description"] === "string" ? requestBody["description"] : undefined,
      },
      spreadProps: this.resolveSpreadProps(type),
    };
  }

  /**
   * Top-level property names of a body type, if it can be spread into the flat
   * options object (a plain object, or an intersection/ref resolving to one).
   * Returns `undefined` for non-spreadable bodies (array, binary, union, primitive).
   */
  private resolveSpreadProps(type: IrType, seen = new Set<string>()): string[] | undefined {
    switch (type.kind) {
      case "object":
        return type.properties.map((p) => p.name);
      case "ref": {
        if (seen.has(type.name)) return undefined;
        seen.add(type.name);
        const schema = this.schemas.find((s) => s.name === type.name);
        return schema ? this.resolveSpreadProps(schema.type, seen) : undefined;
      }
      case "intersection": {
        const names: string[] = [];
        for (const member of type.members) {
          const memberProps = this.resolveSpreadProps(member, seen);
          if (memberProps === undefined) return undefined;
          names.push(...memberProps);
        }
        return [...new Set(names)];
      }
      default:
        return undefined;
    }
  }

  private buildResponse(rawOp: RawObject, methodName: string, context: string): IrResponse {
    const responses = (rawOp["responses"] ?? {}) as RawObject;
    const successCodes = Object.keys(responses)
      .filter((code) => /^2(\d\d|XX)$/i.test(code))
      .sort();
    const codes =
      successCodes.length > 0
        ? successCodes
        : Object.keys(responses).filter((code) => code === "default");

    const variants: IrType[] = [];
    let responseType: ResponseType = "void";
    let description: string | undefined;

    for (const code of codes) {
      const response = derefObject(this.spec, responses[code]) as RawObject;
      description ??=
        typeof response["description"] === "string" ? response["description"] : undefined;
      const content = (response["content"] ?? {}) as RawObject;
      const selected = selectContent(content);
      if (!selected) continue; // no content (e.g. 204) → contributes void

      if (selected.bodyType === "binary") {
        responseType = "binary";
        variants.push({ kind: "binary" });
        continue;
      }
      if (selected.bodyType === "text") {
        if (responseType === "void") responseType = "text";
        variants.push({ kind: "string" });
        continue;
      }
      const schema = normalizeSchema((selected.media["schema"] ?? {}) as RawObject, this.mode);
      variants.push(this.toType(schema, { hoistName: `${pascalCase(methodName)}Response` }));
      responseType = "json";
    }

    if (variants.length === 0) {
      return { type: { kind: "void" }, responseType: "void", description };
    }
    if (responseType === "binary" && variants.some((v) => v.kind !== "binary")) {
      this.warnings.push(
        `Mixed binary and structured success responses (${context}); using binary.`
      );
    }
    return { type: dedupeUnion(variants), responseType, description };
  }

  // --- anonymous shape counting (for structural dedup hoisting) ---

  private countAnonymousShapes(): void {
    const paths = (this.spec["paths"] ?? {}) as RawObject;
    for (const rawItem of Object.values(paths)) {
      const pathItem = derefObject(this.spec, rawItem) as RawObject;
      for (const httpMethod of HTTP_METHODS) {
        const rawOp = pathItem[httpMethod] as RawObject | undefined;
        if (!rawOp) continue;
        const requestBody = derefObject(this.spec, rawOp["requestBody"]) as RawObject | undefined;
        if (requestBody) {
          const selected = selectContent((requestBody["content"] ?? {}) as RawObject);
          if (selected) this.countShape(selected.media["schema"]);
        }
        for (const rawResponse of Object.values((rawOp["responses"] ?? {}) as RawObject)) {
          const response = derefObject(this.spec, rawResponse) as RawObject;
          const selected = selectContent((response["content"] ?? {}) as RawObject);
          if (selected) this.countShape(selected.media["schema"]);
        }
      }
    }
  }

  private countShape(rawSchema: unknown): void {
    const normalized = normalizeSchema(rawSchema, this.mode);
    const key = hoistKey(normalized);
    if (key === undefined) return;
    this.shapeCounts.set(key, (this.shapeCounts.get(key) ?? 0) + 1);
  }

  // --- schema → IrType ---

  private toType(schema: NormalizedSchema, context: { hoistName?: string } = {}): IrType {
    // Named reference to a component schema.
    if (schema.$ref !== undefined) {
      const key = componentSchemaName(schema.$ref);
      if (key !== undefined && this.schemaNameByKey.has(key)) {
        return { kind: "ref", name: this.schemaNameByKey.get(key)! };
      }
      // Non-schema-component (or nested) pointer: resolve and convert inline.
      const target = normalizeSchema(resolveRef(this.spec, schema.$ref), this.mode);
      return this.toType(target, context);
    }

    // Structural dedup: repeated anonymous top-level shapes become one named type.
    const key = context.hoistName !== undefined ? hoistKey(schema) : undefined;
    if (key !== undefined && (this.shapeCounts.get(key) ?? 0) >= 2) {
      const existing = this.hoistedByShape.get(key);
      if (existing !== undefined) return { kind: "ref", name: existing };
      const name = this.typeNames.claim(typeName(schema.title ?? context.hoistName!));
      this.hoistedByShape.set(key, name);
      this.schemas.push({
        name,
        type: this.convertStructure(schema),
        docs: docsFromSchema(schema),
      });
      return { kind: "ref", name };
    }

    return this.convertStructure(schema);
  }

  private convertStructure(schema: NormalizedSchema): IrType {
    // Combinators first: allOf → intersection, oneOf/anyOf → union.
    if (schema.allOf) {
      const members = schema.allOf.map((m) => this.toType(m));
      return withNull(
        schema,
        members.length === 1 ? members[0]! : { kind: "intersection", members }
      );
    }
    if (schema.oneOf || schema.anyOf) {
      const variants = (schema.oneOf ?? schema.anyOf)!.map((m) => this.toType(m));
      return withNull(schema, dedupeUnion(variants));
    }

    if (schema.enum) {
      if (schema.enum.length === 0) return { kind: "never" };
      const variants = schema.enum.map(
        (value): IrType => (value === null ? { kind: "null" } : { kind: "literal", value })
      );
      return withNull(schema, dedupeUnion(variants));
    }

    const types = (schema.types ?? []).filter((t) => t !== "null");
    const nullable = schema.types?.includes("null") ?? false;

    if (types.length === 0) {
      // Untyped object-ish or fully unknown schema.
      if (schema.properties || schema.additionalProperties !== undefined) {
        return withNullFlag(this.objectType(schema), nullable);
      }
      return { kind: "unknown" };
    }

    const variants = types.map((t) => this.singleType(t, schema));
    return withNullFlag(dedupeUnion(variants), nullable);
  }

  private singleType(type: string, schema: NormalizedSchema): IrType {
    switch (type) {
      case "string":
        return schema.format === "binary" || schema.contentMediaType === "application/octet-stream"
          ? { kind: "binary" }
          : { kind: "string" };
      case "integer":
      case "number":
        return { kind: "number" };
      case "boolean":
        return { kind: "boolean" };
      case "null":
        return { kind: "null" };
      case "array":
        return {
          kind: "array",
          items: schema.items ? this.toType(schema.items) : { kind: "unknown" },
        };
      case "object":
        return this.objectType(schema);
      default:
        return { kind: "unknown" };
    }
  }

  private objectType(schema: NormalizedSchema): IrType {
    const required = new Set(schema.required ?? []);
    const properties: IrProperty[] = Object.entries(schema.properties ?? {}).map(
      ([name, propSchema]) => ({
        name,
        type: this.toType(propSchema),
        required: required.has(name),
        docs: docsFromSchema(propSchema),
      })
    );

    let additionalProperties: IrType | true | undefined;
    if (schema.additionalProperties === true) additionalProperties = true;
    else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const converted = this.toType(schema.additionalProperties);
      additionalProperties = converted.kind === "unknown" ? true : converted;
    }

    if (properties.length === 0 && additionalProperties === undefined) {
      // `type: object` with no shape info.
      return { kind: "object", properties: [], additionalProperties: true };
    }
    return { kind: "object", properties, additionalProperties };
  }
}

// --- helpers ---

function firstPathSegment(path: string): string {
  const segment = path.split("/").find((s) => s !== "" && !s.startsWith("{"));
  return segment ?? "default";
}

function docsFromSchema(schema: NormalizedSchema): IrDocs {
  return {
    description: schema.description,
    deprecated: schema.deprecated,
    example: schema.example,
    default: schema.default,
    format: schema.format !== undefined && schema.format !== "binary" ? schema.format : undefined,
    externalDocs: schema.externalDocs,
  };
}

interface SelectedContent {
  media: RawObject;
  bodyType: BodyType;
  warning?: string;
}

/** Pick the best content entry of a requestBody/response `content` map. */
function selectContent(content: RawObject): SelectedContent | undefined {
  const entries = Object.entries(content);
  if (entries.length === 0) return undefined;

  const find = (predicate: (mime: string) => boolean) =>
    entries.find(([mime]) => predicate(mime.toLowerCase().split(";")[0]!.trim()));

  const json = find((m) => m === "application/json" || m.endsWith("+json"));
  if (json) return { media: json[1] as RawObject, bodyType: "json" };

  const formData = find((m) => m === "multipart/form-data");
  if (formData) return { media: formData[1] as RawObject, bodyType: "form-data" };

  const urlEncoded = find((m) => m === "application/x-www-form-urlencoded");
  if (urlEncoded) return { media: urlEncoded[1] as RawObject, bodyType: "url-encoded" };

  const text = find((m) => m.startsWith("text/"));
  if (text) return { media: text[1] as RawObject, bodyType: "text" };

  // Anything else (images, octet-stream, pdf, ...) is treated as binary.
  const [mime, media] = entries[0]!;
  return {
    media: media as RawObject,
    bodyType: "binary",
    warning:
      entries.length > 1 ? `Multiple non-JSON content types; using "${mime}" as binary` : undefined,
  };
}

/** Stable structural key for hoisting; only plain objects with properties qualify. */
function hoistKey(schema: NormalizedSchema): string | undefined {
  if (schema.$ref !== undefined) return undefined;
  const isPlainObject =
    (schema.types === undefined || schema.types.every((t) => t === "object")) &&
    schema.properties !== undefined &&
    Object.keys(schema.properties).length > 0 &&
    !schema.allOf &&
    !schema.oneOf &&
    !schema.anyOf;
  if (!isPlainObject) return undefined;
  return stableStringify(schema);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function dedupeUnion(variants: IrType[]): IrType {
  const seen = new Set<string>();
  const unique = variants.filter((v) => {
    const key = JSON.stringify(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.length === 1 ? unique[0]! : { kind: "union", variants: unique };
}

function withNull(schema: NormalizedSchema, type: IrType): IrType {
  return withNullFlag(type, schema.types?.includes("null") ?? false);
}

function withNullFlag(type: IrType, nullable: boolean): IrType {
  if (!nullable) return type;
  const variants = type.kind === "union" ? [...type.variants] : [type];
  if (variants.some((v) => v.kind === "null")) return dedupeUnion(variants);
  return { kind: "union", variants: [...variants, { kind: "null" }] };
}

/** Collect the names of all `ref` types reachable from a type (non-recursive into targets). */
export function collectRefs(type: IrType, into = new Set<string>()): Set<string> {
  switch (type.kind) {
    case "ref":
      into.add(type.name);
      break;
    case "array":
      collectRefs(type.items, into);
      break;
    case "object":
      for (const prop of type.properties) collectRefs(prop.type, into);
      if (type.additionalProperties && type.additionalProperties !== true) {
        collectRefs(type.additionalProperties, into);
      }
      break;
    case "union":
      for (const variant of type.variants) collectRefs(variant, into);
      break;
    case "intersection":
      for (const member of type.members) collectRefs(member, into);
      break;
    default:
      break;
  }
  return into;
}
