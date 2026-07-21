import { oxfmtConfig, oxlintConfig } from "@narthia/toolkit/oxc-config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    // Allow non-lintable staged files such as README.md and package.json.
    "*": "vp check --fix --no-error-on-unmatched-pattern",
  },
  pack: {
    entry: ["src/index.ts", "src/*/index.ts", "src/transports/*/index.ts"],
    deps: {
      neverBundle: ["oxfmt", "oxlint"],
      dts: {
        neverBundle: ["oxfmt", "oxlint"],
      },
    },
    exports: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
  lint: {
    ...oxlintConfig,
  },
  fmt: {
    ...oxfmtConfig,
  },
});
