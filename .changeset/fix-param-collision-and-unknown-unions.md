---
"@narthia/openapi-sdk-generator": patch
---

Fix two generator bugs that produced invalid or imprecise TypeScript for some specs:

- **Reserved argument names in parameter collision handling.** An operation with a path or query parameter literally named `params`, `ctx`, or `options` emitted a destructured local that collided with the generated function's own arguments (e.g. `const { params } = params`), producing code that failed to compile. These identifiers are now reserved, so a colliding parameter is suffixed (e.g. `params_query`) while its wire name is preserved.

- **Redundant `unknown` in response and schema unions.** When an operation had multiple success responses (or a schema used `oneOf`/`anyOf`) where one variant was untyped, the emitted union was `T | unknown`, which TypeScript collapses to `unknown` - silently erasing the useful type. Redundant `unknown` variants are now dropped whenever a concrete type is present, so response types like `Promise<T>` keep their precise type. All-unknown unions still resolve to `unknown`.
