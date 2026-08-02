import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportRequest } from "../../src/client/index.ts";

interface RecordedCall {
  as: "app" | "user";
  accountId: string | undefined;
  product: "jira" | "confluence" | "bitbucket";
  route: string;
  init: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal };
}

const { calls } = vi.hoisted(() => ({ calls: [] as RecordedCall[] }));

vi.mock("@forge/api", () => {
  const makeResponse = () => {
    const headers = new Map([
      ["content-type", "application/json"],
      ["x-trace", "abc"],
    ]);
    return {
      status: 201,
      statusText: "Created",
      ok: true,
      headers: { forEach: (cb: (v: string, k: string) => void) => headers.forEach(cb) },
      text: () => Promise.resolve('{"ok":true}'),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
      json: () => Promise.resolve({ ok: true }),
    };
  };
  const productMethods = (as: "app" | "user", accountId?: string) => {
    const make =
      (product: RecordedCall["product"]) =>
      (route: { value: string }, init: RecordedCall["init"]) => {
        calls.push({ as, accountId, product, route: route.value, init });
        return Promise.resolve(makeResponse());
      };
    return {
      requestJira: make("jira"),
      requestConfluence: make("confluence"),
      requestBitbucket: make("bitbucket"),
    };
  };
  return {
    default: {
      asApp: () => productMethods("app"),
      asUser: (accountId?: string) => productMethods("user", accountId),
    },
    assumeTrustedRoute: (value: string) => ({ value }),
  };
});

// Imported after vi.mock so the module binds to the mocked @forge/api.
const { forgeJira, forgeConfluence, forgeBitbucket, forgeAs } =
  await import("../../src/transports/forge/index.ts");

function makeRequest(overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    method: "get",
    path: "/rest/api/3/myself",
    query: new URLSearchParams(),
    headers: {},
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
});

describe("forge transports", () => {
  it("defaults to asApp() and dispatches to the product's request method", async () => {
    await forgeJira().request(makeRequest());
    await forgeConfluence().request(makeRequest());
    await forgeBitbucket().request(makeRequest());

    expect(calls.map((c) => [c.as, c.product])).toEqual([
      ["app", "jira"],
      ["app", "confluence"],
      ["app", "bitbucket"],
    ]);
  });

  it("honors the transport-level default `as`", async () => {
    await forgeJira({ as: "user" }).request(makeRequest());
    expect(calls[0]!.as).toBe("user");
  });

  it("lets a per-call extension override the identity (and impersonate an accountId)", async () => {
    const transport = forgeJira({ as: "app" });
    await transport.request(
      makeRequest({ extensions: forgeAs("user", { accountId: "acc-1" }).extensions })
    );

    expect(calls[0]!.as).toBe("user");
    expect(calls[0]!.accountId).toBe("acc-1");
  });

  it("passes the already-encoded path + query through without re-encoding", async () => {
    await forgeJira().request(
      makeRequest({
        path: "/rest/api/3/issue/ABC%2F1",
        query: new URLSearchParams({ jql: "project = ABC" }),
      })
    );
    expect(calls[0]!.route).toBe("/rest/api/3/issue/ABC%2F1?jql=project+%3D+ABC");
  });

  it("omits the query string when there are no params", async () => {
    await forgeJira().request(makeRequest({ path: "/rest/api/3/myself" }));
    expect(calls[0]!.route).toBe("/rest/api/3/myself");
  });

  it("forwards method, headers, body, and signal", async () => {
    const controller = new AbortController();
    await forgeJira().request(
      makeRequest({
        method: "post",
        headers: { "content-type": "application/json" },
        body: '{"a":1}',
        signal: controller.signal,
      })
    );

    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({ "content-type": "application/json" });
    expect(calls[0]!.init.body).toBe('{"a":1}');
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  it("maps the Forge response to a TransportResponse", async () => {
    const res = await forgeJira().request(makeRequest());
    expect(res.status).toBe(201);
    expect(res.statusText).toBe("Created");
    expect(res.headers).toEqual({ "content-type": "application/json", "x-trace": "abc" });
    expect(await res.text()).toBe('{"ok":true}');
    expect((await res.arrayBuffer()).byteLength).toBe(8);
  });
});

describe("forgeAs", () => {
  it("builds a typed per-call options object", () => {
    expect(forgeAs("user")).toEqual({ extensions: { forge: { as: "user" } } });
    expect(forgeAs("user", { accountId: "x", signal: undefined })).toEqual({
      extensions: { forge: { as: "user", accountId: "x" } },
    });
  });
});
