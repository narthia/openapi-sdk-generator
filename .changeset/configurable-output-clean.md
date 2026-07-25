---
"@narthia/openapi-sdk-generator": minor
---

Add a `clean` option to control whether the output directory is emptied before generating.

The output directory is still wiped by default, so files from a previous run (removed operations, renamed services, dropped inputs) never linger. Set `clean: false` (or pass `--no-clean` on the CLI) to write over the existing contents instead, leaving unrelated files in place - useful when the output directory also holds hand-maintained files. Regenerated files are overwritten either way.

The cleanup step now also retries on transient filesystem errors, which Windows reports when an editor, watcher, or virus scanner is holding a generated file open.
