---
"@narthia/openapi-sdk-generator": minor
---

Nested `transports` config, Forge as a selectable transport, and shared transports across inputs (breaking, but the package is still early - few consumers to migrate).

`transports` is now a map keyed by transport name, and each transport's generate-time config lives under its key. **Auth moves under `transports.http.auth`.** Presence of a key enables that transport; omitting `transports` still enables `http` with spec-derived auth.

```ts
// before
generateSdk({ input, transports: ["http"], auth: { basic: { usernameField: "email" } } });

// after
generateSdk({ input, transports: { http: { auth: { basic: { usernameField: "email" } } } } });
```

**Forge is now selectable.** `transports: { forge: { product: "jira", as: "app" } }` emits a product-bound `transports/forge.ts` exposing a single `forge()` factory (and re-exporting `forgeAs`). Forge is imported from the package (`@narthia/openapi-sdk-generator/transports/forge`) and is never inlined, since it needs the `@forge/api` peer dependency. `product` is required (it can't be inferred from the spec).

**Shared transports across multiple inputs.** For `inputs`, a top-level `transports` is the shared config: every input that doesn't set its own `transports[<name>]` inherits it and shares **one** transport emitted at the output root (`transports/http.ts`, `transports/forge.ts`) - import it once and reuse it across the grouped SDKs. An input overrides a single transport by setting its own config for that key; other shared transports are still inherited.

```ts
generateSdk({
  output: "./sdk",
  transports: { http: { auth: { basic: { usernameField: "email", passwordField: "apiToken" } } } },
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
