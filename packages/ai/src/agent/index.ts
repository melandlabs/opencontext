/**
 * @melandlabs/agent - Agent SDK Abstraction Layer
 *
 * Core types, base class, plugin system, and registry for agent providers.
 */

// Types
// ProviderCapabilities and ProviderMetadata intentionally omitted here —
// the root package re-exports them from `./types` (the IProvider base types),
// and TypeScript treats two structurally-identical interfaces declared in
// different files as distinct identifiers.
export type {
	AgentConfig,
	AgentMessage,
	AgentMessageType,
	AgentOptions,
	BuiltinAgentProvider,
	AgentProvider,
	AgentQuestion,
	AgentRequest,
	AgentSession,
	AgentSubagentDefinition,
	ConversationMessage,
	ExecuteOptions,
	FileAttachment,
	IAgent,
	ImageAttachment,
	McpConfig,
	ModelConfig,
	PDFAttachment,
	PlanOptions,
	PlanStep,
	Question,
	QuestionOption,
	SandboxConfig,
	SandboxProviderType,
	SkillsConfig,
	TaskPlan,
	ToolDefinition,
	AgentFactory,
	AgentRegistryInterface,
} from "./types";

export { DEFAULT_ALLOWED_TOOLS } from "./types";
export { appendAgentUserContext } from "./user-context";

// Compaction preprocessing
// Exported from the package root so apps can depend on the shared algorithm
// without reaching into app-specific source paths.
export {
	sanitizeCompactionMessage,
	sanitizeCompactionMessages,
	groupCompactionMessages,
	flattenCompactionGroups,
	truncateOldestCompactionGroups,
	preprocessCompactionMessages,
	type CompactionPreprocessMessage,
	type CompactionMessageGroup,
	type CompactionPreprocessOptions,
} from "./compaction-preprocess";

// Plugin system
// ProviderMetadata intentionally omitted — see the comment above the ./types
// re-export; the canonical ProviderMetadata lives in the root `./types`.
export {
	defineAgentPlugin,
	CLAUDE_CONFIG_SCHEMA,
	DEEPAGENTS_CONFIG_SCHEMA,
	CLAUDE_METADATA,
	DEEPAGENTS_METADATA,
	STANDALONE_METADATA,
	DEFAULT_AGENT_MODEL,
	DEFAULT_WORK_DIR,
	type AgentPlugin,
	type AgentProviderMetadata,
} from "./plugin";

// Per-provider metadata + JSON Schemas. The Codex/Hermes/OpenClaw/OpenCode
// metadata constants live next to their concrete agent classes
// (`./providers/<name>/metadata.ts`) so the schemas can describe the
// provider-specific config knobs (e.g. codex sandbox modes, openclaw
// gateway options). Claude/DeepAgents/Standalone remain on `./plugin`
// above for historical reasons.
export {
	CODEX_CONFIG_SCHEMA,
	CODEX_METADATA,
} from "./providers/codex/metadata";
export {
	HERMES_CONFIG_SCHEMA,
	HERMES_METADATA,
} from "./providers/hermes/metadata";
export {
	OPENCLAW_CONFIG_SCHEMA,
	OPENCLAW_METADATA,
} from "./providers/openclaw/metadata";
export {
	OPENCODE_CONFIG_SCHEMA,
	OPENCODE_METADATA,
} from "./providers/opencode/metadata";

// Base agent
export {
	BaseAgent,
	CLAUDE_CODE_READ_TOOL_WORKAROUND_INSTRUCTION,
	PLANNING_INSTRUCTION,
	getWorkspaceInstruction,
	formatPlanForExecution,
	parsePlanningResponse,
	parsePlanFromResponse,
	getLanguageInstructionForBase,
	getProfessionalOutputStyleInstruction,
	withClaudeCodeReadToolWorkaroundForSubagents,
	withClaudeCodeReadToolWorkaround,
	type AgentCapabilities,
	type SandboxOptions,
	type PlanningResponse,
} from "./base";

// Registry
export {
	AgentRegistry,
	getAgentRegistry,
	registerAgentProvider,
	registerAgentPlugin,
	createAgentFromConfig,
	getAgentInstance,
	getAvailableAgentProviders,
	getRegisteredAgentProviders,
	getAllAgentMetadata,
	stopAllAgentProviders,
} from "./registry";

// Sandbox
export * from "./sandbox";

// NOTE: the following modules are intentionally NOT re-exported from this
// barrel because their top-level names already live on the package root
// (via the historical `export { ... } from "./agent"` block in
// `packages/ai/src/index.ts`). Re-exporting them here would create
// duplicate-identifier errors once the root barrel pulls in `./agent/index`.
// Import them from `./<submodule>` (subpath exports) or
// from the package root directly:
//
//   - ./billing         → MODEL_PRICING, getModelPricing, calculate*Credits, ...
//   - ./compaction      → COMPACTION_*, triggerCompaction, buildCompactionPrompt, ...
//   - ./context         → prepareConversationWindows, getConversationBucket, ...
//   - ./model           → getModel, getVLMModel, createDynamicModel, getModelProvider, ...
//   - ./routing         → routeModelCall, checkCloudAIAvailability, getRecommendedMode
//   - ./utils           → extractJsonFromMarkdown (already on the root)

// Runtime
export * from "./runtime";

// Live supplemental input for active agent runs
export * from "./supplemental-input";

// Runtime Goal and instruction protocol
export * from "./runtime-instructions";

// Native agent runner
export * from "./native-runner";

// Native agent CLI
export * from "./native-cli";

// Video Generation
export * from "./video-gen";

// Image Generation
export * from "./image-gen";

// Built-in provider implementations
export {
	StandaloneAgent,
	standaloneAgentPlugin,
} from "./providers/standalone";
export {
	ClaudeAgent,
	createClaudeAgent,
	claudeAgentPlugin,
} from "./providers/claude";
export {
	CodexAgent,
	createCodexAgent,
	codexAgentPlugin,
} from "./providers/codex";
export {
	HermesAgent,
	hermesAgentPlugin,
} from "./providers/hermes";
export {
	OpenClawAgent,
	openclawAgentPlugin,
} from "./providers/openclaw";
export {
	OpenCodeAgent,
	opencodeAgentPlugin,
} from "./providers/opencode";

// Language directive (ports + default adapter)
export type {
	DirectiveChannel,
	LanguageDirectiveBuilder,
} from "./ports/language-directive.port";
export {
	DefaultLanguageDirectiveBuilder,
	defaultLanguageDirectiveBuilder,
} from "./adapters/default-language-directive-builder";
