import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSdk, resolveTransports } from "../../src/generator/generate.ts";

const fixture = fileURLToPath(new URL("../fixtures/petstore-3.1.json", import.meta.url));

async function generate(options: Parameters<typeof generateSdk>[0]) {
  const { files } = await generateSdk(options);
  const get = (path: string) => files.find((f) => f.path === path)?.contents;
  return { paths: files.map((f) => f.path), get };
}

describe("resolveTransports", () => {
  it("defaults to http", () => {
    expect(resolveTransports(undefined)).toEqual(["http"]);
  });

  it("throws on an empty list", () => {
    expect(() => resolveTransports([])).toThrow(/at least one transport/);
  });

  it("throws on an unknown transport", () => {
    expect(() => resolveTransports(["grpc" as "http"])).toThrow(/Unknown transport "grpc"/);
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
      auth: { basic: { usernameField: "email", passwordField: "apiToken" } },
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
