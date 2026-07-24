import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CollisionCase,
  EmitContext,
  ResolvedAuth,
  ResolvedAuthScheme,
} from "./emit/ts-writer.ts";
import type { IrAuthScheme } from "./ir.ts";
import type { SpecInput } from "./load.ts";
import { detectVersion } from "./detect.ts";
import { emitIndex } from "./emit/emit-index.ts";
import { emitService } from "./emit/emit-service.ts";
import { emitTypesFolder, partitionSchemas } from "./emit/emit-types.ts";
import { buildIr } from "./ir.ts";
import { loadSpec } from "./load.ts";

/**
 * Generate-time auth configuration for the emitted SDK. Each present key enables
 * that auth scheme; a generated client uses exactly one of them (the config is a
 * flat object for a single scheme, or a discriminated union across several). The
 * nested field names are what the SDK consumer supplies, so they can be renamed
 * freely (e.g. basic's `username`/`password` → `email`/`apitoken`).
 */
export interface AuthOption {
  /** HTTP Basic auth (`Authorization: Basic <base64(user:pass)>`). */
  basic?: {
    /** Config field holding the username. @default "username" */
    usernameField?: string;
    /** Config field holding the password. @default "password" */
    passwordField?: string;
  };
  /** Bearer token (`Authorization: Bearer <token>`). */
  bearer?: {
    /** Config field holding the token. @default "token" */
    field?: string;
  };
  /** API key sent as a header or query parameter. */
  apiKey?: {
    in: "header" | "query";
    /** Header or query parameter name sent on the wire. */
    name: string;
    /** Config field holding the key value. @default "value" */
    field?: string;
  };
}

/** Options for {@link generateSdk}. */
export interface GenerateOptions {
  /** OpenAPI 3.0/3.1 spec: a file path, an http(s) URL, or an in-memory object. */
  input: SpecInput;
  /** Output directory. When omitted, files are only returned in memory. */
  output?: string;
  /**
   * Name of the generated SDK factory function.
   * @default "createSdk"
   */
  name?: string;
  /**
   * Import specifier for the runtime package in generated code.
   * @default "@narthia/openapi-sdk-generator"
   */
  runtimePackage?: string;
  /**
   * Extension appended to relative imports in emitted code: `""` (extensionless,
   * bundler-friendly), `"js"` (strict `nodenext` consumers), or `"ts"`.
   * @default ""
   */
  importExtension?: "" | "js" | "ts";
  /**
   * Case used to render a path/query param name that collides with another
   * param or a request-body property: `"snake_case"` → `status_query`,
   * `"camelCase"` → `statusQuery`. Request-body properties are never renamed.
   * @default "snake_case"
   */
  collisionCase?: CollisionCase;
  /**
   * Auth the generated SDK exposes and applies. When omitted, auth schemes are
   * derived from the spec's `components.securitySchemes` (if any); when neither
   * is present, the SDK config uses the generic runtime `ClientConfig` auth.
   */
  auth?: AuthOption;
}

export interface GeneratedFile {
  /** Path relative to the output directory, e.g. `types/common.ts`. */
  path: string;
  contents: string;
}

export interface GenerateResult {
  files: GeneratedFile[];
  /** Non-fatal warnings (naming collisions, skipped params, ...). */
  warnings: string[];
}

/**
 * Generate a fully typed, JSDoc-documented TypeScript SDK from an OpenAPI
 * 3.0/3.1 document.
 *
 * @example
 * ```ts
 * import { generateSdk } from "@narthia/openapi-sdk-generator";
 *
 * await generateSdk({
 *   input: "https://api.example.com/openapi.json",
 *   output: "./src/sdk",
 * });
 * ```
 */
export async function generateSdk(options: GenerateOptions): Promise<GenerateResult> {
  const spec = await loadSpec(options.input);
  const mode = detectVersion(spec);
  const ir = buildIr(spec, mode);

  const ctx: EmitContext = {
    runtimePackage: options.runtimePackage ?? "@narthia/openapi-sdk-generator",
    importExtension: options.importExtension ?? "",
    sdkName: options.name ?? "createSdk",
    collisionCase: options.collisionCase ?? "snake_case",
    auth: resolveAuthModel(options.auth, ir.authSchemes),
  };

  const partition = partitionSchemas(ir);
  const files: GeneratedFile[] = [];

  const typeFiles =
    ir.schemas.length > 0 ? emitTypesFolder(ir, partition, ctx) : new Map<string, string>();
  for (const [path, contents] of typeFiles) {
    files.push({ path, contents });
  }
  for (const service of ir.services) {
    files.push({
      path: `services/${service.fileName}.ts`,
      contents: emitService(service, ctx),
    });
  }
  files.push({ path: "index.ts", contents: emitIndex(ir, ctx, typeFiles.size > 0) });

  if (options.output !== undefined) {
    for (const file of files) {
      const target = join(options.output, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, "utf8");
    }
  }

  return { files, warnings: ir.warnings };
}

/**
 * Resolve the effective auth model: an explicit {@link AuthOption} wins; otherwise
 * fall back to schemes derived from the spec. Applies field-name defaults.
 * Returns `undefined` when there is no auth.
 */
export function resolveAuthModel(
  option: AuthOption | undefined,
  specSchemes: IrAuthScheme[]
): ResolvedAuth | undefined {
  const fromOption = option ? resolveOptionSchemes(option) : [];
  if (fromOption.length > 0) return { schemes: fromOption };

  if (specSchemes.length > 0) {
    // Prefer a friendly type-based key ("basic"/"bearer"/"apiKey"); fall back to
    // the securityScheme name only when a type appears more than once.
    const typeCounts = new Map<string, number>();
    for (const s of specSchemes) typeCounts.set(s.type, (typeCounts.get(s.type) ?? 0) + 1);
    const schemes = specSchemes.map((s) =>
      resolveSpecScheme(s, typeCounts.get(s.type) === 1 ? s.type : s.key)
    );
    return { schemes };
  }

  return undefined;
}

/** Build resolved schemes from the map option, in a stable order, applying field defaults. */
function resolveOptionSchemes(option: AuthOption): ResolvedAuthScheme[] {
  const schemes: ResolvedAuthScheme[] = [];
  if (option.basic) {
    schemes.push({
      type: "basic",
      key: "basic",
      usernameField: option.basic.usernameField ?? "username",
      passwordField: option.basic.passwordField ?? "password",
    });
  }
  if (option.bearer) {
    schemes.push({ type: "bearer", key: "bearer", field: option.bearer.field ?? "token" });
  }
  if (option.apiKey) {
    schemes.push({
      type: "apiKey",
      key: "apiKey",
      in: option.apiKey.in,
      name: option.apiKey.name,
      field: option.apiKey.field ?? "value",
    });
  }
  return schemes;
}

function resolveSpecScheme(scheme: IrAuthScheme, key: string): ResolvedAuthScheme {
  switch (scheme.type) {
    case "bearer":
      return { type: "bearer", key, field: "token" };
    case "apiKey":
      return {
        type: "apiKey",
        key,
        in: scheme.in,
        name: scheme.name,
        field: "value",
      };
    case "basic":
      return {
        type: "basic",
        key,
        usernameField: "username",
        passwordField: "password",
      };
  }
}
