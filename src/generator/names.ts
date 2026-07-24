/** Identifier sanitization, casing, reserved words, and collision handling. */

const RESERVED_WORDS = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "await",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
]);

/** Split an arbitrary string into words on non-alphanumerics and case boundaries. */
function splitWords(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
}

export function camelCase(input: string): string {
  const words = splitWords(input);
  if (words.length === 0) return "";
  return words
    .map((word, i) => {
      if (i === 0)
        return isAcronym(word) ? word.toLowerCase() : word.charAt(0).toLowerCase() + word.slice(1);
      return capitalize(word);
    })
    .join("");
}

export function pascalCase(input: string): string {
  return splitWords(input).map(capitalize).join("");
}

export function kebabCase(input: string): string {
  return splitWords(input)
    .map((w) => w.toLowerCase())
    .join("-");
}

export function snakeCase(input: string): string {
  return splitWords(input)
    .map((w) => w.toLowerCase())
    .join("_");
}

/** All-caps words are treated as acronyms so `APIKey` → `apiKey`, `X-Request-ID` → `xRequestId`. */
function isAcronym(word: string): boolean {
  return word.length > 1 && word === word.toUpperCase();
}

function capitalize(word: string): string {
  const rest = isAcronym(word) ? word.slice(1).toLowerCase() : word.slice(1);
  return word.charAt(0).toUpperCase() + rest;
}

/** Make a string a valid, non-reserved TS identifier (camelCase for values/methods). */
export function identifier(input: string): string {
  let name = camelCase(input);
  if (name === "") name = "value";
  if (/^[0-9]/.test(name)) name = `_${name}`;
  if (RESERVED_WORDS.has(name)) name = `${name}_`;
  return name;
}

/** Make a string a valid PascalCase type name. Degenerate inputs get a `Schema` prefix. */
export function typeName(input: string): string {
  let name = pascalCase(input);
  if (name === "") name = "Schema";
  if (/^[0-9]/.test(name)) name = `Schema${name}`;
  return name;
}

/** True when a property name can be emitted unquoted in a TS object type. */
export function isValidPropertyName(name: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name);
}

/** Quote a property name for emission when needed. */
export function propertyKey(name: string): string {
  return isValidPropertyName(name) ? name : JSON.stringify(name);
}

/**
 * Synthesize a method name from an HTTP method + path when `operationId` is
 * missing: `GET /users/{id}/posts` → `getUsersByIdPosts`.
 */
export function synthesizeMethodName(httpMethod: string, path: string): string {
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const param = segment.match(/^\{(.+)\}$/);
      return param ? `By ${param[1]}` : segment;
    });
  return identifier([httpMethod, ...segments].join(" "));
}

/**
 * Per-scope name registry: returns the name unchanged when free, otherwise
 * appends the smallest numeric suffix that is (`getUser` → `getUser2`).
 */
export class NameRegistry {
  private readonly used = new Set<string>();

  claim(name: string): string {
    if (!this.used.has(name)) {
      this.used.add(name);
      return name;
    }
    let i = 2;
    while (this.used.has(`${name}${i}`)) i++;
    const unique = `${name}${i}`;
    this.used.add(unique);
    return unique;
  }

  has(name: string): boolean {
    return this.used.has(name);
  }
}
