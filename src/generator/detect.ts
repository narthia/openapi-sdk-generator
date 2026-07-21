export type OpenApiMode = "3.0" | "3.1";

/**
 * Detect the OpenAPI version and sanity-check the document shape.
 * Swagger 2.0 and unknown versions produce explicit errors.
 */
export function detectVersion(spec: Record<string, unknown>): OpenApiMode {
  if (typeof spec["swagger"] === "string") {
    throw new Error(
      `Swagger ${spec["swagger"]} is not supported. Convert the spec to OpenAPI 3.0 or 3.1.`
    );
  }

  const openapi = spec["openapi"];
  if (typeof openapi !== "string") {
    throw new Error('Not an OpenAPI document: missing "openapi" version field.');
  }

  let mode: OpenApiMode;
  if (openapi.startsWith("3.0")) mode = "3.0";
  else if (openapi.startsWith("3.1")) mode = "3.1";
  else {
    throw new Error(`Unsupported OpenAPI version "${openapi}". Supported: 3.0.x and 3.1.x.`);
  }

  const paths = spec["paths"];
  if (
    paths !== undefined &&
    (typeof paths !== "object" || paths === null || Array.isArray(paths))
  ) {
    throw new Error('Invalid OpenAPI document: "paths" must be an object.');
  }

  return mode;
}
