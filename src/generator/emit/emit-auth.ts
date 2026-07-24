/**
 * Emits the generated SDK's bespoke auth config type and the `toRuntimeAuth`
 * adapter that maps the (possibly renamed) config fields back to the runtime
 * {@link AuthConfig} shape. Only used when auth is configured; otherwise the
 * index emitter falls back to the generic runtime `ClientConfig`.
 */
import type { EmitContext, ResolvedAuth, ResolvedAuthScheme } from "./ts-writer.ts";
import { isValidPropertyName, pascalCase, propertyKey } from "../names.ts";

/** Name of the private adapter function generated alongside the SDK factory. */
export const AUTH_ADAPTER_NAME = "toRuntimeAuth";

/** Name of the generated auth config type, e.g. `CreateSdkAuthConfig`. */
export function authConfigTypeName(ctx: EmitContext): string {
  const name = ctx.sdkName;
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}AuthConfig`;
}

/** Whether any scheme needs the runtime `ValueOrFactory` type (bearer/apiKey do; basic doesn't). */
export function authNeedsValueOrFactory(auth: ResolvedAuth): boolean {
  return auth.schemes.some((s) => s.type === "bearer" || s.type === "apiKey");
}

/** Emit the exported auth config type declaration(s). */
export function emitAuthConfigType(auth: ResolvedAuth, ctx: EmitContext): string[] {
  const typeName = authConfigTypeName(ctx);

  if (auth.schemes.length === 1) {
    return [
      `/** Auth accepted by \`${ctx.sdkName}\`. */`,
      `export interface ${typeName} {`,
      ...schemeFieldLines(auth.schemes[0]!, "  "),
      "}",
    ];
  }

  const lines: string[] = [];
  const memberNames = auth.schemes.map((s) => `${typeName}${pascalCase(s.key)}`);
  auth.schemes.forEach((scheme, i) => {
    lines.push(`export interface ${memberNames[i]} {`);
    lines.push(`  type: ${JSON.stringify(scheme.key)};`);
    lines.push(...schemeFieldLines(scheme, "  "));
    lines.push("}");
    lines.push("");
  });

  lines.push(`/** Auth accepted by \`${ctx.sdkName}\` (pick one scheme). */`);
  lines.push(`export type ${typeName} = ${memberNames.join(" | ")};`);
  return lines;
}

/** Emit the private `toRuntimeAuth` adapter. */
export function emitAuthAdapter(auth: ResolvedAuth, ctx: EmitContext): string[] {
  const typeName = authConfigTypeName(ctx);
  const lines: string[] = [`function ${AUTH_ADAPTER_NAME}(auth: ${typeName}): AuthConfig {`];

  if (auth.schemes.length === 1) {
    lines.push(`  return ${runtimeAuthExpr(auth.schemes[0]!, "auth")};`);
    lines.push("}");
    return lines;
  }

  lines.push("  switch (auth.type) {");
  for (const scheme of auth.schemes) {
    lines.push(`    case ${JSON.stringify(scheme.key)}:`);
    lines.push(`      return ${runtimeAuthExpr(scheme, "auth")};`);
  }
  lines.push("  }");
  lines.push("  throw new Error(`Unknown auth scheme: ${(auth as { type: string }).type}`);");
  lines.push("}");
  return lines;
}

/** Property lines for one scheme's config fields (no discriminant). */
function schemeFieldLines(scheme: ResolvedAuthScheme, indent: string): string[] {
  switch (scheme.type) {
    case "bearer":
      return [`${indent}${propertyKey(scheme.field)}: ValueOrFactory;`];
    case "apiKey":
      return [`${indent}${propertyKey(scheme.field)}: ValueOrFactory;`];
    case "basic":
      return [
        `${indent}${propertyKey(scheme.usernameField)}: string;`,
        `${indent}${propertyKey(scheme.passwordField)}: string;`,
      ];
  }
}

/** Runtime `AuthConfig` object literal for one scheme, reading fields off `obj`. */
function runtimeAuthExpr(scheme: ResolvedAuthScheme, obj: string): string {
  switch (scheme.type) {
    case "bearer":
      return `{ type: "bearer", token: ${memberAccess(obj, scheme.field)} }`;
    case "apiKey":
      return `{ type: "apiKey", in: ${JSON.stringify(scheme.in)}, name: ${JSON.stringify(
        scheme.name
      )}, value: ${memberAccess(obj, scheme.field)} }`;
    case "basic":
      return `{ type: "basic", username: ${memberAccess(
        obj,
        scheme.usernameField
      )}, password: ${memberAccess(obj, scheme.passwordField)} }`;
  }
}

/** `obj.key` when `key` is a valid identifier, else `obj["key"]`. */
function memberAccess(obj: string, key: string): string {
  return isValidPropertyName(key) ? `${obj}.${key}` : `${obj}[${JSON.stringify(key)}]`;
}
