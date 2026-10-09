---
"@melandlabs/audit": patch
---

Import `node:fs` and `node:child_process` as default rather than namespace imports in `installAuditInterceptors`.

`import * as fs from "node:fs"` binds an ES module namespace object, whose properties are getter-only accessors. Every monkey-patched assignment therefore threw `TypeError: Cannot set property readFileSync of [object Module] which has only a getter`, and the whole install — `fs` *and* `child_process` — aborted on the first line. The failure was invisible in CJS bundles, where the same import lowers to `require("fs")` and lands on a mutable exports object, so it only surfaced once a consumer bundled the package as real ESM (Next.js server chunks on Vercel logged it on every cold start). A non-zero `installed` flag meant the audit trail was silently dead for the life of the process.

The default import is the live CommonJS exports object — mutable and shared process-wide, so it is the only form that intercepts anything at all. Callers that had worked around the symptom by gating the call on their own environment can drop that workaround once they upgrade.