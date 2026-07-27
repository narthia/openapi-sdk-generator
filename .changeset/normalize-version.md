---
"@narthia/openapi-sdk-generator": minor
---

Add a `normalizeVersion` option that strips a `-SNAPSHOT-<sha>` build id from the API version documented on the generated SDK factory.

Some providers append a per-deploy build id to `info.version`, publishing something like `1001.0.0-SNAPSHOT-<git sha>`, where the suffix changes on every redeploy - and can differ between CDN edges at the same moment - independently of any API change. Embedded verbatim, it makes every regeneration produce a one-line diff that reflects nothing but the build id.

With `normalizeVersion: true` (or `--normalize-version`), `1001.0.0-SNAPSHOT-b5920d1e...` is documented as `1001.0.0`, so regenerating from a redeployed spec yields identical output. Only a trailing `-SNAPSHOT-<hex>` of at least seven characters (a git short sha) is removed; everything else passes through unchanged, including a bare `-SNAPSHOT`, which is stable across deploys and never causes churn.

Defaults to `false`, so existing output is unaffected.
