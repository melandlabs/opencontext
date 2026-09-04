---
"@melandlabs/memory-store": minor
"@melandlabs/memory-consolidation": patch
---

Add a trusted in-process applicability context to unified memory search, propagate one resolved timestamp through every retrieval provider and reasoning sub-search, and fail closed for built-in raw-message sources that cannot enforce the requested scope. Align graph retrieval on the shared exact-match and validity-window contract.
