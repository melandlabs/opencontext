---
"@melandlabs/ai": patch
---

Add `agent/structured-call` subpath: `executeStructuredCall`, a single forced-tool LLM call primitive speaking the Anthropic Messages wire format over native fetch, plus the wire-tolerance helpers `extractToolUseInput`, `findShapedObject`, and `extractBalancedJsonObject` generalized from alloomi's digital-employee planner.
