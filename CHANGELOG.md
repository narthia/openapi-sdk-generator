# @narthia/openapi-sdk-generator

## 1.2.0

### Minor Changes

- 3e50509: Inline the Forge runtime in `runtime: "generate"` mode, so a generated Forge SDK is truly self-contained.

  Previously the emitted `transports/forge.ts` always imported from `@narthia/openapi-sdk-generator/transports/forge`, even under `runtime: "generate"` - which contradicts that mode's promise of no dependency on this package. Forge now behaves like `http`:

  - **`runtime: "generate"`** - the generic Forge runtime is copied to `transports/_forge.ts` and the product-bound `transports/forge.ts` imports that sibling. The copied file imports `@forge/api` directly (a bare specifier left untouched by the import rewrite), so the SDK references only `@forge/api`, never this package.
  - **`runtime: "package"`** - unchanged: the wrapper imports from `@narthia/openapi-sdk-generator/transports/forge`.

  Either way the consuming project still needs the `@forge/api` peer dependency, since the transport calls `api.asApp()` / `api.asUser()` / `assumeTrustedRoute()` at runtime in both modes.

## 1.1.0

### Minor Changes

- c8bf084: Nested `transports` config, Forge as a selectable transport, and shared transports across inputs (breaking, but the package is still early - few consumers to migrate).

  `transports` is now a map keyed by transport name, and each transport's generate-time config lives under its key. **Auth moves under `transports.http.auth`.** Presence of a key enables that transport; omitting `transports` still enables `http` with spec-derived auth.

  ```ts
  // before
  generateSdk({
    input,
    transports: ["http"],
    auth: { basic: { usernameField: "email" } },
  });

  // after
  generateSdk({
    input,
    transports: { http: { auth: { basic: { usernameField: "email" } } } },
  });
  ```

  **Forge is now selectable.** `transports: { forge: { product: "jira", as: "app" } }` emits a product-bound `transports/forge.ts` exposing a single `forge()` factory (and re-exporting `forgeAs`). Forge is imported from the package (`@narthia/openapi-sdk-generator/transports/forge`) and is never inlined, since it needs the `@forge/api` peer dependency. `product` is required (it can't be inferred from the spec).

  **Shared transports across multiple inputs.** For `inputs`, a top-level `transports` is the shared config: every input that doesn't set its own `transports[<name>]` inherits it and shares **one** transport emitted at the output root (`transports/http.ts`, `transports/forge.ts`) - import it once and reuse it across the grouped SDKs. An input overrides a single transport by setting its own config for that key; other shared transports are still inherited.

  ```ts
  generateSdk({
    output: "./sdk",
    transports: {
      http: {
        auth: { basic: { usernameField: "email", passwordField: "apiToken" } },
      },
    },
    inputs: {
      billing: { input: "./billing.json", name: "createBilling" }, // shares root transports/http.ts
      catalog: { input: "./catalog.json", name: "createCatalog" }, // shares root transports/http.ts
      reports: {
        input: "./reports.json",
        name: "createReports",
        transports: { http: { auth: { bearer: {} } } },
      }, // own
    },
  });
  ```

  **CLI.** `--transports` now lists transport names (`http`, `forge`); `--auth-*` feed `transports.http.auth`; new `--forge-product` / `--forge-as` configure forge. Multi-input (including the shared top-level `transports`) remains config-file only.

  **Migration**

  - Move `auth: X` to `transports: { http: { auth: X } }` (both `generateSdk` and config files).
  - Replace `transports: ["http"]` with `transports: { http: {} }` (usually just omit it - `http` is the default).
  - To generate a Forge SDK, add `transports: { forge: { product: "jira" } }` and import `forge` from `<sdk>/transports/forge`.

## 1.0.0

### Major Changes

- aa2ac5e: Transport-owned configuration (breaking). Backend-specific settings - `baseUrl`, `auth` - now live **on the transport** instead of the shared client config, and `transport` is required. This removes the awkward mix of cross-cutting and backend-specific fields on one config object and makes invalid combinations unrepresentable (a Forge SDK has no `baseUrl` field to set at all) rather than something the runtime has to reject.

  New Atlassian Forge transports are included: `forgeJira` / `forgeConfluence` / `forgeBitbucket` (+ `forgeAs`) from `@narthia/openapi-sdk-generator/transports/forge`, backed by the optional `@forge/api` peer dependency.

  **Migration**

  - The HTTP transport is now `http` (was `httpTransport`) and takes `baseUrl` + `auth`. For a generated SDK, import the spec-typed `http` from `<sdk>/transports/http` (named-scheme auth like `{ bearerAuth: token }`); the generic `http` from the package subpath takes the runtime shape `{ type: "bearer", token }`.
  - Move `baseUrl` and `auth` off `createSdk`/`createClient` and onto the transport.

  ```ts
  // before
  import { httpTransport } from "@narthia/openapi-sdk-generator/transports/http";
  const sdk = createSdk({
    baseUrl,
    auth: { bearerAuth: token },
    transport: httpTransport(),
  });

  // after
  import { http } from "./sdk/transports/http";
  const sdk = createSdk({
    transport: http({ baseUrl, auth: { bearerAuth: token } }),
  });
  ```

  - Generated output: auth codegen moved from `config.ts` to a new `transports/http.ts`; in `runtime: "generate"` mode the inlined generic transport is now `transports/_<name>.ts` (was `transport/<name>.ts`).
  - Runtime types removed from `@narthia/openapi-sdk-generator/client`: `ClientConfig` no longer has `baseUrl`/`auth`, `TransportRequest.baseUrl` is gone, and the `ForgeTransport`/`FORGE_TRANSPORT` guard scaffolding is deleted.

## 0.6.0

### Minor Changes

- 9137120: Add a `normalizeVersion` option that strips a `-SNAPSHOT-<sha>` build id from the API version documented on the generated SDK factory.

  Some providers append a per-deploy build id to `info.version`, publishing something like `1001.0.0-SNAPSHOT-<git sha>`, where the suffix changes on every redeploy - and can differ between CDN edges at the same moment - independently of any API change. Embedded verbatim, it makes every regeneration produce a one-line diff that reflects nothing but the build id.

  With `normalizeVersion: true` (or `--normalize-version`), `1001.0.0-SNAPSHOT-b5920d1e...` is documented as `1001.0.0`, so regenerating from a redeployed spec yields identical output. Only a trailing `-SNAPSHOT-<hex>` of at least seven characters (a git short sha) is removed; everything else passes through unchanged, including a bare `-SNAPSHOT`, which is stable across deploys and never causes churn.

  Defaults to `false`, so existing output is unaffected.

## 0.5.0

### Minor Changes

- 6058dc8: Add `clean: "generated"` and a `header` option, giving you control over what the generator prunes and whether emitted files carry its header comment.

  **`clean: "generated"`** prunes only the files the generator emitted. Every generated file starts with `// Generated by @narthia/openapi-sdk-generator. Do not edit manually.` In this mode the generator removes only files carrying that header which the current run no longer emits, then drops the directories left empty behind them. Hand-written files in the output directory are kept without having to be listed anywhere, so you get staleness cleanup and your own files side by side - which `clean: true` (deletes everything) and `clean: false` (deletes nothing, leaving stale files) could not offer together. Editing a generated file is fine, but stripping its header opts it out of pruning: the generator no longer recognizes it as its own.

  **`header: false`** (or `--no-header`) omits the header comment. Files then start directly at their first import, with no leading blank line, and nothing else about the output changes.

  The two options interact: `header: false` cannot be combined with `clean: "generated"`, which identifies the files it may prune by that header. The combination would silently prune nothing, so `generateSdk` rejects it up front with a clear error rather than degrading quietly. Use `clean: true` or `clean: false` alongside `header: false`.

  **Breaking (CLI):** `--clean <all|generated|none>` replaces the `--no-clean` flag, which has been removed. Replace `--no-clean` with `--clean none`. The programmatic `clean` option is unaffected: `true` and `false` keep working alongside the new `"generated"`.

## 0.4.0

### Minor Changes

- ac606bf: Add a `clean` option to control whether the output directory is emptied before generating.

  The output directory is still wiped by default, so files from a previous run (removed operations, renamed services, dropped inputs) never linger. Set `clean: false` (or pass `--no-clean` on the CLI) to write over the existing contents instead, leaving unrelated files in place - useful when the output directory also holds hand-maintained files. Regenerated files are overwritten either way.

  The cleanup step now also retries on transient filesystem errors, which Windows reports when an editor, watcher, or virus scanner is holding a generated file open.

## 0.3.1

### Patch Changes

- bfcf5b8: Fix two generator bugs that produced invalid or imprecise TypeScript for some specs:

  - **Reserved argument names in parameter collision handling.** An operation with a path or query parameter literally named `params`, `ctx`, or `options` emitted a destructured local that collided with the generated function's own arguments (e.g. `const { params } = params`), producing code that failed to compile. These identifiers are now reserved, so a colliding parameter is suffixed (e.g. `params_query`) while its wire name is preserved.

  - **Redundant `unknown` in response and schema unions.** When an operation had multiple success responses (or a schema used `oneOf`/`anyOf`) where one variant was untyped, the emitted union was `T | unknown`, which TypeScript collapses to `unknown` - silently erasing the useful type. Redundant `unknown` variants are now dropped whenever a concrete type is present, so response types like `Promise<T>` keep their precise type. All-unknown unions still resolve to `unknown`.

## 0.3.0

### Minor Changes

- 6e3c431: Support generating SDKs for multiple OpenAPI specs into one output that shares a
  single runtime. `generateSdk` now accepts either a single `input` (flat output,
  unchanged) or an `inputs` map, where each key becomes a subfolder with its own
  SDK, auth, and types while the client core + transports are emitted once at the
  output root (`sdk/client`, `sdk/transport`). Options split into whole-run
  `SharedOptions` (`output`, `runtime`, `transports`, `importExtension`,
  `runtimePackage`) and per-input `TargetOptions` (`input`, `name`, `auth`,
  `collisionCase`). Multiple inputs are configured programmatically or via a config
  file's `inputs` map; shared CLI flags still override.

## 0.2.0

### Minor Changes

- a6fd4c5: Tree-shakeable operations, a self-contained runtime, and transport selection.

  - Every operation is now emitted as a standalone `op(ctx, params, options)` function
    alongside the ergonomic `createSdk(...).service.op(params)` method, so bundlers can
    drop unused operations (`import { getPet } from "./sdk/services/pets"`).
  - A generated `config.ts` module exports a tailored `createClient` (and `SdkConfig`)
    that applies the configured auth (field renames + scheme selection). Both `createSdk`
    and the standalone path use it, so `createClient` from `./sdk/config` respects the same
    `auth` shape as `createSdk` (previously the raw `./sdk/client` `createClient` ignored it).
  - New `runtime` option (`"package" | "generate"`, default `"generate"`) and
    `--runtime-mode` flag. In the default `"generate"` mode the client core and
    selected transports are emitted into the SDK (`client/`, `transport/`), producing
    output with no dependency on this package. `"package"` keeps importing the runtime
    from `runtimePackage`.
  - New `transports` option and `--transports` flag select which transports to generate
    (default `["http"]`; the first is the default transport).

## 0.1.0

### Minor Changes

- c9c962e: Add config-file support. Keep all generation settings in an
  `openapi-sdk.config.{ts,mjs,js,json}` file (typed via the new `defineConfig`
  helper) and run the CLI with no flags - it auto-discovers the config in the
  working directory, or takes an explicit `--config <path>`. CLI flags override
  config values. Config files are loaded with native `import()` (no added
  dependency); `.ts` configs use Node's built-in type stripping (Node >= 22.6),
  while `.mjs`/`.js`/`.json` work on any supported Node.

## 0.0.1

### Patch Changes

- Initial Release
