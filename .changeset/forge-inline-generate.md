---
"@narthia/openapi-sdk-generator": minor
---

Inline the Forge runtime in `runtime: "generate"` mode, so a generated Forge SDK is truly self-contained.

Previously the emitted `transports/forge.ts` always imported from `@narthia/openapi-sdk-generator/transports/forge`, even under `runtime: "generate"` - which contradicts that mode's promise of no dependency on this package. Forge now behaves like `http`:

- **`runtime: "generate"`** - the generic Forge runtime is copied to `transports/_forge.ts` and the product-bound `transports/forge.ts` imports that sibling. The copied file imports `@forge/api` directly (a bare specifier left untouched by the import rewrite), so the SDK references only `@forge/api`, never this package.
- **`runtime: "package"`** - unchanged: the wrapper imports from `@narthia/openapi-sdk-generator/transports/forge`.

Either way the consuming project still needs the `@forge/api` peer dependency, since the transport calls `api.asApp()` / `api.asUser()` / `assumeTrustedRoute()` at runtime in both modes.
