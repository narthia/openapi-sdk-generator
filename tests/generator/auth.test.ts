import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import type { Transport } from "../../src/client/index.ts";
import type { IrAuthScheme } from "../../src/generator/ir.ts";
import type { AuthOption } from "../../src/index.ts";
import { resolveAuthModel } from "../../src/generator/generate.ts";
import { generateSdk } from "../../src/index.ts";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** A tiny spec with one operation, plus optional securitySchemes. */
function spec(securitySchemes?: Record<string, unknown>): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    info: { title: "Auth API", version: "1.0.0" },
    paths: {
      "/ping": {
        get: { operationId: "ping", tags: ["main"], responses: { "200": { description: "ok" } } },
      },
    },
    ...(securitySchemes ? { components: { securitySchemes } } : {}),
  };
}

async function generateFiles(
  auth: AuthOption | undefined,
  input = spec()
): Promise<(path: string) => string> {
  const { files } = await generateSdk({ input, transports: { http: { auth } } });
  return (path: string) => files.find((f) => f.path === path)!.contents;
}

describe("resolveAuthModel", () => {
  it("returns undefined with no option and no spec schemes", () => {
    expect(resolveAuthModel(undefined, [])).toBeUndefined();
  });

  it("applies field defaults for a single scheme", () => {
    const model = resolveAuthModel({ basic: {} }, []);
    expect(model).toEqual({
      schemes: [
        { type: "basic", key: "basic", usernameField: "username", passwordField: "password" },
      ],
    });
  });

  it("keeps custom field names and orders schemes stably", () => {
    const model = resolveAuthModel(
      {
        bearer: { field: "accessToken" },
        basic: { usernameField: "email", passwordField: "apitoken" },
      },
      []
    );
    // Stable order regardless of declaration order: basic, then bearer.
    expect(model?.schemes.map((s) => s.type)).toEqual(["basic", "bearer"]);
    expect(model?.schemes[0]).toMatchObject({ usernameField: "email", passwordField: "apitoken" });
    expect(model?.schemes[1]).toMatchObject({
      type: "bearer",
      field: "accessToken",
      key: "bearer",
    });
  });

  it("falls back to spec schemes with a friendly type-based key", () => {
    const specSchemes: IrAuthScheme[] = [
      { type: "apiKey", key: "ApiKeyAuth", in: "header", name: "X-API-Key" },
    ];
    const model = resolveAuthModel(undefined, specSchemes);
    expect(model).toEqual({
      schemes: [{ type: "apiKey", key: "apiKey", in: "header", name: "X-API-Key", field: "value" }],
    });
  });

  it("keeps the scheme name as key when a type repeats across spec schemes", () => {
    const specSchemes: IrAuthScheme[] = [
      { type: "bearer", key: "OAuth2" },
      { type: "bearer", key: "PersonalToken" },
    ];
    const model = resolveAuthModel(undefined, specSchemes);
    expect(model?.schemes.map((s) => s.key)).toEqual(["OAuth2", "PersonalToken"]);
  });

  it("lets the explicit option win over spec schemes", () => {
    const specSchemes: IrAuthScheme[] = [{ type: "basic", key: "basic" }];
    const model = resolveAuthModel({ bearer: {} }, specSchemes);
    expect(model?.schemes).toEqual([{ type: "bearer", key: "bearer", field: "token" }]);
  });
});

describe("emitted auth transport", () => {
  it("emits a flat config and adapter for a single renamed basic scheme", async () => {
    const get = await generateFiles({
      basic: { usernameField: "email", passwordField: "apitoken" },
    });
    const httpMod = get("transports/http.ts");
    expect(httpMod).toContain("export interface CreateSdkAuthConfig {");
    expect(httpMod).toContain("email: string;");
    expect(httpMod).toContain("apitoken: string;");
    expect(httpMod).toContain(
      'return { type: "basic", username: auth.email, password: auth.apitoken };'
    );
    expect(httpMod).toContain("export function http(options: HttpOptions): Transport {");
    expect(httpMod).not.toContain("AuthConfig[]");
    // The client config stays auth-free.
    expect(get("config.ts")).toContain("export type SdkConfig = ClientConfig;");
    // index wires createSdk against the shared config (transport is required).
    expect(get("index.ts")).toContain("export function createSdk(config: SdkConfig)");
  });

  it("emits a discriminated union for multiple schemes (pick one)", async () => {
    const httpMod = (await generateFiles({ basic: {}, bearer: {} }))("transports/http.ts");
    expect(httpMod).toContain(
      "export type CreateSdkAuthConfig = CreateSdkAuthConfigBasic | CreateSdkAuthConfigBearer;"
    );
    expect(httpMod).toContain('type: "basic";');
    expect(httpMod).toContain("switch (auth.type) {");
    expect(httpMod).toContain("function toRuntimeAuth(auth: CreateSdkAuthConfig): AuthConfig {");
  });

  it("re-exports the generic http and omits auth codegen when nothing is configured", async () => {
    const get = await generateFiles(undefined);
    const httpMod = get("transports/http.ts");
    expect(httpMod).toContain("export { http }");
    expect(httpMod).not.toContain("toRuntimeAuth");
    expect(get("config.ts")).toContain("export type SdkConfig = ClientConfig;");
    expect(get("index.ts")).toContain("export function createSdk(config: SdkConfig)");
  });

  it("derives auth from the spec's securitySchemes as a fallback", async () => {
    const httpMod = (
      await generateFiles(
        undefined,
        spec({
          ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key" },
          BearerAuth: { type: "http", scheme: "bearer" },
        })
      )
    )("transports/http.ts");
    expect(httpMod).toContain("toRuntimeAuth");
    expect(httpMod).toContain('name: "X-API-Key"');
    expect(httpMod).toContain("switch (auth.type) {");
  });
});

describe("generated auth SDKs", () => {
  let dir = "";
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("passes tsc --noEmit for single and multi-scheme configs", async () => {
    dir = await mkdtemp(join(tmpdir(), "narthia-auth-"));
    await generateSdk({
      input: spec(),
      output: join(dir, "single"),
      runtimePackage: "@narthia/openapi-sdk-generator",
      transports: {
        http: { auth: { basic: { usernameField: "email", passwordField: "apitoken" } } },
      },
    });
    await generateSdk({
      input: spec(),
      output: join(dir, "multi"),
      runtimePackage: "@narthia/openapi-sdk-generator",
      transports: {
        http: {
          auth: {
            basic: {},
            bearer: { field: "accessToken" },
            apiKey: { in: "header", name: "X-API-Key", field: "apiKey" },
          },
        },
      },
    });

    await writeFile(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: "es2022",
          module: "esnext",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          lib: ["es2023", "dom", "dom.iterable"],
          paths: {
            "@narthia/openapi-sdk-generator/client": [join(repoRoot, "src/client/index.ts")],
            "@narthia/openapi-sdk-generator/transports/http": [
              join(repoRoot, "src/transports/http/index.ts"),
            ],
          },
        },
        include: ["**/*.ts"],
      }),
      "utf8"
    );

    const tsc = join(repoRoot, "node_modules/.bin/tsc");
    await expect(execFileAsync(tsc, ["-p", dir], { cwd: dir })).resolves.toBeDefined();
  }, 60_000);

  it("maps renamed fields to the runtime auth shape at runtime", async () => {
    const e2eDir = fileURLToPath(new URL("./__auth_e2e__", import.meta.url));
    await generateSdk({
      input: spec(),
      output: e2eDir,
      // Package mode against this repo's source so the generated typed `http`
      // links to the same generic transport the test resolves.
      runtime: "package",
      runtimePackage: `${repoRoot.replace(/\/$/, "")}/src`,
      importExtension: "ts",
      transports: {
        http: { auth: { basic: { usernameField: "email", passwordField: "apitoken" } } },
      },
    });

    // Capture the outgoing fetch so we can assert the adapted Authorization header.
    const calls: { init: RequestInit }[] = [];
    const fetch = ((_url: string | URL, init?: RequestInit) => {
      calls.push({ init: init ?? {} });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof globalThis.fetch;

    interface AuthSdk {
      createSdk: (config: { transport: Transport }) => { main: { ping: () => Promise<unknown> } };
    }
    interface AuthHttp {
      http: (options: {
        baseUrl: string;
        auth?: { email: string; apitoken: string };
        fetch?: typeof globalThis.fetch;
      }) => Transport;
    }
    const { createSdk } = (await import(`${e2eDir}/index.ts`)) as AuthSdk;
    const { http } = (await import(`${e2eDir}/transports/http.ts`)) as AuthHttp;

    const sdk = createSdk({
      transport: http({
        baseUrl: "https://api.example.com",
        auth: { email: "a@b.com", apitoken: "secret" },
        fetch,
      }),
    });
    await sdk.main.ping();

    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe(
      `Basic ${btoa("a@b.com:secret")}`
    );

    await rm(e2eDir, { recursive: true, force: true });
  });
});
