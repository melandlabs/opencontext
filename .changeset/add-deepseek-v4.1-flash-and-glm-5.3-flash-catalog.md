---
"@melandlabs/ai": patch
---

Add `deepseek/deepseek-v4.1-flash` and `qwen/qwen3.8-flash` to the model pricing catalog and `CLAUDE_METADATA.supportedModels`.

* `deepseek/deepseek-v4.1-flash`: input $0.15 / output $0.60 per 1M tokens; natively multimodal (text + image in); reasoning always on. Used as the gateway default fallback in the September 2026 alloomi rollout.
* `qwen/qwen3.8-flash`: input $0.15 / output $0.47 per 1M tokens; text-only (no upstream vision); reasoning capable. Was the previous alloomi default primary; kept registered for A/B testing.

Also brings `CLAUDE_METADATA.supportedModels` into parity with `MODEL_PRICING` for `z-ai/glm-5.2`, `z-ai/glm-5.3`, `z-ai/glm-5.3-flash`, `minimax/minimax-m3`, `deepseek/deepseek-v4.1-flash`, and `qwen/qwen3.8-flash`. No breaking changes.