import { describe, expect, it } from "vitest";
import type { Transport, TransportRequest, TransportResponse } from "../../src/client/index.ts";
import { ApiError, createClient } from "../../src/client/index.ts";

function stubTransport(
  respond: (req: TransportRequest) => Partial<TransportResponse> = () => ({})
): { transport: Transport; requests: TransportRequest[] } {
  const requests: TransportRequest[] = [];
  return {
    requests,
    transport: {
      request: (req) => {
        requests.push(req);
        const partial = respond(req);
        return Promise.resolve({
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          text: () => Promise.resolve("{}"),
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
          ...partial,
        });
      },
    },
  };
}

describe("createClient", () => {
  it("builds the full transport request from an operation spec", async () => {
    const { transport, requests } = stubTransport(() => ({
      text: () => Promise.resolve('{"id":"42"}'),
    }));
    const ctx = createClient({
      baseUrl: "https://api.example.com",
      transport,
      headers: { "x-app": "test" },
    });

    const result = await ctx.request<{ id: string }>({
      method: "post",
      path: "/users/{userId}/notes",
      pathParams: { userId: "a b" },
      query: { expand: ["profile", "roles"] },
      headers: { "X-Trace": "trace-1" },
      body: { text: "hi" },
    });

    expect(result).toEqual({ id: "42" });
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe("post");
    expect(req.path).toBe("/users/a%20b/notes");
    expect(req.baseUrl).toBe("https://api.example.com");
    expect(req.query.getAll("expand")).toEqual(["profile", "roles"]);
    expect(req.headers).toMatchObject({
      "x-app": "test",
      "x-trace": "trace-1",
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(req.body).toBe('{"text":"hi"}');
  });

  it("applies bearer auth from an async factory", async () => {
    const { transport, requests } = stubTransport();
    const ctx = createClient({
      transport,
      auth: { type: "bearer", token: () => Promise.resolve("tok-123") },
    });
    await ctx.request({ method: "get", path: "/me" });
    expect(requests[0]!.headers["authorization"]).toBe("Bearer tok-123");
  });

  it("applies apiKey auth in query", async () => {
    const { transport, requests } = stubTransport();
    const ctx = createClient({
      transport,
      auth: { type: "apiKey", in: "query", name: "api_key", value: "k1" },
    });
    await ctx.request({ method: "get", path: "/pets" });
    expect(requests[0]!.query.get("api_key")).toBe("k1");
  });

  it("applies basic auth", async () => {
    const { transport, requests } = stubTransport();
    const ctx = createClient({
      transport,
      auth: { type: "basic", username: "user", password: "pass" },
    });
    await ctx.request({ method: "get", path: "/" });
    expect(requests[0]!.headers["authorization"]).toBe(`Basic ${btoa("user:pass")}`);
  });

  it("throws ApiError with parsed body on non-2xx", async () => {
    const { transport } = stubTransport(() => ({
      status: 404,
      statusText: "Not Found",
      text: () => Promise.resolve('{"message":"nope"}'),
    }));
    const ctx = createClient({ transport });

    const error = await ctx
      .request({ method: "get", path: "/users/{id}", pathParams: { id: 1 } })
      .then(
        () => null,
        (e: unknown) => e as ApiError
      );

    expect(error).toBeInstanceOf(ApiError);
    expect(error!.status).toBe(404);
    expect(error!.body).toEqual({ message: "nope" });
    expect(error!.request).toEqual({ method: "get", path: "/users/1" });
    expect(error!.message).toBe("GET /users/1 failed with status 404 (Not Found)");
  });

  it("keeps raw text as the error body when it is not JSON", async () => {
    const { transport } = stubTransport(() => ({
      status: 500,
      text: () => Promise.resolve("boom"),
    }));
    const ctx = createClient({ transport });
    await expect(ctx.request({ method: "get", path: "/" })).rejects.toMatchObject({
      body: "boom",
    });
  });

  it("returns undefined for 204 and void responses", async () => {
    const { transport } = stubTransport(() => ({ status: 204, text: () => Promise.resolve("") }));
    const ctx = createClient({ transport });
    await expect(ctx.request({ method: "delete", path: "/users/1" })).resolves.toBeUndefined();
    await expect(
      ctx.request({ method: "delete", path: "/users/1", responseType: "void" })
    ).resolves.toBeUndefined();
  });

  it("decodes binary responses as Blob", async () => {
    const bytes = new TextEncoder().encode("filedata");
    const { transport } = stubTransport(() => ({
      headers: { "content-type": "application/pdf" },
      arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
    }));
    const ctx = createClient({ transport });
    const blob = await ctx.request<Blob>({ method: "get", path: "/file", responseType: "binary" });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/pdf");
    expect(await blob.text()).toBe("filedata");
  });

  it("runs onRequest and onResponse interceptors", async () => {
    const { transport, requests } = stubTransport();
    const seen: number[] = [];
    const ctx = createClient({
      transport,
      onRequest: (req) => ({ ...req, headers: { ...req.headers, "x-intercepted": "yes" } }),
      onResponse: (res) => {
        seen.push(res.status);
      },
    });
    await ctx.request({ method: "get", path: "/" });
    expect(requests[0]!.headers["x-intercepted"]).toBe("yes");
    expect(seen).toEqual([200]);
  });
});
