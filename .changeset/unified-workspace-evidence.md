---
"@melandlabs/workspace": minor
"@melandlabs/memory-store": minor
---

Add Chinese lexical matching and user-scoped, versioned Workspace citations. Integrate Workspace evidence into unified retrieval with provenance-preserving fusion, explicit source availability, and bounded retrieval waits. Support conditional metadata revisions and deduplicate embedding jobs for the same resource version.

Direct Workspace store callers must now supply `user_id` when resolving citations or expanding neighbors. Existing SQLite lexical indexes are rebuilt atomically on initialization.
