/**
 * Config-file support for the generator. A project can keep all generation
 * settings in an `openapi-sdk.config.{ts,mjs,js,json}` file and run the CLI with
 * no flags (or `--config <path>`), the same way tools like `drizzle.config.ts`
 * work. {@link defineConfig} is an identity helper that gives the config file
 * full type-checking and editor autocomplete.
 *
 * @example
 * ```ts
 * // openapi-sdk.config.ts
 * import { defineConfig } from "@narthia/openapi-sdk-generator";
 *
 * export default defineConfig({
 *   input: "https://api.example.com/openapi.json",
 *   output: "./src/sdk",
 *   auth: { basic: { usernameField: "email", passwordField: "apiToken" } },
 * });
 * ```
 */
import type { GenerateOptions } from "./generator/generate.ts";

/** The shape of an `openapi-sdk.config.*` file (same options as {@link generateSdk}). */
export type Config = GenerateOptions;

/** Identity helper that types an SDK-generator config file. */
export function defineConfig(config: Config): Config {
  return config;
}
