---
"@melandlabs/ai": patch
---

Fix OpenRouter pricing entries verified against the live API on 2026-09-28:

- `deepseek/deepseek-v4.1-flash`: input $0.15 → $0.035, output $0.60 → $0.29 per 1M tokens. The previous values were stale from a Sept 2026 rollout draft; the upstream list price is materially lower. Reasoning is always on; the model is natively multimodal (text + image in).
- `qwen/qwen3.8-flash`: `supportsVision` false → true. The model is multimodal (text + image + video in) per the OpenRouter model card; the prior "text-only" assumption was incorrect.
- `minimax/minimax-m3`: `supportsVision` false → true. Same reason as above (text + image + video in).
- `z-ai/glm-5.3-flash`: comment-only update — the upstream cache_read is $0.03/M (verified), and the model is officially published on OpenRouter (`zai-org/GLM-5.3-Flash`) rather than a placeholder. The earlier "未在 Z.AI 公开文档中正式公布" caveat in the alloomi gateway README was inaccurate and is removed in a follow-up commit there.