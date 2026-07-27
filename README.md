# @narthia/openapi-sdk-generator

Generate a fully typed, JSDoc-documented TypeScript SDK from an OpenAPI 3.0/3.1 spec.

- **Rich IDE hover** - every service method and type carries JSDoc built from the spec's summaries, descriptions, `@param` docs, `@deprecated`, `@default`, `@format`, and `@see` links.
- **Modular runtime** - one import initializes the client, another provides the transport. HTTP (fetch) ships today; the `Transport` interface is designed so serverless invokes, in-platform bridges, and others slot in without regenerating.
- **Typed end to end** - path/query/header params, request bodies, and 2xx responses are all typed. Shared schemas live in a common types file; service-specific schemas live alongside their service.
- **Minimal dependencies** - hand-rolled spec parsing and emission; the CLI uses only Node built-ins.

## Install

```bash
npm install @narthia/openapi-sdk-generator
```

## Generate an SDK

### CLI

```bash
npx openapi-sdk-generator --input ./openapi.json --output ./src/sdk
```

| Flag                            | Description                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `-i, --input <path\|url>`       | OpenAPI 3.0/3.1 spec - a JSON file path or an `http(s)` URL (**required\***)                                                              |
| `-o, --output <dir>`            | Directory to write the generated SDK into (**required\***)                                                                                |
| `-c, --config <path>`           | Config file (default: auto-discover `openapi-sdk.config.{ts,mjs,js,json}`, see [Config file](#config-file))                               |
| `-n, --name <name>`             | Name of the generated factory (default: `createSdk`)                                                                                      |
| `--runtime-mode <mode>`         | `generate` (inline the runtime into the SDK) or `package` (import it) (default: `generate`, see [Runtime](#runtime-package-vs-generated)) |
| `--transports <list>`           | Comma-separated transports to generate; first is the default (default: `http`)                                                            |
| `--runtime <pkg>`               | Runtime import specifier used in `package` mode (default: `@narthia/openapi-sdk-generator`)                                               |
| `--import-ext <ext>`            | Relative-import extension in emitted code: `""`, `js`, or `ts` (default: `""`)                                                            |
| `--collision-case <case>`       | Case for renamed colliding path/query params: `snake_case` or `camelCase` (default: `snake_case`)                                         |
| `--clean <mode>`                | Output cleaning: `all`, `generated`, or `none` (default: `all`, see [Output cleaning](#output-cleaning))                                  |
| `--no-header`                   | Omit the generated-file header comment (see [File header](#file-header))                                                                  |
| `--normalize-version`           | Strip a `-SNAPSHOT-<sha>` build id from the documented API version (see [API version](#api-version))                                      |
| `--auth-type <list>`            | Comma-separated auth schemes to generate: `bearer`, `basic`, `apiKey` (see [Auth](#auth))                                                 |
| `--basic-username-field <name>` | Rename basic auth's `username` config field (e.g. `email`)                                                                                |
| `--basic-password-field <name>` | Rename basic auth's `password` config field (e.g. `apitoken`)                                                                             |
| `--bearer-field <name>`         | Rename the bearer `token` config field                                                                                                    |
| `--apikey-field <name>`         | Rename the apiKey `value` config field                                                                                                    |
| `--apikey-in <where>`           | apiKey location: `header` or `query` (default: `header`)                                                                                  |
| `--apikey-name <name>`          | apiKey header/query parameter name (required when generating an `apiKey` scheme)                                                          |
| `-h, --help` / `-v, --version`  | Show help / print version                                                                                                                 |

\* `input` and `output` may come from a [config file](#config-file) instead of flags; flags override the config.

### Config file

Keep all settings in a config file and run the CLI with no flags. `defineConfig` gives you full type-checking and autocomplete:

```ts
// openapi-sdk.config.ts
import { defineConfig } from "@narthia/openapi-sdk-generator";

export default defineConfig({
  input: "https://api.example.com/openapi.json",
  output: "./src/sdk",
  collisionCase: "snake_case",
  auth: { basic: { usernameField: "email", passwordField: "apiToken" } },
});
```

```bash
openapi-sdk-generator            # auto-discovers openapi-sdk.config.* in the cwd
openapi-sdk-generator -c ./sdk.config.ts   # or point at one explicitly
```

- **Discovery**: with no `--config`, the CLI looks for `openapi-sdk.config.{ts,mts,mjs,js,cjs,json}` in the working directory (first match wins).
- **Formats**: `.json`, `.mjs`, `.js`, `.cjs` work on any supported Node. A `.ts`/`.mts` config is loaded via Node's native type stripping, which needs **Node >= 22.6** - on older runtimes use `.mjs`/`.js`/`.json`. (No extra dependency is added for TS.)
- **Precedence**: CLI flags override config-file values; anything omitted in both falls back to the generator's defaults. The config accepts every [`generateSdk`](#programmatic) option.

### Programmatic

The `input` accepts a **file path, a URL, or an in-memory spec object**:

```ts
import { generateSdk } from "@narthia/openapi-sdk-generator";

const { files, warnings } = await generateSdk({
  input: "https://api.example.com/openapi.json", // or "./openapi.json", or a parsed object
  output: "./src/sdk", // omit to get files in memory only
});
```

Omit `output` to receive `files: { path, contents }[]` without writing to disk.

### Output cleaning

Stale files from a previous generation (removed operations, renamed services, dropped inputs) are cleared before each run. `clean` picks how:

| `clean`       | CLI                 | Removes                                                                      |
| ------------- | ------------------- | ---------------------------------------------------------------------------- |
| `true`        | `--clean all`       | The whole output directory (default). Point `output` at a directory you own. |
| `"generated"` | `--clean generated` | Only files this generator emitted and this run no longer produces.           |
| `false`       | `--clean none`      | Nothing. Regenerated files are still overwritten; stale ones stay.           |

**Keeping hand-written files next to the SDK** - use `"generated"`. The generator prunes only what it recognizes as its own by the [file header](#file-header) and leaves everything else alone. Nothing has to be listed:

```ts
await generateSdk({
  input: "./openapi.json",
  output: "./src/sdk",
  clean: "generated",
});
```

```
src/sdk/
  index.ts services/*.ts types/*.ts   # generated - pruned when no longer emitted
  helpers.ts                          # yours - untouched
```

Directories left empty after pruning are removed too. Editing a generated file is fine, but **stripping its header opts it out of pruning**: the generator no longer recognizes it, so it survives as a stale file (and is still overwritten if this run emits that same path). For the same reason, `"generated"` cannot be combined with `header: false` - the generator throws rather than silently pruning nothing.

### File header

Every emitted file starts with this line, followed by a blank line:

```ts
// Generated by @narthia/openapi-sdk-generator. Do not edit manually.
```

Set `header: false` (or pass `--no-header`) to omit it. Files then start directly at their first import, with no leading blank line; nothing else about the output changes.

```ts
await generateSdk({
  input: "./openapi.json",
  output: "./src/sdk",
  header: false,
});
```

The header is what [`clean: "generated"`](#output-cleaning) uses to tell generated files from your own, so the two cannot be combined:

```ts
// Throws: pruning would have nothing to recognize.
await generateSdk({ input, output, header: false, clean: "generated" });
```

Use `clean: true` or `clean: false` alongside `header: false`.

### API version

The generated SDK factory documents the spec's `info.version`:

```ts
/**
 * Create a `Petstore API` SDK client (API version 1.0.0).
 */
export function createSdk(config: SdkConfig = {}) {
```

Some providers append a per-deploy build id to that version, publishing something like `1001.0.0-SNAPSHOT-<git sha>`, where the suffix changes on every redeploy - and can differ between CDN edges at the same moment - independently of any API change. Embedded verbatim, it makes every regeneration produce a one-line diff that reflects nothing but the build id.

Set `normalizeVersion: true` (or pass `--normalize-version`) to strip it, so the output is deterministic:

```ts
await generateSdk({
  input: "https://example.com/openapi.json",
  output: "./src/sdk",
  normalizeVersion: true, // 1001.0.0-SNAPSHOT-b5920d1e... -> 1001.0.0
});
```

Only a trailing `-SNAPSHOT-<hex>` of at least seven characters (a git short sha) is removed. Everything else passes through, including a bare `-SNAPSHOT`, which is stable across deploys and so never causes churn:

| `info.version`                       | With `normalizeVersion: true` |
| ------------------------------------ | ----------------------------- |
| `1001.0.0-SNAPSHOT-b5920d1eaef179a2` | `1001.0.0`                    |
| `1001.0.0-SNAPSHOT`                  | unchanged                     |
| `1.0.0-SNAPSHOT-rc2`                 | unchanged                     |
| `1.2.3-beta.1`                       | unchanged                     |

### Multiple inputs (one shared runtime)

For several related APIs (e.g. a billing API plus a catalog API), pass an `inputs` map instead of a single `input`. Each key becomes a subfolder with its own SDK, auth, and types, and they **share one emitted runtime** at the output root (no per-input copy):

```ts
await generateSdk({
  output: "./src/sdk",
  inputs: {
    billing: {
      input: "./billing.json",
      name: "createBilling",
      auth: { basic: { usernameField: "email", passwordField: "apiToken" } },
    },
    catalog: {
      input: "./catalog.json",
      name: "createCatalog",
      auth: { bearer: {} },
    },
  },
});
```

```
sdk/
  client/  transport/http.ts   # shared runtime, emitted once
  billing/  index.ts config.ts services/*.ts types/*.ts
  catalog/  index.ts config.ts services/*.ts types/*.ts
```

Then import per input: `import { createBilling } from "./sdk/billing"`, `import { getInvoice } from "./sdk/billing/services/invoices"`.

- `input` and `inputs` are mutually exclusive; a single `input` keeps the flat layout (no subfolder).
- **Shared** across all inputs: `output`, `clean`, `header`, `normalizeVersion`, `runtime`, `transports`, `importExtension`, `runtimePackage`. **Per input**: `input`, `name`, `auth`, `collisionCase`.
- Via the CLI, multiple inputs are configured through a [config file](#config-file)'s `inputs` map (shared flags still override); the per-input flags apply only to a single `--input` run.

## Use the generated SDK

Two imports: one to initialize the client, one for the transport.

```ts
import { createSdk } from "./sdk";
import { httpTransport } from "@narthia/openapi-sdk-generator/transports/http";

const client = createSdk({
  baseUrl: "https://api.example.com",
  transport: httpTransport(), // this is also the default if omitted
  auth: { type: "bearer", token: () => getAccessToken() },
});

const pet = await client.pets.getPetById({ petId: 42 });
```

Each method takes **two arguments**: the **data** first (path params, query params, and the request body's own properties, all merged into one flat object), and an optional **`options`** second (per-request `headers`, `signal`, `extensions`):

```ts
client.pets.listPets({ limit: 10, tags: ["cute"] }); // path + query
client.pets.createPet({ name: "Bella", status: "available" }); // body properties, spread
```

The second `options` argument keeps request controls out of your data. `headers` is available on **every** method - it overrides or adds to the client's default headers for that one call:

```ts
client.pets.getPetById({ petId: 42 }, { headers: { "X-Request-ID": "abc" }, signal: ac.signal });
```

Operations with no path/query/body take only the `options` argument (e.g. `client.health.getHealth({ signal })`).

**Name collisions** - if a path or query param shares a name with a body property (or with each other), the _param_ is suffixed with its location (`status_query`, `id_path`); body properties always keep their exact names. For example, a `status` path param alongside a `status` body field becomes `{ status_path, status }` in the data object. The suffix case is configurable via the `collisionCase` option (`generateSdk`) / `--collision-case` flag: `"snake_case"` (default, `status_query`) or `"camelCase"` (`statusQuery`).

Non-object bodies (binary uploads, arrays) can't be spread, so they stay under a single `body` key in the data object. Non-2xx responses throw an `ApiError` carrying the status, headers, and parsed body:

```ts
import { ApiError } from "@narthia/openapi-sdk-generator/client";

try {
  await client.pets.getPetById({ petId: 999 });
} catch (error) {
  if (error instanceof ApiError && error.status === 404) {
    // error.body is the parsed error payload
  }
}
```

### Request options (`signal`, `extensions`)

The second `options` argument also carries two request controls.

**`signal`** is a standard `AbortSignal` for cancelling or timing out a request (it is passed straight to the transport):

```ts
// Time out after 5s
await client.pets.getPetById({ petId: 42 }, { signal: AbortSignal.timeout(5000) });

// Cancel a superseded request (e.g. search-as-you-type)
const ac = new AbortController();
const promise = client.pets.listPets({ tags: [term] }, { signal: ac.signal });
ac.abort(); // rejects `promise` with an AbortError
```

**`extensions`** is an open bag passed verbatim to the transport for per-call, transport-specific options. The HTTP transport reads `extensions.fetchOptions` and merges it into that single `fetch` call (overriding any `fetchOptions` set on the transport itself):

```ts
// Bypass the HTTP cache for one call
await client.pets.listPets({ limit: 10 }, { extensions: { fetchOptions: { cache: "no-store" } } });

// Next.js per-request revalidation
await client.pets.getPetById(
  { petId: 42 },
  {
    extensions: { fetchOptions: { next: { revalidate: 60 } } },
  }
);
```

A different transport defines its own `extensions` shape (e.g. a Lambda transport could read `extensions.qualifier`), so the generated SDK never has to change to pass a transport a per-call hint.

### Reuse the client (initialize once)

Create the client **once** and import it everywhere - it holds no per-request state, so a single instance is safe to share across your whole app and across concurrent requests. You do **not** re-initialize per call.

```ts
// lib/api.ts
import { createSdk } from "../sdk";
import { httpTransport } from "@narthia/openapi-sdk-generator/transports/http";

export const api = createSdk({
  baseUrl: process.env.API_URL,
  transport: httpTransport(),
  // A function is resolved per request, so a long-lived client keeps working as tokens rotate.
  auth: { type: "bearer", token: () => getAccessToken() },
});
```

```ts
// anywhere else
import { api } from "./lib/api";
const pet = await api.pets.getPetById({ petId: 42 });
```

Anything that varies per request goes in the second `options` argument (`headers`, `signal`) - not in a new client. Create more than one instance only when the **client-level** config genuinely differs (a different `baseUrl`, transport, or auth identity); reuse each of those too.

### Generated output layout

```
sdk/
  index.ts              # createSdk(config) wiring all services
  config.ts             # createClient + SdkConfig (applies your auth); tree-shakeable entry
  services/<name>.ts    # standalone op functions + one factory per tag/service
  types/
    common.ts           # types shared by 2+ services
    <service>.ts        # types used by a single service
    index.ts            # barrel - import type { X } from "../types"
  client/               # generate mode only: the inlined runtime core
  transport/<name>.ts   # generate mode only: the inlined transport(s)
```

## Runtime: package vs generated

By default the SDK is **self-contained**: the runtime (client core + transport) is emitted into the output (`client/`, `transport/`), so the generated code has **no dependency** on this package. Control it with `runtime` (`generateSdk`) or `--runtime-mode`:

- `"generate"` (default) - inline the runtime. Imports resolve to `./client` and `./transport/http`; nothing points at `@narthia/openapi-sdk-generator`.
- `"package"` - import the runtime from the package (`runtimePackage`, default `@narthia/openapi-sdk-generator`). Smaller output; the consumer installs this package. Use when you generate several SDKs in one app and want a single shared runtime.

```ts
await generateSdk({ input, output }); // self-contained (default)
await generateSdk({ input, output, runtime: "package" }); // import from the package
```

`transports` selects which transports to inline in `"generate"` mode (default `["http"]`); the first entry is the default transport. In `"package"` mode transports are imported from the package instead.

## Tree-shaking

Each operation is emitted **twice**: as a method on the ergonomic `createSdk` object, and as a **standalone function** that takes the client as its first argument. Bundlers can drop unused module exports (but not unused object properties), so importing standalone functions bundles only what you call:

```ts
// Ergonomic - convenient, but pulls in every service/method:
const pet = await createSdk(config).pets.getPetById({ petId: 42 });

// Tree-shakeable - only getPetById (and the runtime) end up in your bundle:
import { createClient } from "./sdk/config";
import { getPetById } from "./sdk/services/pets";

const ctx = createClient({ baseUrl, auth: { email, apiToken } });
const pet = await getPetById(ctx, { petId: 42 });
```

Import `createClient` from **`./sdk/config`** (not `./sdk/client`): the `config` module applies your generated auth (field renames + scheme selection), so `createClient` there accepts the same tailored `auth` as `createSdk`. It's a service-free module, so importing it stays tree-shakeable. `import * as pets from "./sdk/services/pets"` then `pets.getPetById(ctx, ...)` tree-shakes too. The standalone functions take `ctx` first (you can't have both a no-client-argument call and tree-shaking); `createSdk` remains for the grouped, no-`ctx` ergonomics.

## Auth

By default `createSdk` accepts the runtime's generic `auth` config (a single `bearer`, `apiKey`, or `basic` scheme), as shown above. You can instead **bake the auth surface into the generated SDK** so the config fields are named for your API and only the schemes you support are allowed. A generated client uses **one** auth scheme (see [Multiple schemes](#multiple-schemes) for how the caller picks).

Configure it with the `auth` option (`generateSdk`) or the `--auth-*` flags. `auth` is a map keyed by scheme; each entry's field names are yours to choose - for example, rename basic auth's `username`/`password` to `email`/`apitoken`:

```ts
await generateSdk({
  input: "./openapi.json",
  output: "./src/sdk",
  auth: { basic: { usernameField: "email", passwordField: "apitoken" } },
});
```

```bash
openapi-sdk-generator -i ./openapi.json -o ./src/sdk \
  --auth-type basic --basic-username-field email --basic-password-field apitoken
```

A **single** scheme produces a flat config (no discriminant):

```ts
const client = createSdk({ auth: { email: "me@example.com", apitoken: "secret" } });
```

Default field names per type: bearer -> `token`, apiKey -> `value`, basic -> `username` / `password`. Rename any of them with `field` (bearer/apiKey), `usernameField` / `passwordField` (basic), or the matching CLI flags. `apiKey` also needs `in` (`header` or `query`) and the wire `name`.

### Multiple schemes

List more than one entry in the map when an API supports several auth methods. The generated config becomes a **discriminated union** - the caller picks exactly one at init, and only it is applied:

```ts
auth: {
  basic: {},
  bearer: { field: "accessToken" },
};
// -> createSdk({ auth: { type: "bearer", accessToken: "..." } })
//    or createSdk({ auth: { type: "basic", username: "...", password: "..." } })
```

Each scheme is keyed by its `type` (`basic`, `bearer`, `apiKey`), so the map holds at most one of each. Schemes derived from the spec key off their `type` too, falling back to the `securitySchemes` name only when a type appears more than once.

**Two credentials at once?** A generated client applies a single scheme, so APIs that require _two_ credentials per request (e.g. an Azure API Management subscription key plus a bearer token) aren't modelled by `auth`. Supply the second credential with a default `headers` entry on `createSdk`, or inject/sign it in `onRequest`.

### Derived from the spec

When you pass no `auth` option, schemes are derived automatically from the spec's `components.securitySchemes` (`http`/`bearer`, `http`/`basic`, and `apiKey`; `oauth2` / `openIdConnect` are treated as a bearer token), with default field names. Passing an explicit `auth` option overrides this entirely. If neither is present, the generated config falls back to the runtime's generic `auth`.

## Runtime architecture

The **client core does all OpenAPI-aware work** - path interpolation, query serialization, header/auth merging, body encoding, response decoding, and error normalization. A **transport** is a dumb executor that moves a prepared request to a backend:

```ts
interface Transport {
  request(req: TransportRequest): Promise<TransportResponse>;
}
```

Because generated code only ever talks to the client core, a transport can be a brand-new backend **or** a wrapper that adds behavior around another transport - no regeneration required. For example, a retry transport that wraps the built-in HTTP one and retries network errors and `5xx` responses with exponential backoff:

```ts
import { httpTransport } from "@narthia/openapi-sdk-generator/transports/http";
import type { Transport } from "@narthia/openapi-sdk-generator/client";

function withRetry(inner: Transport, retries = 3): Transport {
  return {
    async request(req) {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await inner.request(req);
          if (res.status < 500 || attempt === retries) return res;
        } catch (error) {
          if (attempt === retries) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100));
      }
    },
  };
}

// Compose it with the built-in HTTP transport - the generated SDK is unchanged:
const client = createSdk({ transport: withRetry(httpTransport()) });
```

## Exports

| Import                                           | Purpose                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| `@narthia/openapi-sdk-generator`                 | The generator: `generateSdk()`                      |
| `@narthia/openapi-sdk-generator/client`          | Runtime core: `createClient`, `ApiError`, and types |
| `@narthia/openapi-sdk-generator/transports/http` | Fetch-based `httpTransport()`                       |

## Current limitations

- JSON specs only (YAML support is planned; it is isolated to the loader).
- Query serialization supports the OpenAPI default `form`/`explode`; other styles emit a warning and fall back to it.
- Non-2xx response bodies are surfaced on `ApiError.body` but are not individually typed.
- Flat data object: a body with `additionalProperties` is still spread, but an open-map key matching a path/query param name can't be disambiguated (known properties are handled via the suffix scheme). Request controls (`headers`/`signal`/`extensions`) live in the separate `options` argument, so they never collide with body/query/path data.

## License

MIT
