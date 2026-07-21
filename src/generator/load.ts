import { readFile } from "node:fs/promises";

export type SpecInput = string | URL | Record<string, unknown>;

/**
 * Load an OpenAPI document from a file path, an http(s) URL, or an in-memory object.
 * JSON only — YAML input produces a clear error.
 */
export async function loadSpec(input: SpecInput): Promise<Record<string, unknown>> {
  if (typeof input === "object" && !(input instanceof URL)) {
    // Clone so generation never mutates the caller's object.
    return structuredClone(input);
  }

  const asString = String(input);
  if (input instanceof URL || /^https?:\/\//.test(asString)) {
    return loadFromUrl(asString);
  }
  return loadFromFile(asString);
}

async function loadFromUrl(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`Failed to fetch OpenAPI spec from ${url}: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return parseJsonSpec(text, url);
}

async function loadFromFile(path: string): Promise<Record<string, unknown>> {
  if (/\.ya?ml$/i.test(path)) {
    throw new Error(
      `YAML specs are not yet supported (${path}). Convert the spec to JSON and try again.`
    );
  }
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    throw new Error(`Failed to read OpenAPI spec file at ${path}`, { cause });
  }
  return parseJsonSpec(text, path);
}

function parseJsonSpec(text: string, source: string): Record<string, unknown> {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) {
    throw new Error(
      `OpenAPI spec at ${source} is not a JSON object. YAML specs are not yet supported — convert to JSON.`
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(`OpenAPI spec at ${source} is not valid JSON`, { cause });
  }
}
