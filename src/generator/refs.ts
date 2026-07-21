/** Local JSON-pointer ($ref) resolution. External refs are not supported in v1. */

export function isLocalRef(ref: string): boolean {
  return ref.startsWith("#/");
}

/** The last segment of a `#/components/schemas/<Name>` pointer, or undefined. */
export function componentSchemaName(ref: string): string | undefined {
  const match = ref.match(/^#\/components\/schemas\/([^/]+)$/);
  return match ? decodePointerSegment(match[1]!) : undefined;
}

/**
 * Resolve a local `#/...` JSON pointer against the document.
 * Throws a contextual error for external refs and dangling pointers.
 */
export function resolveRef(doc: Record<string, unknown>, ref: string): unknown {
  if (!isLocalRef(ref)) {
    throw new Error(
      `External $ref "${ref}" is not supported. Bundle the spec into a single document first.`
    );
  }
  let current: unknown = doc;
  const segments = ref.slice(2).split("/").map(decodePointerSegment);
  for (const segment of segments) {
    if (typeof current !== "object" || current === null) {
      throw new Error(`Cannot resolve $ref "${ref}": path does not exist.`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) {
    throw new Error(`Cannot resolve $ref "${ref}": target not found.`);
  }
  return current;
}

/**
 * Resolve a possibly-$ref-wrapped object (parameter, requestBody, response)
 * to its target. Schema $refs are handled separately (they become named types).
 */
export function derefObject<T>(doc: Record<string, unknown>, value: T): T {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>)["$ref"] === "string"
  ) {
    return resolveRef(doc, (value as Record<string, unknown>)["$ref"] as string) as T;
  }
  return value;
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
