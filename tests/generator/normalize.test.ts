import { describe, expect, it } from "vitest";
import { normalizeSchema } from "../../src/generator/normalize.ts";

describe("normalizeSchema", () => {
  it("normalizes 3.0 nullable and 3.1 type arrays to the same shape", () => {
    const from30 = normalizeSchema({ type: "string", nullable: true }, "3.0");
    const from31 = normalizeSchema({ type: ["string", "null"] }, "3.1");
    expect(from30).toEqual(from31);
    expect(from30.types).toEqual(["string", "null"]);
  });

  it("normalizes 3.1 const to a single-value enum", () => {
    expect(normalizeSchema({ const: "ok" }, "3.1")).toEqual({ enum: ["ok"] });
  });

  it("collapses 3.1 examples arrays to a single example", () => {
    const from30 = normalizeSchema({ type: "string", example: "Bella" }, "3.0");
    const from31 = normalizeSchema({ type: "string", examples: ["Bella"] }, "3.1");
    expect(from30).toEqual(from31);
    expect(from31.example).toBe("Bella");
  });

  it("keeps annotations next to $ref", () => {
    const schema = normalizeSchema(
      { $ref: "#/components/schemas/Pet", description: "The pet" },
      "3.1"
    );
    expect(schema).toEqual({ $ref: "#/components/schemas/Pet", description: "The pet" });
  });

  it("recurses into properties, items, combinators, and additionalProperties", () => {
    const schema = normalizeSchema(
      {
        type: "object",
        required: ["a"],
        properties: {
          a: { type: "string", nullable: true },
          b: { type: "array", items: { type: "integer" } },
        },
        additionalProperties: { type: "number" },
        oneOf: [{ type: "string" }, { type: "number" }],
      },
      "3.0"
    );
    expect(schema.properties!["a"]).toEqual({ types: ["string", "null"] });
    expect(schema.properties!["b"]!.items).toEqual({ types: ["integer"] });
    expect(schema.additionalProperties).toEqual({ types: ["number"] });
    expect(schema.oneOf).toEqual([{ types: ["string"] }, { types: ["number"] }]);
    expect(schema.required).toEqual(["a"]);
  });

  it("handles boolean and empty schemas", () => {
    expect(normalizeSchema(true, "3.1")).toEqual({});
    expect(normalizeSchema({}, "3.1")).toEqual({});
    expect(normalizeSchema(false, "3.1")).toEqual({ enum: [] });
    expect(normalizeSchema(undefined, "3.1")).toEqual({});
  });

  it("folds annotation-only allOf members into the parent", () => {
    const schema = normalizeSchema(
      {
        allOf: [
          { $ref: "#/components/schemas/AccessLevel" },
          { description: "The access level of the user.", readOnly: true },
        ],
      },
      "3.1"
    );
    expect(schema).toEqual({
      allOf: [{ $ref: "#/components/schemas/AccessLevel" }],
      description: "The access level of the user.",
    });
  });

  it("keeps the parent's own annotations when folding allOf members", () => {
    const schema = normalizeSchema(
      {
        description: "Parent wins",
        allOf: [{ description: "Member loses", example: "e" }, { type: "string" }],
      },
      "3.1"
    );
    expect(schema).toEqual({
      allOf: [{ types: ["string"] }],
      description: "Parent wins",
      example: "e",
    });
  });

  it("drops allOf entirely when every member is annotation-only", () => {
    const schema = normalizeSchema({ allOf: [{ readOnly: true }, { description: "d" }] }, "3.1");
    expect(schema).toEqual({ description: "d" });
  });

  it("leaves allOf untouched when all members carry type information", () => {
    const schema = normalizeSchema(
      { allOf: [{ $ref: "#/components/schemas/A" }, { type: "object" }] },
      "3.1"
    );
    expect(schema.allOf).toEqual([{ $ref: "#/components/schemas/A" }, { types: ["object"] }]);
  });

  it("dedupes type arrays and preserves format/annotations", () => {
    const schema = normalizeSchema(
      {
        type: ["string", "string", "null"],
        format: "date-time",
        description: "When it shipped",
        deprecated: true,
        default: null,
      },
      "3.1"
    );
    expect(schema).toEqual({
      types: ["string", "null"],
      format: "date-time",
      description: "When it shipped",
      deprecated: true,
      default: null,
    });
  });
});
