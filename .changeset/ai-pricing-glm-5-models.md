---
"@melandlabs/ai": minor
---

Add OpenRouter pricing for `z-ai/glm-5.2` and `z-ai/glm-5.3-flash` so they can be selected through `AgentOptions.model` like the other Zhipu entries.

- `z-ai/glm-5.2`: input $0.50/M, output $3.15/M, no vision.
- `z-ai/glm-5.3-flash`: input $0.15/M, output $0.50/M, supports vision. Listed price reflects the 50% launch promo (input $0.075 / output $0.25 per-token basis) that expires 2026-09-09; bump the entry when OpenRouter flips back to list.
