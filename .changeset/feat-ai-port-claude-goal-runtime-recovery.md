---
"@melandlabs/ai": minor
---

Port the `packages/ai` portions of [openloomi#530 Feat/claude goal runtime restart recovery](https://github.com/melandlabs/openloomi/pull/530) so the agent SDK exposes the same durable restart-recovery surface that the openloomi host uses to resume Claude SDK sessions after process shutdown.

New public API in `packages/ai/src/agent/types.ts`:
- `AgentRuntimeRecovery` — trusted host-only state used to reconnect an unfinished runtime to the persisted provider session (carries the durable Runtime Session id, exact provider session id, working directory, fencing epoch, lease token, and delivery settlements).
- `AgentRuntimeInstructionSettlement` — record of whether an instruction was accepted or superseded by the trusted dispatcher.
- `AgentRuntimeRecoveryContinuationResult` — allow/block decision the attached GoalController returns when asked for a canonical continuation after provider loss.
- `AgentRuntimeRecoveryGoalFinalizationResult` — terminal evaluation outcome (no_active_goal / stale / completed / paused).
- `AgentOptions.runtimeRecovery` — host-only field; never accepted from public HTTP payloads.

`packages/ai/src/agent/runtime-instructions/ports.ts`:
- `AgentGoalEvaluationStatePort.commitEvaluation` now accepts `evaluation?: GoalEvaluationResult` and `runtimeLeaseToken?: string` so the trusted persistence layer can fence recovery-only terminal evaluations against lease takeover.

`packages/ai/src/agent/native-runner/index.ts`:
- `NativeAgentRunnerContext` gains `runtimeRecovery` and forwards it through `buildAgentConfig` (new `recoveringRuntime` flag branches `effectiveModelConfig` so a resume reloads only trusted credentials while preserving the model/runtime choices persisted with the provider session) and `buildAgentOptions`.
- `buildNativeAgentPrompt` short-circuits with a `runtime_recovery_uses_provider_transcript` no-op memory context when `context.runtimeRecovery` is set, so Claude's provider resume handle replays the original transcript instead of re-materialising memory/RAG/permission prose.

`packages/ai/src/agent/model/providers.ts`:
- Diagnostic `console.log`/`warn`/`error` in `setAIUserContext`, `createFetchWithContext`, `getOpenAICompatibleBaseUrl`, `getAnthropicCompatibleBaseUrl`, and the Anthropic external-provider activation path — useful for debugging provider initialisation.