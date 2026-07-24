# @narthia/openapi-sdk-generator

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
