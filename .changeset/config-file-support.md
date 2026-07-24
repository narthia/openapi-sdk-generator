---
"@narthia/openapi-sdk-generator": minor
---

Add config-file support. Keep all generation settings in an
`openapi-sdk.config.{ts,mjs,js,json}` file (typed via the new `defineConfig`
helper) and run the CLI with no flags - it auto-discovers the config in the
working directory, or takes an explicit `--config <path>`. CLI flags override
config values. Config files are loaded with native `import()` (no added
dependency); `.ts` configs use Node's built-in type stripping (Node >= 22.6),
while `.mjs`/`.js`/`.json` work on any supported Node.
