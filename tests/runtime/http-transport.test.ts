import { describe, expect, it } from "vitest";
import type { TransportRequest } from "../../src/client/index.ts";
import { http } from "../../src/transports/http/index.ts";

function fakeFetch(body = "{}", init: ResponseInit = { status: 200 }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = ((url: string | URL, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    return Promise.resolve(new Response(body, init));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

function makeRequest(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    method: "get",
    path: "/pets",
    query: new URLSearchParams(),
    headers: {},
    ...overrides,
  };
}

describe("http transport", () => {
  it("joins baseUrl and path regardless of slashes", async () => {
    const { fetch, calls } = fakeFetch();

    await http({ baseUrl: "https://api.example.com/", fetch }).request(makeRequest());
    await http({ baseUrl: "https://api.example.com/v2", fetch }).request(
      makeRequest({ path: "pets" })
    );

    expect(calls[0]!.url).toBe("https://api.example.com/pets");
    expect(calls[1]!.url).toBe("https://api.example.com/v2/pets");
  });

  it("appends the query string only when non-empty", async () => {
    const { fetch, calls } = fakeFetch();
    const transport = http({ baseUrl: "https://api.example.com", fetch });

    await transport.request(makeRequest({ query: new URLSearchParams({ limit: "10" }) }));
    await transport.request(makeRequest());

    expect(calls[0]!.url).toBe("https://api.example.com/pets?limit=10");
    expect(calls[1]!.url).toBe("https://api.example.com/pets");
  });

  it("passes method, headers, body, and signal to fetch", async () => {
    const { fetch, calls } = fakeFetch();
    const transport = http({ baseUrl: "https://api.example.com", fetch });
    const controller = new AbortController();

    await transport.request(
      makeRequest({
        method: "post",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
        signal: controller.signal,
      })
    );

    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  it("merges fetchOptions and wraps the response", async () => {
    const { fetch, calls } = fakeFetch('{"ok":true}', {
      status: 201,
      headers: { "x-req-id": "r1" },
    });
    const transport = http({
      baseUrl: "https://api.example.com",
      fetch,
      fetchOptions: { credentials: "include" },
    });

    const res = await transport.request(makeRequest());

    expect(calls[0]!.init).toMatchObject({ credentials: "include" });
    expect(res.status).toBe(201);
    expect(res.headers["x-req-id"]).toBe("r1");
    await expect(res.text()).resolves.toBe('{"ok":true}');
  });

  describe("auth", () => {
    it("applies bearer auth from an async factory", async () => {
      const { fetch, calls } = fakeFetch();
      const transport = http({
        baseUrl: "https://api.example.com",
        fetch,
        auth: { type: "bearer", token: () => Promise.resolve("tok") },
      });

      await transport.request(makeRequest());

      expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe(
        "Bearer tok"
      );
    });

    it("applies apiKey auth in the query string", async () => {
      const { fetch, calls } = fakeFetch();
      const transport = http({
        baseUrl: "https://api.example.com",
        fetch,
        auth: { type: "apiKey", in: "query", name: "api_key", value: "k1" },
      });

      await transport.request(makeRequest());

      expect(calls[0]!.url).toBe("https://api.example.com/pets?api_key=k1");
    });

    it("applies apiKey auth in a header", async () => {
      const { fetch, calls } = fakeFetch();
      const transport = http({
        baseUrl: "https://api.example.com",
        fetch,
        auth: { type: "apiKey", in: "header", name: "X-API-Key", value: "k1" },
      });

      await transport.request(makeRequest());

      expect((calls[0]!.init.headers as Record<string, string>)["x-api-key"]).toBe("k1");
    });

    it("applies basic auth (UTF-8 safe base64)", async () => {
      const { fetch, calls } = fakeFetch();
      const transport = http({
        baseUrl: "https://api.example.com",
        fetch,
        auth: { type: "basic", username: "a@b.com", password: "secret" },
      });

      await transport.request(makeRequest());

      const expected = `Basic ${btoa("a@b.com:secret")}`;
      expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe(expected);
    });

    it("does not mutate the caller's request headers or query", async () => {
      const { fetch } = fakeFetch();
      const transport = http({
        baseUrl: "https://api.example.com",
        fetch,
        auth: { type: "bearer", token: "tok" },
      });
      const req = makeRequest();

      await transport.request(req);

      expect(req.headers["authorization"]).toBeUndefined();
      expect(req.query.toString()).toBe("");
    });
  });
});
