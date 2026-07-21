/** JSDoc block assembly shared by all emitters. */

export interface JsDocInput {
  summary?: string;
  description?: string;
  /** `@param name - description` entries, already fully qualified (e.g. `options.path.userId`). */
  params?: { name: string; description?: string }[];
  returns?: string;
  /** `true` for a bare `@deprecated`, or a string reason. */
  deprecated?: boolean | string;
  /** `@see <url> <description>` from externalDocs. */
  see?: { url: string; description?: string };
  /** Rendered as a fenced `@example` block when present. */
  example?: unknown;
  default?: unknown;
  /** OpenAPI string format hint (`date-time`, `uuid`, ...) rendered as `@format`. */
  format?: string;
}

/**
 * Build a JSDoc comment block, or return `undefined` when there is nothing to say.
 * Every line is prefixed with `indent`; content is sanitized so it cannot
 * terminate the comment early.
 */
export function buildJsDoc(input: JsDocInput, indent = ""): string | undefined {
  const body: string[] = [];

  const summary = sanitize(input.summary);
  const description = sanitize(input.description);
  if (summary) body.push(...summary.split("\n"));
  if (description && description !== summary) {
    if (body.length > 0) body.push("");
    body.push(...description.split("\n"));
  }

  const tags: string[] = [];
  for (const param of input.params ?? []) {
    const desc = sanitize(param.description);
    tags.push(`@param ${param.name}${desc ? ` - ${collapse(desc)}` : ""}`);
  }
  if (input.default !== undefined) tags.push(`@default ${JSON.stringify(input.default)}`);
  if (input.format) tags.push(`@format ${sanitize(input.format)}`);
  const returns = sanitize(input.returns);
  if (returns) tags.push(`@returns ${collapse(returns)}`);
  if (input.deprecated) {
    tags.push(
      typeof input.deprecated === "string"
        ? `@deprecated ${collapse(sanitize(input.deprecated) ?? "")}`
        : "@deprecated"
    );
  }
  if (input.see) {
    const desc = sanitize(input.see.description);
    tags.push(`@see ${sanitize(input.see.url)}${desc ? ` ${collapse(desc)}` : ""}`);
  }
  if (input.example !== undefined) {
    tags.push("@example", "```json", ...JSON.stringify(input.example, null, 2).split("\n"), "```");
  }

  if (tags.length > 0) {
    if (body.length > 0) body.push("");
    body.push(...tags);
  }
  if (body.length === 0) return undefined;

  if (body.length === 1) return `${indent}/** ${body[0]} */`;
  return [
    `${indent}/**`,
    ...body.map((line) => `${indent} * ${line}`.trimEnd()),
    `${indent} */`,
  ].join("\n");
}

/** Normalize newlines and neutralize comment terminators so content cannot close the block. */
function sanitize(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const cleaned = text.replace(/\r\n?/g, "\n").replace(/\*\//g, "*\\/").trim();
  return cleaned === "" ? undefined : cleaned;
}

/** Collapse multi-line text into a single line for tag positions. */
function collapse(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}
