import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  generateSdk,
  planTargetTransports,
  resolveForge,
  validateTransports,
} from "../../src/generator/generate.ts";

const fixture = fileURLToPath(new URL("../fixtures/petstore-3.1.json", import.meta.url));

async function generate(options: Parameters<typeof generateSdk>[0]) {
  const { files } = await generateSdk(options);
  const get = (path: string) => files.find((f) => f.path === path)?.contents;
  return { paths: files.map((f) => f.path), get };
}

describe("validateTransports", () => {
  it("accepts undefined and known transports", () => {
    expect(() => validateTransports(undefined, "transports")).not.toThrow();
    expect(() => validateTransports({ http: {} }, "transports")).not.toThrow();
    expect(() => validateTransports({ forge: { product: "jira" } }, "transports")).not.toThrow();
  });

  it("throws on an unknown transport", () => {
    expect(() => validateTransports({ grpc: {} } as never, "transports")).toThrow(
      /Unknown transport "grpc"/
    );
  });

  it("throws on an invalid forge product or identity", () => {
    expect(() =>
      validateTransports({ forge: { product: "slack" as never } }, "transports")
    ).toThrow(/forge\.product/);
    expect(() =>
      validateTransports({ forge: { product: "jira", as: "root" as never } }, "transports")
    ).toThrow(/forge\.as/);
  });
});

describe("planTargetTransports", () => {
  it("defaults to http when nothing is configured", () => {
    expect(planTargetTransports(undefined, undefined)).toEqual({ ownHttp: { auth: undefined } });
  });

  it("inherits a shared transport the target does not override", () => {
    const shared = { http: { auth: { bearer: {} } } };
    expect(planTargetTransports(undefined, shared)).toEqual({ inheritHttp: true });
  });

  it("lets a per-target transport override the shared one", () => {
    const shared = { http: { auth: { bearer: {} } } };
    const own = { http: { auth: { basic: {} } } };
    expect(planTargetTransports(own, shared)).toEqual({ ownHttp: { auth: { basic: {} } } });
  });

  it("mixes an inherited transport with an added one", () => {
    const shared = { http: { auth: { bearer: {} } } };
    const own = { forge: { product: "jira" as const } };
    expect(planTargetTransports(own, shared)).toEqual({
      inheritHttp: true,
      ownForge: { product: "jira" },
    });
  });
});

describe("resolveForge", () => {
  it("defaults the identity to app", () => {
    expect(resolveForge({ product: "confluence" })).toEqual({ product: "confluence", as: "app" });
    expect(resolveForge({ product: "jira", as: "user" })).toEqual({ product: "jira", as: "user" });
  });
});

describe("runtime: generate (default)", () => {
  it("emits the runtime into the SDK and imports it relatively", async () => {
    const { paths, get } = await generate({ input: fixture });

    expect(paths).toContain("client/index.ts");
    expect(paths).toContain("client/client.ts");
    // Generic transport copied under an internal name; typed wrapper alongside it.
    expect(paths).toContain("transports/_http.ts");
    expect(paths).toContain("transports/http.ts");

    // index wires through ./config; ./config imports the inlined runtime.
    expect(get("index.ts")!).toContain('from "./config"');
    expect(get("config.ts")!).toContain('from "./client"');
    expect(get("config.ts")!).not.toContain('from "@narthia/openapi-sdk-generator/client"');

    // Inlined runtime imports are rewritten for the generated layout.
    expect(get("transports/_http.ts")!).toContain('from "../client/types"');
    // No-auth SDK: the typed wrapper re-exports the generic transport sibling.
    expect(get("transports/http.ts")!).toContain('from "./_http"');

    // Standalone, tree-shakeable op present alongside the factory.
    const pets = get("services/pets.ts")!;
    expect(pets).toContain("export function getPetById(ctx: ClientContext");
    expect(pets).toContain("export function createPetsService(ctx: ClientContext)");
    expect(pets).toContain('from "../client"');
  });

  it("honors importExtension in rewritten runtime imports", async () => {
    const { get } = await generate({ input: fixture, importExtension: "js" });
    expect(get("transports/_http.ts")!).toContain('from "../client/types.js"');
    expect(get("transports/http.ts")!).toContain('from "./_http.js"');
    expect(get("config.ts")!).toContain('from "./client/index.js"');
    expect(get("index.ts")!).toContain('from "./config.js"');
  });

  it("emits the typed http transport (with auth) into transports/http.ts", async () => {
    const { get } = await generate({
      input: fixture,
      transports: {
        http: { auth: { basic: { usernameField: "email", passwordField: "apiToken" } } },
      },
    });
    const httpMod = get("transports/http.ts")!;
    expect(httpMod).toContain("email: string;");
    expect(httpMod).toContain("apiToken: string;");
    expect(httpMod).toContain("toRuntimeAuth(auth)");
    expect(httpMod).toContain("export function http(options: HttpOptions): Transport {");
    // config.ts stays auth-free; the adapter is not in config.ts or index.ts.
    expect(get("config.ts")!).toContain("export function createClient(config: SdkConfig");
    expect(get("config.ts")!).not.toContain("toRuntimeAuth");
    expect(get("index.ts")!).not.toContain("toRuntimeAuth");
  });
});

describe("runtime: package", () => {
  it("imports from the package and emits no copied runtime files", async () => {
    const { paths, get } = await generate({ input: fixture, runtime: "package" });

    expect(paths.some((p) => p.startsWith("client/"))).toBe(false);
    // The generic transport is not copied, but the typed wrapper is still emitted.
    expect(paths).not.toContain("transports/_http.ts");
    expect(paths).toContain("transports/http.ts");

    // The package specifier lands in ./config, the service files, and the wrapper.
    expect(get("index.ts")!).toContain('from "./config"');
    expect(get("config.ts")!).toContain('from "@narthia/openapi-sdk-generator/client"');
    expect(get("services/pets.ts")!).toContain('from "@narthia/openapi-sdk-generator/client"');
    expect(get("transports/http.ts")!).toContain(
      'from "@narthia/openapi-sdk-generator/transports/http"'
    );
    // Standalone functions exist regardless of runtime mode.
    expect(get("services/pets.ts")!).toContain("export function getPetById(ctx: ClientContext");
  });
});
