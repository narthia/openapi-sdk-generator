---
"@narthia/openapi-sdk-generator": patch
---

Fix `allOf` members that carry only annotations producing redundant `unknown` intersections and losing their docs.

The common spec idiom for attaching a description to a `$ref` — `allOf: [{ $ref: "..." }, { description: "..." }]` — generated `Foo & unknown` (which lints as `no-redundant-type-constituents`) and dropped the description entirely, since it lived on the nested member rather than the property itself.

Normalization now folds annotation-only `allOf` members (no `$ref`, `type`, `enum`, `properties`, `items`, `additionalProperties`, or nested combinator) into their parent: their `description`, `title`, `example`, `default`, `deprecated`, `format`, and `externalDocs` are lifted where the parent has none of its own, and the member is dropped. `accessLevel: AccessLevel & unknown` now emits as a documented `accessLevel: AccessLevel`.

Intersections also collapse duplicate and `unknown` members, mirroring the existing union handling, so any remaining `T & unknown` from inline-resolved pointers prints as `T`.
