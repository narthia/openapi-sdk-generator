# @narthia/openapi-sdk-generator

Generate a fully typed, JSDoc-documented TypeScript SDK from an OpenAPI 3.0/3.1 spec.

- **Rich IDE hover** — every service method and type carries JSDoc built from the spec's summaries, descriptions, `@param` docs, `@deprecated`, `@default`, `@format`, and `@see` links.
- **Modular runtime** — one import initializes the client, another provides the transport. HTTP (fetch) ships today; the `Transport` interface is designed so AWS Lambda, Atlassian Forge, and others slot in without regenerating.
- **Typed end to end** — path/query/header params, request bodies, and 2xx responses are all typed. Shared schemas live in a common types file; service-specific schemas live alongside their service.
- **Minimal dependencies** — hand-rolled spec parsing and emission; the CLI uses only Node built-ins.

## Install

```bash
npm install @narthia/openapi-sdk-generator
```

## Generate an SDK

### CLI

```bash
npx openapi-sdk-generator --input ./openapi.json --output ./src/sdk
```

| Flag                           | Description                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------ |
| `-i, --input <path\|url>`      | OpenAPI 3.0/3.1 spec — a JSON file path or an `http(s)` URL (**required**)     |
| `-o, --output <dir>`           | Directory to write the generated SDK into (**required**)                       |
| `-n, --name <name>`            | Name of the generated factory (default: `createSdk`)                           |
| `--runtime <pkg>`              | Runtime import specifier (default: `@narthia/openapi-sdk-generator`)           |
| `--import-ext <ext>`           | Relative-import extension in emitted code: `""`, `js`, or `ts` (default: `""`) |
| `-h, --help` / `-v, --version` | Show help / print version                                                      |

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

const pet = await client.pets.getPetById({ path: { petId: 42 } });
```

Method arguments are grouped by location, so hovering `getPetById` shows the full docs and types:

```ts
client.pets.listPets({ query: { limit: 10, tags: ["cute"] } });
client.pets.createPet({ body: { name: "Bella", status: "available" } });
```

Non-2xx responses throw an `ApiError` carrying the status, headers, and parsed body:

```ts
import { ApiError } from "@narthia/openapi-sdk-generator/client";

try {
  await client.pets.getPetById({ path: { petId: 999 } });
} catch (error) {
  if (error instanceof ApiError && error.status === 404) {
    // error.body is the parsed error payload
  }
}
```

### Generated output layout

```
sdk/
  index.ts              # createSdk(config) wiring all services
  services/<name>.ts    # one factory per tag/service, methods with JSDoc
  types/
    common.ts           # types shared by 2+ services
    <service>.ts        # types used by a single service
    index.ts            # barrel — import type { X } from "../types"
```

## Runtime architecture

The **client core does all OpenAPI-aware work** — path interpolation, query serialization, header/auth merging, body encoding, response decoding, and error normalization. A **transport** is a dumb executor that moves a prepared request to a backend:

```ts
interface Transport {
  request(req: TransportRequest): Promise<TransportResponse>;
}
```

Because generated code only ever talks to the client core, adding a new backend is a matter of implementing this one interface — no regeneration required. A future Lambda transport, for example:

```ts
import type { Transport } from "@narthia/openapi-sdk-generator/client";

function lambdaTransport(opts: { functionName: string; lambda: LambdaClient }): Transport {
  return {
    async request(req) {
      const payload = {
        httpMethod: req.method.toUpperCase(),
        path: req.path,
        queryStringParameters: Object.fromEntries(req.query),
        headers: req.headers,
        body: req.body?.toString() ?? null,
      };
      const out = await opts.lambda.send(
        new InvokeCommand({ FunctionName: opts.functionName, Payload: JSON.stringify(payload) })
      );
      const parsed = JSON.parse(new TextDecoder().decode(out.Payload));
      return {
        status: parsed.statusCode,
        headers: parsed.headers ?? {},
        text: async () => parsed.body ?? "",
        arrayBuffer: async () => new TextEncoder().encode(parsed.body ?? "").buffer,
      };
    },
  };
}
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

## License

MIT
