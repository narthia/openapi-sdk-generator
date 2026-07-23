import { describe, expect, it } from "vitest";
import { encodeBody, interpolatePath, serializeQuery } from "../../src/client/serialize.ts";

describe("interpolatePath", () => {
  it("interpolates and encodes path params", () => {
    expect(interpolatePath("/users/{userId}/posts/{postId}", { userId: "a/b", postId: 42 })).toBe(
      "/users/a%2Fb/posts/42"
    );
  });

  it("throws on missing params", () => {
    expect(() => interpolatePath("/users/{userId}", {})).toThrow('Missing path parameter "userId"');
  });

  it("returns plain paths untouched", () => {
    expect(interpolatePath("/health")).toBe("/health");
  });
});

describe("serializeQuery", () => {
  it("serializes scalars, arrays (explode), and skips null/undefined", () => {
    const params = serializeQuery({
      q: "hello world",
      limit: 10,
      active: true,
      tags: ["a", "b"],
      skip: undefined,
      empty: null,
    });
    expect(params.toString()).toBe("q=hello+world&limit=10&active=true&tags=a&tags=b");
  });

  it("explodes plain objects into their properties", () => {
    const params = serializeQuery({ filter: { status: "open", kind: "bug" } });
    expect(params.toString()).toBe("status=open&kind=bug");
  });

  it("serializes dates as ISO strings", () => {
    const params = serializeQuery({ since: new Date("2026-01-02T03:04:05.000Z") });
    expect(params.get("since")).toBe("2026-01-02T03:04:05.000Z");
  });
});

describe("encodeBody", () => {
  it("encodes json", () => {
    expect(encodeBody({ a: 1 })).toEqual({
      body: '{"a":1}',
      contentType: "application/json",
    });
  });

  it("returns no body for undefined", () => {
    expect(encodeBody(undefined)).toEqual({ body: undefined, contentType: undefined });
  });

  it("encodes flat objects as FormData with blobs preserved", () => {
    const file = new Blob(["content"], { type: "text/plain" });
    const { body, contentType } = encodeBody(
      { name: "report", file, skip: undefined },
      "form-data"
    );
    expect(contentType).toBeUndefined();
    const form = body as FormData;
    expect(form.get("name")).toBe("report");
    expect(form.get("file")).toBeInstanceOf(Blob);
    expect(form.has("skip")).toBe(false);
  });

  it("encodes url-encoded bodies", () => {
    const { body, contentType } = encodeBody({ a: "1", list: ["x", "y"] }, "url-encoded");
    expect(contentType).toBe("application/x-www-form-urlencoded");
    expect((body as URLSearchParams).toString()).toBe("a=1&list=x&list=y");
  });

  it("passes binary bodies through", () => {
    const blob = new Blob(["bin"]);
    expect(encodeBody(blob, "binary")).toEqual({
      body: blob,
      contentType: "application/octet-stream",
    });
  });

  it("encodes text bodies", () => {
    expect(encodeBody("hello", "text")).toEqual({ body: "hello", contentType: "text/plain" });
  });
});
