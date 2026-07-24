---
"@narthia/openapi-sdk-generator": minor
---

Support generating SDKs for multiple OpenAPI specs into one output that shares a
single runtime. `generateSdk` now accepts either a single `input` (flat output,
unchanged) or an `inputs` map, where each key becomes a subfolder with its own
SDK, auth, and types while the client core + transports are emitted once at the
output root (`sdk/client`, `sdk/transport`). Options split into whole-run
`SharedOptions` (`output`, `runtime`, `transports`, `importExtension`,
`runtimePackage`) and per-input `TargetOptions` (`input`, `name`, `auth`,
`collisionCase`). Multiple inputs are configured programmatically or via a config
file's `inputs` map; shared CLI flags still override.
