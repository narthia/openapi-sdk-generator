import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Transport, TransportRequest } from "../../src/client/index.ts";
import { generateSdk } from "../../src/index.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const outDir = fileURLToPath(new URL("./__e2e__/sdk", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/petstore-3.0.json", import.meta.url));

function stubTransport(
  respond: (req: TransportRequest) => { status?: number; body?: string } = () => ({})
): { transport: Transport; requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    transport: {
      request: (req) => {
        requests.push(req);
        const { status = 200, body = "{}" } = respond(req);
        return Promise.resolve({
          status,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          text: () => Promise.resolve(body),
          arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer as ArrayBuffer),
        });
      },
    },
  };
}

describe("end-to-end: generate, import, and call", () => {
  afterAll(async () => {
    await rm(fileURLToPath(new URL("./__e2e__", import.meta.url)), {
      recursive: true,
      force: true,
    });
  });

  it("generates an SDK that composes with the runtime and drives real requests", async () => {
    await generateSdk({
      input: fixture,
      output: outDir,
      // Resolve the runtime import against this repo's source so the dynamically
      // imported SDK links to the same client core the test uses.
      runtimePackage: `${repoRoot.replace(/\/$/, "")}/src`,
      importExtension: "ts",
    });

    // The SDK is generated at runtime, so it has no static type here. Describe
    // just the surface this test drives.
    interface PetsSdk {
      createSdk: (config: { baseUrl?: string; transport?: Transport }) => {
        pets: {
          listPets: (o?: { limit?: number; tags?: string[] }) => Promise<unknown>;
          getPetById: (o: { petId: number }) => Promise<unknown>;
          createPet: (o: { name: string; status?: string }) => Promise<unknown>;
          deletePet: (o: { petId: number }) => Promise<unknown>;
        };
      };
    }
    const { createSdk } = (await import(`${outDir}/index.ts`)) as PetsSdk;

    const { transport, requests } = stubTransport((req) => {
      if (req.path === "/pets" && req.method === "get") {
        return { body: JSON.stringify([{ id: 1, name: "Bella", status: "available" }]) };
      }
      if (req.path === "/pets/1" && req.method === "get") {
        return { body: JSON.stringify({ id: 1, name: "Bella" }) };
      }
      if (req.path === "/pets/999" && req.method === "get") {
        return { status: 404, body: JSON.stringify({ code: 404, message: "not found" }) };
      }
      return {};
    });

    const sdk = createSdk({ baseUrl: "https://api.example.com", transport });

    // Flat query params + array response.
    const pets = await sdk.pets.listPets({ limit: 10, tags: ["cute", "small"] });
    expect(pets).toEqual([{ id: 1, name: "Bella", status: "available" }]);
    expect(requests[0]!.query.get("limit")).toBe("10");
    expect(requests[0]!.query.getAll("tags")).toEqual(["cute", "small"]);

    // Flat path param + typed object response.
    const pet = await sdk.pets.getPetById({ petId: 1 });
    expect(pet).toEqual({ id: 1, name: "Bella" });
    expect(requests[1]!.path).toBe("/pets/1");

    // Flat (spread) JSON request body.
    await sdk.pets.createPet({ name: "Max", status: "pending" });
    expect(requests[2]!.method).toBe("post");
    expect(requests[2]!.body).toBe('{"name":"Max","status":"pending"}');

    // 204 → void.
    const deleted = await sdk.pets.deletePet({ petId: 1 });
    expect(deleted).toBeUndefined();

    // Non-2xx → ApiError with parsed body.
    const { ApiError } = await import("../../src/client/index.ts");
    const error = await sdk.pets.getPetById({ petId: 999 }).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(404);
    expect((error as InstanceType<typeof ApiError>).body).toEqual({
      code: 404,
      message: "not found",
    });
  });
});
