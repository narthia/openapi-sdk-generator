import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CleanMode } from "./clean.ts";
import type {
  CollisionCase,
  EmitContext,
  ResolvedAuth,
  ResolvedAuthScheme,
  ResolvedForge,
  RuntimeMode,
  TransportName,
} from "./emit/ts-writer.ts";
import type { IrAuthScheme } from "./ir.ts";
import type { SpecInput } from "./load.ts";
import { pruneGenerated, removeOutput } from "./clean.ts";
import { detectVersion } from "./detect.ts";
import { emitConfig } from "./emit/emit-config.ts";
import { emitIndex } from "./emit/emit-index.ts";
import { emitRuntime } from "./emit/emit-runtime.ts";
import { emitService } from "./emit/emit-service.ts";
import { emitTransportForge } from "./emit/emit-transport-forge.ts";
import { emitTransportHttp } from "./emit/emit-transport-http.ts";
import { emitTypesFolder, partitionSchemas } from "./emit/emit-types.ts";
import { buildIr } from "./ir.ts";
import { loadSpec } from "./load.ts";
import { kebabCase } from "./names.ts";

/** Transports the generator knows how to emit or import. */
const KNOWN_TRANSPORTS: readonly TransportName[] = ["http", "forge"];
const FORGE_PRODUCTS: readonly string[] = ["jira", "confluence", "bitbucket"];
const FORGE_IDENTITIES: readonly string[] = ["app", "user"];

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

/** Generate-time config for the http transport. */
export interface HttpTransportOption {
  /**
   * Auth the generated http transport exposes and applies. When omitted, auth
   * schemes are derived from the spec's `components.securitySchemes` (if any).
   */
  auth?: AuthOption;
}

/**
 * Generate-time config for the Atlassian Forge transport. The product can't be
 * inferred from an arbitrary OpenAPI spec, so it is required. Forge is always
 * imported from the package (it needs the `@forge/api` peer dependency) and is
 * never inlined, regardless of {@link SharedOptions.runtime}.
 */
export interface ForgeTransportOption {
  /** Atlassian product this SDK targets. */
  product: "jira" | "confluence" | "bitbucket";
  /**
   * Default identity for requests that don't select one per call. Baked into the
   * emitted wrapper; still overridable at construction and per call.
   * @default "app"
   */
  as?: "app" | "user";
}

/**
 * Which transports the generator emits, keyed by transport name. Presence of a
 * key enables that transport; its value is that transport's generate-time config
 * (`{}` = enabled with defaults). Omitting `transports` entirely enables `http`
 * with spec-derived auth.
 *
 * For multiple inputs, a top-level `transports` is the **shared** config: every
 * input that doesn't set its own `transports[<name>]` inherits it and joins a
 * group that shares one transport emitted at the output root (see
 * {@link generateSdk}). An input overrides a single transport by setting its own
 * config for that key; other shared transports are still inherited.
 */
export interface TransportsOption {
  http?: HttpTransportOption;
  forge?: ForgeTransportOption;
}

/** Options that apply to the whole generation run (shared across all inputs). */
export interface SharedOptions {
  /** Output directory. When omitted, files are only returned in memory. */
  output?: string;
  /**
   * How the output directory is cleaned before writing, so files from a previous
   * run (removed operations, renamed services, dropped inputs) never linger:
   * - `true` (default): remove the whole directory. Everything in it is deleted,
   *   so point {@link output} at a directory the generator owns.
   * - `false`: remove nothing; regenerated files are still overwritten, but
   *   stale ones from an earlier run remain.
   * - `"generated"`: remove only previously generated files that this run no
   *   longer emits (recognized by their header), then drop the directories left
   *   empty. Hand-written files are kept without having to be listed.
   *
   * Only affects what is written to disk, so it does nothing when {@link output}
   * is omitted.
   * @default true
   */
  clean?: CleanMode;
  /**
   * Whether every emitted file starts with the
   * `// Generated by @narthia/openapi-sdk-generator` header comment. Set to
   * `false` to omit it.
   *
   * Cannot be combined with `clean: "generated"`, which identifies the files it
   * may prune by that header.
   * @default true
   */
  header?: boolean;
  /**
   * Strip a `-SNAPSHOT-<sha>` build id from the API version documented on the
   * generated SDK factory, so regenerating from a redeployed spec does not churn
   * the output.
   *
   * Some providers publish `1001.0.0-SNAPSHOT-<git sha>`, where the suffix
   * changes on every deploy - and can differ between CDN edges at the same
   * moment - independently of any API change. With this on, that renders as
   * `1001.0.0`. Versions without the suffix, including a bare `-SNAPSHOT`, are
   * left alone.
   * @default false
   */
  normalizeVersion?: boolean;
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
   * - `"generate"` (default): emit it into the SDK folder (`client/`, `transports/`)
   *   so the output is self-contained with no dependency on this package. With
   *   multiple inputs, one shared runtime is emitted at the output root.
   * - `"package"`: import it from {@link runtimePackage} instead.
   * @default "generate"
   */
  runtime?: RuntimeMode;
  /**
   * Which transports the SDK emits, and their generate-time config. For multiple
   * inputs this is the **shared** config inherited by every input that doesn't
   * set its own (see {@link generateSdk}). Defaults to `{ http: {} }`.
   */
  transports?: TransportsOption;
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
   * Transports this input emits, and their generate-time config. For multiple
   * inputs, any transport set here overrides the shared top-level `transports`
   * for that key (the input keeps its own wrapper instead of the shared one);
   * transports not set here are still inherited from the shared config. Auth
   * lives under `transports.http.auth`.
   */
  transports?: TransportsOption;
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
  // Validate contradictory options up front, before any spec is fetched or parsed.
  if (options.header === false && options.clean === "generated") {
    throw new Error(
      '`clean: "generated"` recognizes the files it may prune by their generated header, so it cannot be combined with `header: false`. Use `clean: true` or `clean: false`.'
    );
  }

  const shared: SharedResolved = {
    runtimePackage: options.runtimePackage ?? "@narthia/openapi-sdk-generator",
    importExtension: options.importExtension ?? "",
    runtime: options.runtime ?? "generate",
    header: options.header ?? true,
    normalizeVersion: options.normalizeVersion ?? false,
  };
  const targets = normalizeTargets(options);

  // Shared transports (multi-input only): the top-level `transports` every input
  // inherits unless it sets its own for that key. Inherited transports are emitted
  // ONCE at the output root (`transports/<name>.ts`) instead of per input.
  const sharedTransports = "inputs" in options ? options.transports : undefined;
  validateTransports(sharedTransports, "transports");
  for (const target of targets) {
    validateTransports(
      target.transports,
      target.subdir === "" ? "transports" : `inputs.${target.subdir}.transports`
    );
  }

  // Decide, per target, which transports it emits itself vs inherits from the
  // shared root, and which transports are used anywhere (drives runtime inlining
  // and the root wrappers).
  const used = { http: false, forge: false };
  const root = { http: false, forge: false };
  const plans = targets.map((target) => {
    const plan = planTargetTransports(target.transports, sharedTransports);
    if (plan.ownHttp || plan.inheritHttp) used.http = true;
    if (plan.ownForge || plan.inheritForge) used.forge = true;
    if (plan.inheritHttp) root.http = true;
    if (plan.inheritForge) root.forge = true;
    return plan;
  });

  const files: GeneratedFile[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const { files: targetFiles, warnings: targetWarnings } = await generateTarget(
      targets[i]!,
      shared,
      plans[i]!
    );
    files.push(...targetFiles);
    warnings.push(...targetWarnings);
  }

  // Root wrappers shared by every input that inherited them. Resolved against no
  // spec schemes: shared config is explicit and spans multiple specs.
  const rootCtx = (extra: Partial<EmitContext>): EmitContext => ({
    ...shared,
    transports: [],
    sdkName: "createSdk",
    collisionCase: "snake_case",
    subdirDepth: 0,
    ...extra,
  });
  if (root.http && sharedTransports?.http) {
    const auth = resolveAuthModel(sharedTransports.http.auth, []);
    files.push({ path: "transports/http.ts", contents: emitTransportHttp(rootCtx({ auth })) });
  }
  if (root.forge && sharedTransports?.forge) {
    const forge = resolveForge(sharedTransports.forge);
    files.push({ path: "transports/forge.ts", contents: emitTransportForge(rootCtx({ forge })) });
  }

  // Self-contained mode: emit the shared client core + the runtime for every
  // transport used anywhere, once at the root. The forge runtime imports
  // `@forge/api` directly, so a generate-mode Forge SDK never references this package.
  if (shared.runtime === "generate") {
    const inline: TransportName[] = [];
    if (used.http) inline.push("http");
    if (used.forge) inline.push("forge");
    for (const [path, contents] of emitRuntime(rootCtx({ transports: inline }))) {
      files.push({ path, contents });
    }
  }

  if (options.output !== undefined) {
    // Drop stale files from a previous run (removed operations, renamed services,
    // dropped inputs) before writing. See `clean` for what each mode removes.
    const clean = options.clean ?? true;
    if (clean === "generated") {
      await pruneGenerated(options.output, new Set(files.map((f) => f.path)));
    } else if (clean) {
      await removeOutput(options.output);
    }
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
  header: boolean;
  normalizeVersion: boolean;
};

/**
 * Per-target transport plan: which transport wrappers a target emits itself
 * (`own*`) and which it inherits from the shared root and therefore skips
 * (`inherit*`). At most one of the two flags is set per transport.
 */
interface TargetTransportPlan {
  /** Emit an own `transports/http.ts` here, with this auth option (`undefined` → spec-derived). */
  ownHttp?: { auth: AuthOption | undefined };
  /** Emit an own `transports/forge.ts` here with this config. */
  ownForge?: ForgeTransportOption;
  /** Inherit the root `transports/http.ts` (emit nothing here). */
  inheritHttp?: boolean;
  /** Inherit the root `transports/forge.ts` (emit nothing here). */
  inheritForge?: boolean;
}

/**
 * Resolve a target's transport plan: for each transport, its own config wins;
 * otherwise it inherits the shared config for that key. When neither the target
 * nor the shared config names any transport, http is enabled by default (with
 * spec-derived auth).
 */
export function planTargetTransports(
  own: TransportsOption | undefined,
  shared: TransportsOption | undefined
): TargetTransportPlan {
  const keys = new Set([...Object.keys(own ?? {}), ...Object.keys(shared ?? {})]);
  if (keys.size === 0) return { ownHttp: { auth: undefined } };

  const plan: TargetTransportPlan = {};
  if (own?.http) plan.ownHttp = { auth: own.http.auth };
  else if (shared?.http) plan.inheritHttp = true;

  if (own?.forge) plan.ownForge = own.forge;
  else if (shared?.forge) plan.inheritForge = true;

  return plan;
}

/** Emit all files for one target, prefixing paths with its subfolder. */
async function generateTarget(
  target: Target,
  shared: SharedResolved,
  plan: TargetTransportPlan
): Promise<{ files: GeneratedFile[]; warnings: string[] }> {
  const spec = await loadSpec(target.input);
  const ir = buildIr(spec, detectVersion(spec));

  const ctx: EmitContext = {
    ...shared,
    transports: [],
    sdkName: target.name ?? "createSdk",
    collisionCase: target.collisionCase ?? "snake_case",
    auth: plan.ownHttp ? resolveAuthModel(plan.ownHttp.auth, ir.authSchemes) : undefined,
    forge: plan.ownForge ? resolveForge(plan.ownForge) : undefined,
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
  // A transport this target inherits from the shared root is emitted there, not here.
  if (plan.ownHttp) {
    files.push({ path: `${prefix}transports/http.ts`, contents: emitTransportHttp(ctx) });
  }
  if (plan.ownForge) {
    files.push({ path: `${prefix}transports/forge.ts`, contents: emitTransportForge(ctx) });
  }
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
      transports: options.transports,
      collisionCase: options.collisionCase,
      subdir: "",
    },
  ];
}

/** Validate a `transports` option: known keys only, and a well-formed forge config. */
export function validateTransports(option: TransportsOption | undefined, label: string): void {
  if (option === undefined) return;
  for (const key of Object.keys(option)) {
    if (!KNOWN_TRANSPORTS.includes(key as TransportName)) {
      throw new Error(
        `Unknown transport "${key}" in \`${label}\`; supported transports: ${KNOWN_TRANSPORTS.join(", ")}.`
      );
    }
  }
  if (option.forge) {
    const { product, as } = option.forge;
    if (!FORGE_PRODUCTS.includes(product)) {
      throw new Error(
        `\`${label}.forge.product\` must be one of ${FORGE_PRODUCTS.join(", ")} (got "${String(product)}").`
      );
    }
    if (as !== undefined && !FORGE_IDENTITIES.includes(as)) {
      throw new Error(
        `\`${label}.forge.as\` must be one of ${FORGE_IDENTITIES.join(", ")} (got "${String(as)}").`
      );
    }
  }
}

/** Resolve a {@link ForgeTransportOption} to its emitted form, applying the `as` default. */
export function resolveForge(option: ForgeTransportOption): ResolvedForge {
  return { product: option.product, as: option.as ?? "app" };
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
