---
"@melandlabs/sqlite": patch
---

Cap the widening vector-scan limit at sqlite-vec's max k (4096) so raw-message similarity search no longer throws "k value in knn query too large" on sparse matches.
