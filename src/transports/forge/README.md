# Atlassian Forge transport

Run a generated SDK **inside an Atlassian Forge app**. Instead of the fetch-based `http` transport, a Forge transport routes each request through [`@forge/api`](https://developer.atlassian.com/platform/forge/runtime-reference/product-fetch-api/)'s product APIs (`asApp()`/`asUser()` → `requestJira`/`requestConfluence`/`requestBitbucket`), so there is **no `baseUrl` or `auth` to set** - Forge owns URL resolution and authentication.

```ts
import { createSdk } from "./sdk";
import { forgeJira, forgeAs } from "@narthia/openapi-sdk-generator/transports/forge";

const sdk = createSdk({ transport: forgeJira({ as: "app" }) });

// Per-call identity override (app vs user), fully typed:
await sdk.issues.getIssue({ issueIdOrKey: "ABC-1" }, forgeAs("user"));
```

`forgeConfluence` and `forgeBitbucket` work the same way.

## Install

`@forge/api` is an **optional peer dependency** - install it only in a Forge app (it resolves only inside the Forge runtime):

```bash
npm install @forge/api
```

## Auth context: `asApp()` vs `asUser()`

Every factory takes a default identity, and it can be overridden per call.

- **Transport-level default** - `forgeJira({ as: "app" })` (the default) or `forgeJira({ as: "user" })`.
- **Per-call override** - pass `forgeAs(...)` as a method's second `options` argument. This is a typed helper, so you get autocomplete on `"app" | "user"`:

```ts
await sdk.issues.getIssue({ issueIdOrKey: "ABC-1" }, forgeAs("user"));

// combine with other per-call options:
await sdk.issues.getIssue({ issueIdOrKey: "ABC-1" }, forgeAs("app", { signal }));
```

`forgeAs(as, options?)` returns `{ extensions: { forge: { as, accountId? } }, ...options }`. Under the hood the identity travels via the request's `extensions.forge`, which the transport reads per call.

### Offline user impersonation

`asUser()` acts as the current user (prompting for consent when needed). To act as a **specific** user without real-time interaction, pass an `accountId` - this uses Forge's [offline user impersonation](https://developer.atlassian.com/platform/forge/apis-reference/fetch-api-product.requestjira/) (`asUser(accountId)`):

```ts
await sdk.issues.getIssue({ issueIdOrKey: "ABC-1" }, forgeAs("user", { accountId: "5b10..." }));
```

> **Requires manifest opt-in.** Impersonation only works if your Forge app declares `allowImpersonation: true` for the scopes in use, and it's subject to Atlassian's [restrictions for offline impersonation](https://developer.atlassian.com/platform/forge/apis-reference/fetch-api-product.requestjira/). The transport just forwards the `accountId`; the platform enforces the gate. The app then sees only data that account can access.

## API

| Export            | Description                                                                  |
| ----------------- | ---------------------------------------------------------------------------- |
| `forgeJira`       | Transport for Jira REST APIs (`requestJira`).                                |
| `forgeConfluence` | Transport for Confluence REST APIs (`requestConfluence`).                    |
| `forgeBitbucket`  | Transport for Bitbucket REST APIs (`requestBitbucket`).                      |
| `forgeAs`         | Build a typed per-call `options` object selecting the `app`/`user` identity. |

Each factory takes `{ as?: "app" \| "user" }` (default `"app"`).

## Notes & limitations

- **No re-encoding.** The client core already interpolates path params (`encodeURIComponent`) and serializes the query, so the fully-encoded path is handed to Forge verbatim via `assumeTrustedRoute` - never re-encoded by Forge's `route` template.
- **Bodies.** Forge product requests accept `string` / `ArrayBuffer` / `URLSearchParams` bodies (the JSON case is a string). `Blob`/`FormData`/stream bodies are not supported.
- **`baseUrl`/`auth` don't apply.** Forge routes to the product and authenticates itself; there are no such options on a Forge transport.

For everything else - generating the SDK, the `http` transport, request options, tree-shaking - see the [main README](https://github.com/narthia/openapi-sdk-generator#readme).
