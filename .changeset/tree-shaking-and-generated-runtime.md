---
"@narthia/openapi-sdk-generator": minor
---

Tree-shakeable operations, a self-contained runtime, and transport selection.

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
