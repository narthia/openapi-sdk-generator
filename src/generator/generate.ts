import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CollisionCase,
  EmitContext,
  ResolvedAuth,
  ResolvedAuthScheme,
  RuntimeMode,
  TransportName,
} from "./emit/ts-writer.ts";
import type { IrAuthScheme } from "./ir.ts";
import type { SpecInput } from "./load.ts";
import { detectVersion } from "./detect.ts";
import { emitConfig } from "./emit/emit-config.ts";
import { emitIndex } from "./emit/emit-index.ts";
import { emitRuntime } from "./emit/emit-runtime.ts";
import { emitService } from "./emit/emit-service.ts";
import { emitTypesFolder, partitionSchemas } from "./emit/emit-types.ts";
import { buildIr } from "./ir.ts";
import { loadSpec } from "./load.ts";
import { kebabCase } from "./names.ts";

/** Transports the generator knows how to emit or import. */
const KNOWN_TRANSPORTS: readonly TransportName[] = ["http"];

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

/** Options that apply to the whole generation run (shared across all inputs). */
export interface SharedOptions {
  /** Output directory. When omitted, files are only returned in memory. */
  output?: string;
  /**
   * Import specifier for the runtime package in generated code (used in `"package"` mode).
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
   * Where the runtime (client core + transports) lives:
   * - `"generate"` (default): emit it into the SDK folder (`client/`, `transport/`)
   *   so the output is self-contained with no dependency on this package. With
   *   multiple inputs, one shared runtime is emitted at the output root.
   * - `"package"`: import it from {@link runtimePackage} instead.
   * @default "generate"
   */
  runtime?: RuntimeMode;
  /**
   * Transports emitted into the SDK in `"generate"` mode; the first entry is the
   * default transport. Ignored in `"package"` mode (transports are imported from
   * the package there).
   * @default ["http"]
   */
  transports?: TransportName[];
}

/** Options for a single generated SDK (one OpenAPI spec). */
export interface TargetOptions {
  /** OpenAPI 3.0/3.1 spec: a file path, an http(s) URL, or an in-memory object. */
  input: SpecInput;
  /**
   * Name of the generated SDK factory function.
   * @default "createSdk"
   */
  name?: string;
  /**
   * Auth the generated SDK exposes and applies. When omitted, auth schemes are
   * derived from the spec's `components.securitySchemes` (if any); when neither
   * is present, the SDK config uses the generic runtime `ClientConfig` auth.
   */
  auth?: AuthOption;
  /**
   * Case used to render a path/query param name that collides with another
   * param or a request-body property: `"snake_case"` → `status_query`,
   * `"camelCase"` → `statusQuery`. Request-body properties are never renamed.
   * @default "snake_case"
   */
  collisionCase?: CollisionCase;
}

/**
 * Options for {@link generateSdk}. Pass a single `input` (flat output under the
 * output root) or an `inputs` map (each key becomes a subfolder that shares one
 * emitted runtime). The two shapes are mutually exclusive.
 */
export type GenerateOptions =
  | (SharedOptions & TargetOptions & { inputs?: never })
  | (SharedOptions & {
      /** One named SDK per key; each is emitted under `<kebab-key>/` sharing the root runtime. */
      inputs: Record<string, TargetOptions>;
      input?: never;
      name?: never;
      auth?: never;
      collisionCase?: never;
    });

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
  const shared = {
    runtimePackage: options.runtimePackage ?? "@narthia/openapi-sdk-generator",
    importExtension: options.importExtension ?? "",
    runtime: options.runtime ?? "generate",
    transports: resolveTransports(options.transports),
  } as const;
  const targets = normalizeTargets(options);

  const files: GeneratedFile[] = [];
  const warnings: string[] = [];
  for (const target of targets) {
    const { files: targetFiles, warnings: targetWarnings } = await generateTarget(target, shared);
    files.push(...targetFiles);
    warnings.push(...targetWarnings);
  }

  // Self-contained mode: emit the shared client core + transports once at the root.
  if (shared.runtime === "generate") {
    const runtimeCtx: EmitContext = {
      ...shared,
      sdkName: "createSdk",
      collisionCase: "snake_case",
      subdirDepth: 0,
    };
    for (const [path, contents] of emitRuntime(runtimeCtx)) files.push({ path, contents });
  }

  if (options.output !== undefined) {
    // Wipe the output directory so stale files from a previous run (removed
    // operations, renamed services, dropped inputs) never linger.
    await rm(options.output, { recursive: true, force: true });
    for (const file of files) {
      const outPath = join(options.output, file.path);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, file.contents, "utf8");
    }
  }

  return { files, warnings };
}

/** One SDK to generate: a spec plus its per-target options and output subfolder. */
interface Target extends TargetOptions {
  /** Output subfolder (`""` for a single/flat SDK, else the kebab-cased input key). */
  subdir: string;
}

/** Shared (whole-run) options, with defaults applied. */
type SharedResolved = {
  runtimePackage: string;
  importExtension: "" | "js" | "ts";
  runtime: RuntimeMode;
  transports: TransportName[];
};

/** Emit all files for one target, prefixing paths with its subfolder. */
async function generateTarget(
  target: Target,
  shared: SharedResolved
): Promise<{ files: GeneratedFile[]; warnings: string[] }> {
  const spec = await loadSpec(target.input);
  const ir = buildIr(spec, detectVersion(spec));

  const ctx: EmitContext = {
    ...shared,
    sdkName: target.name ?? "createSdk",
    collisionCase: target.collisionCase ?? "snake_case",
    auth: resolveAuthModel(target.auth, ir.authSchemes),
    subdirDepth: target.subdir === "" ? 0 : 1,
  };

  const prefix = target.subdir === "" ? "" : `${target.subdir}/`;
  const files: GeneratedFile[] = [];
  const partition = partitionSchemas(ir);

  const typeFiles =
    ir.schemas.length > 0 ? emitTypesFolder(ir, partition, ctx) : new Map<string, string>();
  for (const [path, contents] of typeFiles) files.push({ path: `${prefix}${path}`, contents });
  for (const service of ir.services) {
    files.push({
      path: `${prefix}services/${service.fileName}.ts`,
      contents: emitService(service, ctx),
    });
  }
  files.push({ path: `${prefix}config.ts`, contents: emitConfig(ctx) });
  files.push({ path: `${prefix}index.ts`, contents: emitIndex(ir, ctx, typeFiles.size > 0) });

  return { files, warnings: ir.warnings };
}

/** Normalize the single-or-multi options into a list of targets (validated). */
export function normalizeTargets(options: GenerateOptions): Target[] {
  if ("inputs" in options && options.inputs !== undefined) {
    if ("input" in options && options.input !== undefined) {
      throw new Error("Pass either `input` (single) or `inputs` (multiple), not both.");
    }
    const entries = Object.entries(options.inputs);
    if (entries.length === 0) throw new Error("`inputs` must contain at least one entry.");

    const seen = new Set<string>();
    return entries.map(([key, target]) => {
      const subdir = kebabCase(key);
      if (subdir === "")
        throw new Error(`Invalid input key "${key}": produces an empty folder name.`);
      if (seen.has(subdir)) {
        throw new Error(`Input keys "${key}" and another collide on folder "${subdir}".`);
      }
      seen.add(subdir);
      return { ...target, subdir };
    });
  }

  if (!("input" in options) || options.input === undefined) {
    throw new Error("Provide `input` (single) or `inputs` (multiple).");
  }
  return [
    {
      input: options.input,
      name: options.name,
      auth: options.auth,
      collisionCase: options.collisionCase,
      subdir: "",
    },
  ];
}

/** Validate and default the `transports` option against the known set. */
export function resolveTransports(transports: TransportName[] | undefined): TransportName[] {
  if (transports === undefined) return ["http"];
  if (transports.length === 0) {
    throw new Error("`transports` must list at least one transport.");
  }
  for (const name of transports) {
    if (!KNOWN_TRANSPORTS.includes(name)) {
      throw new Error(
        `Unknown transport "${name}"; supported transports: ${KNOWN_TRANSPORTS.join(", ")}.`
      );
    }
  }
  return transports;
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
