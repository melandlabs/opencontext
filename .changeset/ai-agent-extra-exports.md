---
"@melandlabs/ai": minor
---

Surface the additional `agent/*` subpaths required by alloomi (and other downstream consumers):

- `agent/registry`
- `agent/cli-process`
- `agent/prompt-context`
- `agent/claude/cli-locations`
- `agent/runtime/output-event-bus`
- `agent/billing/{index,model-pricing}`
- `agent/compaction/{index,compaction,compaction-client}`
- `agent/model/index`
- `agent/routing/index`
- `agent/codex/{index,command,interrupt-marker,metadata,parser,runtime-preflight,transport-status}`
- `agent/hermes/{index,command,metadata}`
- `agent/openclaw/{index,command,metadata}`
- `agent/opencode/{index,command,metadata,parser}`
- `agent/standalone/{index,metadata}`
- `agent/acp/{agent,mapper,stdio-client}`
- `agent/native-agent/{native-runner,provider-env,register-provider,runtime-contract,runtime-preference,runtime-probe}`

`StandAloneAgent.run` now resolves the model through `createDynamicModel(isNativeMode, modelName)` — cloud auth must be configured by calling `setAIUserContext` (with the user JWT) before the agent runs; the standalone agent itself no longer threads `authToken` into the model factory.