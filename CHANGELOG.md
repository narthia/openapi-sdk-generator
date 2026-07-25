# @narthia/openapi-sdk-generator

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
