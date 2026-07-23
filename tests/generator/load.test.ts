import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectVersion } from "../../src/generator/detect.ts";
import { loadSpec } from "../../src/generator/load.ts";

const petstore30Path = fileURLToPath(new URL("../fixtures/petstore-3.0.json", import.meta.url));

describe("loadSpec", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads a spec from a file path", async () => {
    const spec = await loadSpec(petstore30Path);
    expect(spec["openapi"]).toBe("3.0.3");
  });

  it("clones in-memory objects instead of using them directly", async () => {
    const input = { openapi: "3.1.0", paths: {} };
    const spec = await loadSpec(input);
    expect(spec).toEqual(input);
    expect(spec).not.toBe(input);
  });

  it("fetches specs from http(s) URLs", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>(() =>
      Promise.resolve(new Response('{"openapi":"3.1.0"}', { status: 200 }))
    );
    vi.stubGlobal("fetch", fetchMock);
    const spec = await loadSpec("https://example.com/openapi.json");
    expect(spec["openapi"]).toBe("3.1.0");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/openapi.json",
      expect.objectContaining({ headers: { accept: "application/json" } })
    );
  });

  it("reports fetch failures with the URL and status", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("nope", { status: 404, statusText: "Not Found" }))
    );
    await expect(loadSpec("https://example.com/missing.json")).rejects.toThrow(
      "Failed to fetch OpenAPI spec from https://example.com/missing.json: 404 Not Found"
    );
  });

  it("rejects YAML file paths with a clear message", async () => {
    await expect(loadSpec("./spec.yaml")).rejects.toThrow("YAML specs are not yet supported");
  });

  it("rejects YAML content with a clear message", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("openapi: 3.1.0", { status: 200 })));
    await expect(loadSpec("https://example.com/spec")).rejects.toThrow(
      "YAML specs are not yet supported"
    );
  });

  it("reports unreadable files", async () => {
    await expect(loadSpec("/does/not/exist.json")).rejects.toThrow(
      "Failed to read OpenAPI spec file at /does/not/exist.json"
    );
  });
});

describe("detectVersion", () => {
  it("detects 3.0 and 3.1", () => {
    expect(detectVersion({ openapi: "3.0.3", paths: {} })).toBe("3.0");
    expect(detectVersion({ openapi: "3.1.0", paths: {} })).toBe("3.1");
  });

  it("rejects Swagger 2.0 explicitly", () => {
    expect(() => detectVersion({ swagger: "2.0" })).toThrow("Swagger 2.0 is not supported");
  });

  it("rejects unknown versions and missing version fields", () => {
    expect(() => detectVersion({ openapi: "4.0.0" })).toThrow(
      'Unsupported OpenAPI version "4.0.0"'
    );
    expect(() => detectVersion({})).toThrow('missing "openapi" version field');
  });

  it("rejects malformed paths", () => {
    expect(() => detectVersion({ openapi: "3.1.0", paths: [] })).toThrow(
      '"paths" must be an object'
    );
  });
});
