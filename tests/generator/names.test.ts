import { describe, expect, it } from "vitest";
import {
  camelCase,
  identifier,
  kebabCase,
  NameRegistry,
  pascalCase,
  propertyKey,
  synthesizeMethodName,
  typeName,
} from "../../src/generator/names.ts";

describe("casing", () => {
  it("camelCases arbitrary strings", () => {
    expect(camelCase("get-user_by.id")).toBe("getUserById");
    expect(camelCase("User Accounts")).toBe("userAccounts");
    expect(camelCase("APIKey")).toBe("apiKey");
  });

  it("pascalCases and kebab-cases", () => {
    expect(pascalCase("user_account")).toBe("UserAccount");
    expect(kebabCase("User Accounts")).toBe("user-accounts");
    expect(kebabCase("store")).toBe("store");
  });
});

describe("identifier", () => {
  it("suffixes reserved words", () => {
    expect(identifier("delete")).toBe("delete_");
    expect(identifier("new")).toBe("new_");
  });

  it("handles leading digits and empty input", () => {
    expect(identifier("123list")).toBe("_123list");
    expect(identifier("$$$")).toBe("value");
  });
});

describe("typeName", () => {
  it("pascalCases schema keys", () => {
    expect(typeName("user_account")).toBe("UserAccount");
    expect(typeName("pet")).toBe("Pet");
  });

  it("handles degenerate keys", () => {
    expect(typeName("123")).toBe("Schema123");
    expect(typeName("!!!")).toBe("Schema");
  });
});

describe("propertyKey", () => {
  it("quotes names that are not valid identifiers", () => {
    expect(propertyKey("contentType")).toBe("contentType");
    expect(propertyKey("content-type")).toBe('"content-type"');
    expect(propertyKey("2fa")).toBe('"2fa"');
  });
});

describe("synthesizeMethodName", () => {
  it("builds names from method + path with By<Param> segments", () => {
    expect(synthesizeMethodName("get", "/users/{id}/posts")).toBe("getUsersByIdPosts");
    expect(synthesizeMethodName("get", "/health")).toBe("getHealth");
    expect(synthesizeMethodName("post", "/")).toBe("post");
  });
});

describe("NameRegistry", () => {
  it("appends numeric suffixes on collision", () => {
    const registry = new NameRegistry();
    expect(registry.claim("getUser")).toBe("getUser");
    expect(registry.claim("getUser")).toBe("getUser2");
    expect(registry.claim("getUser")).toBe("getUser3");
    expect(registry.claim("other")).toBe("other");
  });
});
