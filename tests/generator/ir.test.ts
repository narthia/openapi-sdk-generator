import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { IrDocument, IrType } from "../../src/generator/ir.ts";
import { buildIr, collectRefs } from "../../src/generator/ir.ts";

async function petstoreIr(version: "3.0" | "3.1"): Promise<IrDocument> {
  const raw = await readFile(
    new URL(`../fixtures/petstore-${version}.json`, import.meta.url),
    "utf8"
  );
  return buildIr(JSON.parse(raw), version);
}

describe("buildIr on petstore", () => {
  it("groups operations by tag with path fallback for untagged ops", async () => {
    const ir = await petstoreIr("3.0");
    const names = ir.services.map((s) => s.name).sort();
    expect(names).toEqual(["health", "pets", "store"]);

    const pets = ir.services.find((s) => s.name === "pets")!;
    expect(pets.docs.description).toBe("Everything about pets");
    // Operations iterate in HTTP-method order (get before post) within a path.
    expect(pets.operations.map((o) => o.methodName)).toEqual([
      "listPets",
      "createPet",
      "getPetById",
      "deletePet",
      "downloadPetPhoto",
      "uploadPetPhoto",
    ]);

    const health = ir.services.find((s) => s.name === "health")!;
    expect(health.operations[0]!.methodName).toBe("getHealth");
  });

  it("splits parameters by location and marks path params required", async () => {
    const ir = await petstoreIr("3.0");
    const getPet = ir.services
      .find((s) => s.name === "pets")!
      .operations.find((o) => o.methodName === "getPetById")!;

    expect(getPet.pathParams).toHaveLength(1);
    expect(getPet.pathParams[0]).toMatchObject({
      name: "petId",
      tsName: "petId",
      required: true,
      type: { kind: "number" },
    });
    expect(getPet.headerParams[0]).toMatchObject({
      name: "X-Request-ID",
      tsName: "xRequestId",
      required: false,
    });
    expect(getPet.docs.externalDocs).toEqual({
      url: "https://example.com/docs/pets",
      description: "Pet guide",
    });
  });

  it("types responses from 2xx content and refs", async () => {
    const ir = await petstoreIr("3.0");
    const pets = ir.services.find((s) => s.name === "pets")!;

    const list = pets.operations.find((o) => o.methodName === "listPets")!;
    expect(list.response.type).toEqual({ kind: "array", items: { kind: "ref", name: "Pet" } });
    expect(list.response.responseType).toBe("json");

    const remove = pets.operations.find((o) => o.methodName === "deletePet")!;
    expect(remove.response).toMatchObject({ type: { kind: "void" }, responseType: "void" });
    expect(remove.docs.deprecated).toBe(true);

    const download = pets.operations.find((o) => o.methodName === "downloadPetPhoto")!;
    expect(download.response).toMatchObject({ type: { kind: "binary" }, responseType: "binary" });
  });

  it("selects request body content and encodes multipart as form-data", async () => {
    const ir = await petstoreIr("3.0");
    const pets = ir.services.find((s) => s.name === "pets")!;

    const create = pets.operations.find((o) => o.methodName === "createPet")!;
    expect(create.body).toMatchObject({
      required: true,
      bodyType: "json",
      type: { kind: "ref", name: "NewPet" },
      docs: { description: "The pet to create" },
    });

    const upload = pets.operations.find((o) => o.methodName === "uploadPetPhoto")!;
    expect(upload.body!.bodyType).toBe("form-data");
    expect(upload.body!.type.kind).toBe("object");
    const file = (upload.body!.type as Extract<IrType, { kind: "object" }>).properties.find(
      (p) => p.name === "file"
    )!;
    expect(file.type).toEqual({ kind: "binary" });
  });

  it("converts component schemas with allOf, enums, and nullability", async () => {
    const ir = await petstoreIr("3.0");
    const byName = Object.fromEntries(ir.schemas.map((s) => [s.name, s]));

    expect(byName["Pet"]!.type.kind).toBe("intersection");
    expect(collectRefs(byName["Pet"]!.type)).toEqual(new Set(["NewPet", "Category"]));

    const newPet = byName["NewPet"]!.type as Extract<IrType, { kind: "object" }>;
    const status = newPet.properties.find((p) => p.name === "status")!;
    expect(status.type).toEqual({
      kind: "union",
      variants: [
        { kind: "literal", value: "available" },
        { kind: "literal", value: "pending" },
        { kind: "literal", value: "sold" },
      ],
    });
    const tag = newPet.properties.find((p) => p.name === "tag")!;
    expect(tag.type).toEqual({ kind: "union", variants: [{ kind: "string" }, { kind: "null" }] });
  });

  it("produces identical IR for the 3.0 and 3.1 fixtures", async () => {
    const [ir30, ir31] = await Promise.all([petstoreIr("3.0"), petstoreIr("3.1")]);
    expect(ir30).toEqual(ir31);
  });
});

describe("buildIr edge cases", () => {
  const minimal = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    buildIr({ openapi: "3.1.0", info: { title: "t", version: "1" }, paths, ...extra }, "3.1");

  it("renames colliding method names and records a warning", () => {
    const ir = minimal({
      "/a": { get: { operationId: "getThing", tags: ["x"], responses: {} } },
      "/b": { get: { operationId: "get-thing", tags: ["x"], responses: {} } },
    });
    const ops = ir.services[0]!.operations.map((o) => o.methodName);
    expect(ops).toEqual(["getThing", "getThing2"]);
    expect(ir.warnings.some((w) => w.includes('renamed to "getThing2"'))).toBe(true);
  });

  it("skips cookie params and warns on unsupported query styles", () => {
    const ir = minimal({
      "/a": {
        get: {
          tags: ["x"],
          parameters: [
            { name: "session", in: "cookie", schema: { type: "string" } },
            { name: "filter", in: "query", style: "deepObject", schema: { type: "object" } },
          ],
          responses: {},
        },
      },
    });
    const op = ir.services[0]!.operations[0]!;
    expect(op.queryParams).toHaveLength(1);
    expect(ir.warnings.some((w) => w.includes('Cookie parameter "session"'))).toBe(true);
    expect(ir.warnings.some((w) => w.includes('unsupported style "deepObject"'))).toBe(true);
  });

  it("hoists structurally identical anonymous schemas into one named type", () => {
    const shape = {
      type: "object",
      properties: { total: { type: "integer" }, page: { type: "integer" } },
    };
    const ir = minimal({
      "/a": {
        get: {
          operationId: "getA",
          tags: ["x"],
          responses: {
            "200": { description: "ok", content: { "application/json": { schema: shape } } },
          },
        },
      },
      "/b": {
        get: {
          operationId: "getB",
          tags: ["x"],
          responses: {
            "200": { description: "ok", content: { "application/json": { schema: shape } } },
          },
        },
      },
    });
    const hoisted = ir.schemas.find((s) => s.name === "GetAResponse");
    expect(hoisted).toBeDefined();
    const [a, b] = ir.services[0]!.operations;
    expect(a!.response.type).toEqual({ kind: "ref", name: "GetAResponse" });
    expect(b!.response.type).toEqual({ kind: "ref", name: "GetAResponse" });
  });

  it("resolves parameter and response $refs through components", () => {
    const ir = minimal(
      {
        "/a": {
          get: {
            operationId: "getA",
            tags: ["x"],
            parameters: [{ $ref: "#/components/parameters/Limit" }],
            responses: {
              "404": { $ref: "#/components/responses/NotFound" },
              "204": { description: "ok" },
            },
          },
        },
      },
      {
        components: {
          parameters: {
            Limit: { name: "limit", in: "query", schema: { type: "integer" } },
          },
          responses: {
            NotFound: { description: "missing" },
          },
        },
      }
    );
    const op = ir.services[0]!.operations[0]!;
    expect(op.queryParams[0]).toMatchObject({ name: "limit", type: { kind: "number" } });
    expect(op.response.responseType).toBe("void");
  });

  it("uses the default response as success shape only when no 2xx exists", () => {
    const ir = minimal({
      "/a": {
        get: {
          operationId: "getA",
          tags: ["x"],
          responses: {
            default: {
              description: "whatever",
              content: { "application/json": { schema: { type: "string" } } },
            },
          },
        },
      },
    });
    expect(ir.services[0]!.operations[0]!.response).toMatchObject({
      type: { kind: "string" },
      responseType: "json",
    });
  });
});
