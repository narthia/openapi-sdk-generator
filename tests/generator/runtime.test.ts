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
    expect(paths).toContain("transport/http.ts");

    // index wires through ./config; ./config imports the inlined runtime.
    expect(get("index.ts")!).toContain('from "./config"');
    expect(get("config.ts")!).toContain('from "./client"');
    expect(get("config.ts")!).not.toContain('from "@narthia/openapi-sdk-generator/client"');

    // Inlined runtime imports are rewritten for the generated layout.
    expect(get("client/client.ts")!).toContain('from "../transport/http"');
    expect(get("transport/http.ts")!).toContain('from "../client/types"');

    // Standalone, tree-shakeable op present alongside the factory.
    const pets = get("services/pets.ts")!;
    expect(pets).toContain("export function getPetById(ctx: ClientContext");
    expect(pets).toContain("export function createPetsService(ctx: ClientContext)");
    expect(pets).toContain('from "../client"');
  });

  it("honors importExtension in rewritten runtime imports", async () => {
    const { get } = await generate({ input: fixture, importExtension: "js" });
    expect(get("client/client.ts")!).toContain('from "../transport/http.js"');
    expect(get("config.ts")!).toContain('from "./client/index.js"');
    expect(get("index.ts")!).toContain('from "./config.js"');
  });

  it("config.ts createClient respects the auth option", async () => {
    const { get } = await generate({
      input: fixture,
      auth: { basic: { usernameField: "email", passwordField: "apiToken" } },
    });
    const config = get("config.ts")!;
    expect(config).toContain("export function createClient(config: SdkConfig");
    expect(config).toContain("email: string;");
    expect(config).toContain("apiToken: string;");
    expect(config).toContain("toRuntimeAuth(auth)");
    // The adapter lives in ./config, not index.ts.
    expect(get("index.ts")!).not.toContain("toRuntimeAuth");
  });
});

describe("runtime: package", () => {
  it("imports from the package and emits no runtime files", async () => {
    const { paths, get } = await generate({ input: fixture, runtime: "package" });

    expect(paths.some((p) => p.startsWith("client/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("transport/"))).toBe(false);

    // The package specifier lands in ./config and the service files; index wires through ./config.
    expect(get("index.ts")!).toContain('from "./config"');
    expect(get("config.ts")!).toContain('from "@narthia/openapi-sdk-generator/client"');
    expect(get("services/pets.ts")!).toContain('from "@narthia/openapi-sdk-generator/client"');
    // Standalone functions exist regardless of runtime mode.
    expect(get("services/pets.ts")!).toContain("export function getPetById(ctx: ClientContext");
  });
});
