import { describe, expect, it } from "vitest";
import { buildJsDoc } from "../../src/generator/jsdoc.ts";

describe("buildJsDoc", () => {
  it("returns undefined when empty", () => {
    expect(buildJsDoc({})).toBeUndefined();
  });

  it("renders a single-line doc compactly", () => {
    expect(buildJsDoc({ description: "The pet's name" })).toBe("/** The pet's name */");
  });

  it("renders summary, description, params, and tags in order", () => {
    const doc = buildJsDoc({
      summary: "Get a user by ID.",
      description: "Returns a single user.\n\nSecond paragraph.",
      params: [
        { name: "options.path.userId", description: "The user ID" },
        { name: "options.query.expand" },
      ],
      returns: "The requested user",
      deprecated: "Use getUserV2 instead.",
      see: { url: "https://docs.example.com/users", description: "User guide" },
    });
    expect(doc).toBe(
      [
        "/**",
        " * Get a user by ID.",
        " *",
        " * Returns a single user.",
        " *",
        " * Second paragraph.",
        " *",
        " * @param options.path.userId - The user ID",
        " * @param options.query.expand",
        " * @returns The requested user",
        " * @deprecated Use getUserV2 instead.",
        " * @see https://docs.example.com/users User guide",
        " */",
      ].join("\n")
    );
  });

  it("indents every line", () => {
    const doc = buildJsDoc({ summary: "Hi", deprecated: true }, "    ");
    expect(doc).toBe(
      ["    /**", "     * Hi", "     *", "     * @deprecated", "     */"].join("\n")
    );
  });

  it("neutralizes comment terminators", () => {
    expect(buildJsDoc({ description: "evil */ content" })).toContain("evil *\\/ content");
  });

  it("renders default and format tags and example blocks", () => {
    const doc = buildJsDoc({ default: "available", format: "date-time", example: { a: 1 } });
    expect(doc).toContain('@default "available"');
    expect(doc).toContain("@format date-time");
    expect(doc).toContain("@example");
    expect(doc).toContain('"a": 1');
  });
});
