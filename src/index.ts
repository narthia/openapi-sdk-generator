/**
 * `@narthia/openapi-sdk-generator` — generate fully typed, JSDoc-documented
 * TypeScript SDKs from OpenAPI 3.0/3.1 documents.
 *
 * - This root export is the generator (programmatic API).
 * - `./client` is the runtime client core generated SDKs run on.
 * - `./transports/http` is the fetch-based HTTP transport; other transports
 *   (serverless invokes, in-platform bridges, ...) plug into the same `Transport` interface.
 */
export { generateSdk } from "./generator/generate.ts";
export type {
  AuthOption,
  GeneratedFile,
  GenerateOptions,
  GenerateResult,
  SharedOptions,
  TargetOptions,
} from "./generator/generate.ts";
export { defineConfig } from "./config.ts";
export type { Config } from "./config.ts";
export type { CollisionCase, RuntimeMode, TransportName } from "./generator/emit/ts-writer.ts";
export type { SpecInput } from "./generator/load.ts";
