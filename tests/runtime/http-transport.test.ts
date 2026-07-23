import { describe, expect, it } from "vitest";
import type { TransportRequest } from "../../src/client/index.ts";
import { httpTransport } from "../../src/transports/http/index.ts";

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
    baseUrl: "https://api.example.com",
    query: new URLSearchParams(),
    headers: {},
    ...overrides,
  };
}

describe("httpTransport", () => {
  it("joins baseUrl and path regardless of slashes", async () => {
    const { fetch, calls } = fakeFetch();
    const transport = httpTransport({ fetch });

    await transport.request(makeRequest({ baseUrl: "https://api.example.com/" }));
    await transport.request(makeRequest({ baseUrl: "https://api.example.com/v2", path: "pets" }));

    expect(calls[0]!.url).toBe("https://api.example.com/pets");
    expect(calls[1]!.url).toBe("https://api.example.com/v2/pets");
  });

  it("appends the query string only when non-empty", async () => {
    const { fetch, calls } = fakeFetch();
    const transport = httpTransport({ fetch });

    await transport.request(makeRequest({ query: new URLSearchParams({ limit: "10" }) }));
    await transport.request(makeRequest());

    expect(calls[0]!.url).toBe("https://api.example.com/pets?limit=10");
    expect(calls[1]!.url).toBe("https://api.example.com/pets");
  });

  it("passes method, headers, body, and signal to fetch", async () => {
    const { fetch, calls } = fakeFetch();
    const transport = httpTransport({ fetch });
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
    const transport = httpTransport({ fetch, fetchOptions: { credentials: "include" } });

    const res = await transport.request(makeRequest());

    expect(calls[0]!.init).toMatchObject({ credentials: "include" });
    expect(res.status).toBe(201);
    expect(res.headers["x-req-id"]).toBe("r1");
    await expect(res.text()).resolves.toBe('{"ok":true}');
  });
});
