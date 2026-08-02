---
"@narthia/openapi-sdk-generator": major
---

Transport-owned configuration (breaking). Backend-specific settings — `baseUrl`, `auth` — now live **on the transport** instead of the shared client config, and `transport` is required. This removes the awkward mix of cross-cutting and backend-specific fields on one config object and makes invalid combinations unrepresentable (a Forge SDK has no `baseUrl` field to set at all) rather than something the runtime has to reject.

New Atlassian Forge transports are included: `forgeJira` / `forgeConfluence` / `forgeBitbucket` (+ `forgeAs`) from `@narthia/openapi-sdk-generator/transports/forge`, backed by the optional `@forge/api` peer dependency.

**Migration**

- The HTTP transport is now `http` (was `httpTransport`) and takes `baseUrl` + `auth`. For a generated SDK, import the spec-typed `http` from `<sdk>/transports/http` (named-scheme auth like `{ bearerAuth: token }`); the generic `http` from the package subpath takes the runtime shape `{ type: "bearer", token }`.
- Move `baseUrl` and `auth` off `createSdk`/`createClient` and onto the transport.

```ts
// before
import { httpTransport } from "@narthia/openapi-sdk-generator/transports/http";
const sdk = createSdk({ baseUrl, auth: { bearerAuth: token }, transport: httpTransport() });

// after
import { http } from "./sdk/transports/http";
const sdk = createSdk({ transport: http({ baseUrl, auth: { bearerAuth: token } }) });
```

- Generated output: auth codegen moved from `config.ts` to a new `transports/http.ts`; in `runtime: "generate"` mode the inlined generic transport is now `transports/_<name>.ts` (was `transport/<name>.ts`).
- Runtime types removed from `@narthia/openapi-sdk-generator/client`: `ClientConfig` no longer has `baseUrl`/`auth`, `TransportRequest.baseUrl` is gone, and the `ForgeTransport`/`FORGE_TRANSPORT` guard scaffolding is deleted.
