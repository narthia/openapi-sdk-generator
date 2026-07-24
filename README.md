# @narthia/openapi-sdk-generator

Generate a fully typed, JSDoc-documented TypeScript SDK from an OpenAPI 3.0/3.1 spec.

- **Rich IDE hover** - every service method and type carries JSDoc built from the spec's summaries, descriptions, `@param` docs, `@deprecated`, `@default`, `@format`, and `@see` links.
- **Modular runtime** - one import initializes the client, another provides the transport. HTTP (fetch) ships today; the `Transport` interface is designed so AWS Lambda, Atlassian Forge, and others slot in without regenerating.
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

| Flag                           | Description                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `-i, --input <path\|url>`      | OpenAPI 3.0/3.1 spec - a JSON file path or an `http(s)` URL (**required**)                        |
| `-o, --output <dir>`           | Directory to write the generated SDK into (**required**)                                          |
| `-n, --name <name>`            | Name of the generated factory (default: `createSdk`)                                              |
| `--runtime <pkg>`              | Runtime import specifier (default: `@narthia/openapi-sdk-generator`)                              |
| `--import-ext <ext>`           | Relative-import extension in emitted code: `""`, `js`, or `ts` (default: `""`)                    |
| `--collision-case <case>`      | Case for renamed colliding path/query params: `snake_case` or `camelCase` (default: `snake_case`) |
| `-h, --help` / `-v, --version` | Show help / print version                                                                         |

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
  services/<name>.ts    # one factory per tag/service, methods with JSDoc
  types/
    common.ts           # types shared by 2+ services
    <service>.ts        # types used by a single service
    index.ts            # barrel - import type { X } from "../types"
```

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
