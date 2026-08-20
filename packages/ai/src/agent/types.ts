/**
 * Agent SDK Abstraction Layer - Type Definitions
 *
 * This module defines the common interfaces for different agent implementations.
 * Supports Claude Agent SDK, OpenCode, ACP runtimes, and custom implementations.
 */

// ============================================================================
// Re-export from sandbox package
// ============================================================================

import type { WorkspaceArtifactManifest } from "@melandlabs/shared";
import type { PromptCacheStats } from "./billing/model-pricing";
import type { SandboxConfig, SandboxProviderType } from "./sandbox/types";

// Re-export as types (for external consumers)
export type { SandboxConfig, SandboxProviderType };

// ============================================================================
// Minimal inlined types (from provider-core)
// ============================================================================

export interface ProviderCapabilities {
	[key: string]: boolean | string | string[] | undefined;
}

// ============================================================================
// Model Configuration
// ============================================================================

/**
 * Model configuration for custom API endpoints
 */
export interface ModelConfig {
	apiKey?: string;
	baseUrl?: string;
	model?: string;
	thinkingLevel?: "disabled" | "low" | "adaptive";
}

export interface AgentSubagentDefinition {
	/** Natural-language description of when this subagent should be used. */
	description: string;
	/** Dedicated system prompt for the subagent. */
	prompt: string;
	/** Tool names the subagent may use. Omit to inherit provider defaults. */
	tools?: string[];
	/** Tool names explicitly unavailable to the subagent. */
	disallowedTools?: string[];
	/** Model alias or concrete model id. "inherit" uses the parent model. */
	model?: "inherit" | "haiku" | "sonnet" | "opus" | string;
}

// ============================================================================
// Message Types
// ============================================================================

export type AgentMessageType =
	| "session"
	| "text"
	| "tool_use"
	| "tool_result"
	| "result"
	| "error"
	| "done"
	| "plan"
	| "direct_answer"
	| "question"
	| "capabilityRequest"
	| "insightsRefresh"
	| "permission_request"
	| "password_input"
	| "reasoning"
	| "rulesUpdated"
	| "memoryUpdate"
	| "artifact_baseline"
	| "scheduleNotice"
	| "workspace_artifacts"
	| "retry";

/**
 * Minimal structural shape of a host auth session. Mirrors the parts of a
 * next-auth `Session` that agents actually read, without depending on
 * next-auth. The index signature keeps richer host sessions assignable.
 */
export interface AgentAuthSessionUser {
	id?: string;
	email?: string | null;
	name?: string | null;
	image?: string | null;
	[key: string]: unknown;
}

export interface AgentAuthSession {
	user?: AgentAuthSessionUser | null;
	expires?: string;
	[key: string]: unknown;
}

/**
 * Limits connector-backed tools and data to an explicit allowlist.
 *
 * An omitted scope preserves the legacy unrestricted behavior. An empty
 * allowlist intentionally exposes no connector-backed capability.
 */
export interface ConnectorVisibilityScope {
	mode: "allowlist";
	connectorIds: string[];
}

export type AgentToolResultFile = {
	path: string;
	name: string;
	type: string;
	isTemporary?: boolean;
	snapshotPath?: string;
};

export type AgentMultimodalContent = {
	contentType: string;
	mimeType: string;
	data: string;
	sourceType: string;
};

export type AgentToolResultFileMetadata = {
	generatedFiles?: AgentToolResultFile[];
	generatedFile?: AgentToolResultFile;
	codeFile?: {
		path: string;
		name: string;
		language: string;
		snapshotPath?: string;
	};
	/** Inline contents left only when host-side materialization was unavailable. */
	multimodalContents?: AgentMultimodalContent[];
};

export interface AgentMessage {
	type: AgentMessageType;
	/** Unique identifier for deduplication */
	messageId?: string;
	sessionId?: string;
	/** Goal run fence captured when the provider event was observed. */
	runEpoch?: number;
	content?: string;
	name?: string;
	id?: string;
	input?: unknown;
	cost?: number;
	duration?: number;
	/** Tool result fields */
	toolUseId?: string;
	output?: string;
	isError?: boolean;
	/**
	 * Content-addressed snapshots of files this tool result produced, keyed by
	 * the generated-file path as resolved from the tool input/output. Values
	 * are session-relative paths under `.snapshots/`. Attached server-side on
	 * `tool_result` messages so chat message parts can reference the immutable
	 * version that existed when the message was created, even after the live
	 * file is edited in place.
	 */
	fileSnapshots?: Record<string, string>;
	/** Durable file refs resolved at the host boundary for a tool result. */
	fileMetadata?: AgentToolResultFileMetadata;
	/** New or changed previewable files observed across the assistant run. */
	workspaceArtifacts?: WorkspaceArtifactManifest;
	/** Plan fields */
	plan?: TaskPlan;
	/** Error fields */
	message?: string;
	/**
	 * Provider-agnostic classification of the error. Present on
	 * `{ type: "error" }` messages when the provider's adapter can recognise a
	 * known upstream signal (auth failure, quota exhausted, missing
	 * executable, abort). Callers should treat an absent `kind` as
	 * `upstream_error` for backwards compatibility with providers that have
	 * not been updated to emit the field.
	 */
	kind?: AgentErrorKind;
	/** Question fields (for interactive skills) */
	question?: AgentQuestion;
	/**
	 * Capability authorization request — emitted when the agent calls the
	 * `requestAuthorization` MCP tool because the user is missing a connector or
	 * native permission needed to fulfil the request. The agent loop PARKS until
	 * the client resolves it (the user connects what they want and clicks
	 * Continue), so the model cannot fabricate an empty result in the meantime.
	 * `primaryCapabilityIds` and `secondaryCapabilityIds` preserve the LLM's
	 * priority judgement from the maintained connector capability guide plus the
	 * user's intent. `capabilityIds` is the merged compatibility list (connector
	 * platform ids like "slack" or permission ids like
	 * "macos:screen-recording"); the client resolves them to concrete
	 * capabilities and renders the unified guidance card.
	 */
	capabilityRequest?: {
		id: string;
		capabilityIds: string[];
		primaryCapabilityIds?: string[];
		secondaryCapabilityIds?: string[];
		reason?: string | null;
		status?: "pending" | "resolved" | "cancelled";
	};
	/** Insight change fields (for optimistic updates) */
	action?: "create" | "update" | "delete";
	insightId?: string;
	insight?: Record<string, unknown>;
	/** Scoped assistant behavior rules updated by the agent. */
	rulesUpdated?: {
		scopeType: "global" | "task";
		scopeId: string;
		rules: Array<{
			id: string;
			ruleType: string;
			ruleKey: string;
			value: Record<string, unknown>;
			displayLabel: string;
			enabled: boolean;
			source: string;
		}>;
	};
	/**
	 * Memory update fields — fired when the agent writes a user-fact markdown
	 * file under the memory directory (people / projects / notes / strategy).
	 * The UI surfaces this as a notification card so the user can see which
	 * pieces of their information the agent just updated.
	 */
	memoryUpdate?: {
		category: string;
		fileName: string;
		displayLabel: string;
		action: "create" | "update";
		description?: string;
		filePath?: string;
	};
	/**
	 * Task schedule notice — fired during the first task turn when the async
	 * bootstrap could not apply the recurring schedule the user asked for
	 * (e.g. an interval below the supported minimum). The UI surfaces this as a
	 * warning toast so the user perceives that no automatic schedule was set.
	 */
	scheduleNotice?: "below_minimum";
	/** Prompt cache statistics — populated on 'result' messages when cache data is available */
	cacheStats?: PromptCacheStats;
	/** Raw token usage from SDK — populated on 'result' messages */
	usage?: {
		inputTokens: number;
		outputTokens: number;
	};
	/** Permission request fields */
	permissionRequest?: {
		/** Opaque OpenContext request id used when submitting the decision. */
		requestId: string;
		toolName: string;
		toolInput: Record<string, unknown>;
		toolUseID: string;
		decisionReason?: string;
		blockedPath?: string;
	};
	/** Password input fields (for sudo commands) */
	passwordInput?: {
		toolUseID: string;
		originalCommand: string;
	};
	/** Workspace artifact attribution baseline timestamp. */
	artifactBaselineAt?: string;
	/**
	 * Retry fields — emitted on 'retry' messages when the provider restarts a
	 * query after a transient error (issue #2488). `attempt` is the 1-based
	 * number of the upcoming attempt and `maxAttempts` the total it may run.
	 * The UI uses these to surface a clear, localized retry notice and to drop
	 * the reasoning accumulated in the aborted round (which the restart
	 * re-generates) so duplicate thinking does not stack up.
	 */
	attempt?: number;
	maxAttempts?: number;
	/**
	 * Optional structured phase for transport-level retries. Keeping this
	 * separate from the provider's human-readable message lets clients render
	 * stable, localized status without parsing CLI output a second time.
	 */
	retryKind?: "reconnecting" | "fallback";
}

/**
 * Agent question for interactive skills (AskUserQuestion)
 */
export interface AgentQuestion {
	id: string;
	questions: Question[];
	status?: "pending" | "answered" | "cancelled";
}

export interface Question {
	question: string;
	header: string;
	options: QuestionOption[];
	multiSelect?: boolean;
}

export interface QuestionOption {
	label: string;
	description?: string;
}

export interface ConversationMessage {
	role: "user" | "assistant" | "system";
	content: string;
	/** Image file paths attached to this message (saved to workspace) */
	imagePaths?: string[];
}

/**
 * Delivery semantics for input that arrives while a run is active.
 *
 * - "steer": the user wants to redirect the agent NOW. The host interrupts the
 *   current assistant turn so the input is seen immediately (the only way to
 *   get the model's attention before the turn boundary with the current SDK).
 * - "inform": a notification the agent should pick up at the next natural
 *   boundary (next tool result, or the turn boundary) WITHOUT interrupting —
 *   e.g. "the user just authorized Gmail". Never aborts in-flight work and
 *   never produces interrupt markers in the transcript.
 */
export type AgentSupplementalInputIntent = "steer" | "inform";

export interface AgentSupplementalInput {
	id: string;
	content: string;
	createdAt: string;
	/** Identifies the active run that is allowed to consume this input. */
	runEpoch?: number;
	/** Defaults to "steer" when absent (legacy producers). */
	intent?: AgentSupplementalInputIntent;
}

export interface AgentSupplementalInputSource extends AsyncIterable<AgentSupplementalInput> {
	/**
	 * Called by provider implementations so the host can interrupt the current
	 * assistant turn when a user sends new input into the active run. Only
	 * "steer" inputs trigger this handler; "inform" inputs wait for a boundary.
	 */
	setInterruptHandler?: (handler: (() => Promise<void> | void) | null) => void;
	/** Returns true when user input is queued but not yet yielded to the SDK. */
	hasPending?: () => boolean;
	/**
	 * Atomically removes and returns the leading queued "inform" inputs so an
	 * adapter can surface them at a tool boundary (appended to the tool result)
	 * instead of waiting for the turn boundary. It stops at the first steer to
	 * preserve global FIFO order. Returned inputs are considered consumed and
	 * will not be yielded by the async iterator.
	 */
	takePendingInform?: () => AgentSupplementalInput[];
	/**
	 * Makes queued `inform` inputs available to the async iterator at a natural
	 * turn boundary. Returns the number of inputs newly released. Providers that
	 * consume informs through `takePendingInform()` do not release them.
	 */
	releasePendingInform?: () => number;
	/** Closes the input stream once the active run no longer accepts input. */
	close?: () => void;
}

/**
 * Trusted host-only state used to reconnect an unfinished runtime to the
 * provider session that was persisted before process shutdown.
 *
 * This is deliberately carried outside public request payloads. Hosts may
 * populate it only after authenticating the owner and loading the durable
 * Runtime Session record.
 */
export interface AgentRuntimeRecovery {
	/** Durable OpenContext Runtime Session identity. */
	runtimeSessionId: string;
	/** Exact provider session that must be resumed (never forked). */
	providerSessionId: string;
	/** Persisted provider working directory. */
	workingDirectory: string;
	/** Persisted runtime fencing epoch. */
	runEpoch: number;
	/** Opaque durable recovery claim issued by the trusted persistence layer. */
	recoveryLeaseToken?: string;
	/**
	 * Durable delivery settlement used to rebuild process-local dispatcher
	 * progress before the outbox is replayed. An explicit empty list means the
	 * coordinator verified that every canonical instruction remains retryable.
	 */
	instructionSettlements: readonly AgentRuntimeInstructionSettlement[];
	/**
	 * Called only after Claude confirms that the expected provider session was
	 * resumed and any settlement-aware outbox replay has finished. The host may
	 * repair an interrupted evaluation and ask the attached GoalController for
	 * one canonical continuation through `continueGoal`.
	 */
	onProviderSessionInitialized?: (context: {
		runtimeSessionId: string;
		providerSessionId: string;
		runEpoch: number;
		continueGoal: () => Promise<AgentRuntimeRecoveryContinuationResult>;
		/**
		 * Evaluates durable evidence after provider loss without producing another
		 * instruction for the failed provider. Implementations either complete or
		 * pause the Goal at this boundary.
		 */
		finalizeGoalWithoutContinuation?: () => Promise<AgentRuntimeRecoveryGoalFinalizationResult>;
	}) => void | Promise<void>;
}

export interface AgentRuntimeInstructionSettlement {
	instructionId: string;
	disposition: "accepted" | "superseded";
	recordedAt: string;
	providerEventId?: string;
	reason?: string;
}

export type AgentRuntimeRecoveryContinuationResult =
	| {
			decision: "allow";
			outcome: "no_active_goal" | "stale" | "completed" | "paused" | "blocked" | "budget_limited" | "expired";
	  }
	| {
			decision: "block";
			outcome: "continue";
	  };

export type AgentRuntimeRecoveryGoalFinalizationResult = {
	decision: "allow";
	outcome: "no_active_goal" | "stale" | "completed" | "paused";
	goalId?: string;
	goalRevision?: number;
};

/**
 * Image attachment for vision capabilities.
 * Local uploads should prefer `data` (base64) so the payload stays
 * self-contained; `url` remains available for runtimes that can fetch a
 * reachable image source.
 */
export interface ImageAttachment {
	/** Base64 encoded image data */
	data?: string;
	/** Cloud-accessible URL (e.g. TUS blobUrl) */
	url?: string;
	mimeType: string; // e.g. 'image/png', 'image/jpeg'
}

/**
 * PDF attachment for native PDF API support
 * Used with Anthropic Claude and Google Gemini models that support PDF document blocks
 * Either data (base64) or url (cloud-accessible) must be provided.
 */
export interface PDFAttachment {
	/** Base64 encoded PDF data */
	data?: string;
	/** Cloud-accessible URL (e.g. TUS blobUrl) */
	url?: string;
	mimeType: string; // 'application/pdf'
	pageCount?: number; // Number of pages in the PDF
}

/**
 * File attachment for workspace operations
 * Used to save files to the agent's working directory
 */
export interface FileAttachment {
	name: string; // Original filename
	data: string; // Base64 encoded file data
	mimeType: string; // e.g. 'image/png', 'application/pdf', 'text/plain'
	/**
	 * Category of the file attachment.
	 * - "input-image": User-uploaded image that should be saved to __inputs__/ directory
	 * - undefined: Default behavior, saved to workspace root (backward compatible)
	 */
	category?: "input-image";
}

// ============================================================================
// Agent Hooks (provider-agnostic surface)
// ============================================================================

/**
 * Subset of SDK hook events ClaudeAgent currently wires; the union is open so
 * future SDK events can be referenced without waiting for a code update.
 */
export type AgentHookEvent =
	| "PreToolUse"
	| "PostToolUse"
	| "PostToolUseFailure"
	| "UserPromptSubmit"
	| "Stop"
	| "SubagentStop"
	| "PreCompact"
	| "Notification"
	| (string & {}); // forward-compat: SDK may add new events

/**
 * Provider-agnostic hook callback. ClaudeAgent passes the SDK's
 * `(input, toolUseID, { signal })` triple; the last two are optional so
 * providers that only carry the event payload still fit the surface. The
 * guard inside `createRunDirToolGuard` only reads `input`, so a thin
 * `(input) => ...` lambda works just as well.
 *
 * Note: the surface is single-arg-shaped, but TS's "fewer params assignable
 * to more params" rule lets a single-arg function fill a 3-arg SDK slot at
 * runtime without ceremony. Provider implementations should narrow `input`
 * to their SDK's HookInput union before reading fields.
 */
export type AgentHookCallback = (
	input: unknown,
	toolUseID?: string,
	options?: { signal: AbortSignal },
) => Promise<unknown> | unknown;

/** Match one or more callbacks to a given hook event. */
export interface AgentHookMatcher {
	/** Optional selector (tool name, regex on `tool_name`, etc.). */
	matcher?: string;
	hooks: ReadonlyArray<AgentHookCallback>;
	/**
	 * Per-matcher timeout forwarded to the underlying provider. Units match
	 * the Claude SDK's `HookCallbackMatcher.timeout`, which is **seconds**
	 * (e.g. `5` = 5s). ClaudeAgent does not convert - set the value the
	 * SDK expects.
	 */
	timeout?: number;
}

/**
 * Map of hook event → list of matchers. Empty partial maps disable all hooks;
 * absent keys inherit provider defaults (ClaudeAgent's default hook chain).
 */
export type AgentHooks = Partial<Record<AgentHookEvent, AgentHookMatcher[]>>;

// ============================================================================
// Agent Run Errors (provider-agnostic classification)
// ============================================================================

/**
 * Provider-agnostic classification of why an `IAgent.run()` failed. Surfaced
 * via `AgentMessage.kind` on `{ type: "error" }` messages, so callers don't
 * have to peek at provider-specific stream messages (e.g. ClaudeAgent's
 * `__CLAUDE_CODE_NOT_FOUND__` sentinel or `401 Unauthorized` text).
 *
 * Open union: providers may add provider-specific kinds, and callers that
 * don't recognise a kind should treat it as `upstream_error` rather than
 * throw.
 */
export type AgentErrorKind =
	| { kind: "executable_not_found"; message: string }
	| { kind: "auth_failure"; status?: number; message: string }
	| { kind: "quota_exhausted"; message: string }
	| { kind: "aborted"; message?: string }
	| { kind: "upstream_error"; message: string }
	| { kind: "unknown"; message: string };

// ============================================================================
// Plan Types
// ============================================================================

export interface TaskPlan {
	id: string;
	goal: string;
	steps: PlanStep[];
	notes?: string;
	createdAt: Date;
}

export interface PlanStep {
	id: string;
	description: string;
	status: "pending" | "in_progress" | "completed" | "failed";
}

// ============================================================================
// Agent Configuration
// ============================================================================

export type BuiltinAgentProvider =
	| "claude"
	| "codex"
	| "deepagents"
	| "hermes"
	| "openclaw"
	| "opencode"
	| "standalone"
	| "custom";
export type AgentProvider = BuiltinAgentProvider | (string & {});

export interface AgentConfig {
	/** Agent provider to use */
	provider: AgentProvider;
	/** API key for the provider */
	apiKey?: string;
	/** Custom API base URL (for third-party API endpoints) */
	baseUrl?: string;
	/** Model to use (provider-specific) */
	model?: string;
	/** Thinking level for extended thinking (Claude 4.6+) */
	thinkingLevel?: "disabled" | "low" | "adaptive";
	/** Working directory for file operations */
	workDir?: string;
	/** Custom configuration for the provider */
	providerConfig?: Record<string, unknown>;
}

/**
 * Skills configuration for loading skills from different directories
 */
export interface SkillsConfig {
	/** Whether skills are globally enabled */
	enabled: boolean;
	/** Whether to load skills from user directory (~/.opencontext/skills) */
	userDirEnabled: boolean;
	/** Whether to load skills from app directory (workspace/skills) */
	appDirEnabled: boolean;
	/** Custom skills directory path (legacy support) */
	skillsPath?: string;
}

/**
 * MCP configuration for loading MCP servers from different config files
 */
export interface McpConfig {
	/** Whether MCP is globally enabled */
	enabled: boolean;
	/** Whether to load MCP servers from user directory (claude config) */
	userDirEnabled: boolean;
	/** Whether to load MCP servers from app directory (opencontext config) */
	appDirEnabled: boolean;
	/** Custom MCP config file path (legacy support) */
	mcpConfigPath?: string;
}

export interface ActiveAgentTaskExecution {
	taskId: string;
	executionId: string;
	userMessageId?: string;
	assistantMessageId?: string;
}

export interface AgentTaskExecutionCompletion {
	status: "success" | "error" | "timeout" | "interrupted" | "blocked";
	error?: string | null;
}

export interface AgentTaskExecutionHandoff {
	taskId: string;
	taskExecutionId: string;
	reusedActiveExecution: boolean;
	completion: Promise<AgentTaskExecutionCompletion>;
}

/**
 * Host-owned control plane for the terminal executeTaskNow tool.
 *
 * The agent provider only transports these callbacks. The host decides
 * whether the user's raw request is an explicit saved-task control command,
 * which execution can be transferred, and where worker events are streamed.
 */
export interface AgentTaskExecutionControl {
	canExecuteTaskNow: () => boolean;
	getActiveExecution: () => ActiveAgentTaskExecution | null;
	onHandoff?: (handoff: AgentTaskExecutionHandoff) => void;
	onEvent?: (message: AgentMessage) => void | Promise<void>;
}

export interface AgentOptions {
	/** Session ID for continuing conversations */
	sessionId?: string;
	/** Trace id for cross-hop first-token (TTFT) latency instrumentation. */
	traceId?: string;
	/**
	 * Agent-run id: correlates every LLM request made during ONE agent execution
	 * (the claude subprocess agent loop). Unlike traceId it is ALWAYS present
	 * (independent of trace sampling), so model-stats can aggregate by agent
	 * execution in production. Propagated to the subprocess as an HTTP header.
	 */
	runId?: string;
	/** Stable first-party billing classification for this agent execution. */
	usageTaskCode?: string;
	/**
	 * User session for authentication and context (used for business tools).
	 *
	 * Structurally compatible with a next-auth `Session` without depending on
	 * it, so hosts can read `session.user.id` directly. Hosts that need their
	 * own stricter `Session` type should cast at the boundary.
	 */
	session?: AgentAuthSession;
	/** Cloud auth token for embeddings API (needed in native mode) */
	authToken?: string;
	/** Conversation history */
	conversation?: ConversationMessage[];
	/** Additional user inputs delivered to an already-active run. */
	supplementalInput?: AgentSupplementalInputSource;
	/** Trusted host-only restart recovery state; never accepted from HTTP. */
	runtimeRecovery?: AgentRuntimeRecovery;
	/** Working directory */
	cwd?: string;
	/** Use cwd exactly instead of wrapping it in an OpenContext session folder */
	useProvidedWorkDir?: boolean;
	/** Allowed tools */
	allowedTools?: string[];
	/** Tools that must be unavailable even if the provider preset exposes them */
	disallowedTools?: string[];
	/** Tools to exclude from the allowed list */
	excludeTools?: string[];
	/**
	 * When true, task-config mutation tools (createTask / updateTaskSettings /
	 * bootstrapTaskConfiguration / findReusableExecutors / linkExecutorToTask /
	 * createScheduledExecutorForTask) are NOT registered for the agent. Used on
	 * the async first turn while background bootstrap is the sole writer of the
	 * task config, so the agent cannot race it and create a duplicate scheduled
	 * executor.
	 */
	suppressTaskConfigMutations?: boolean;
	/** Provider-level subagents that can be invoked by the main agent. */
	subagents?: Record<string, AgentSubagentDefinition>;
	/** Task ID for tracking */
	taskId?: string;
	/** Connector-backed capabilities visible to this agent run. */
	connectorScope?: ConnectorVisibilityScope;
	/** Host-owned saved-task execution guard and controller-to-worker handoff. */
	taskExecutionControl?: AgentTaskExecutionControl;
	/**
	 * When true, ClaudeAgent skips the Anthropic prompt-cache lookup before
	 * calling the model. Use for hermetic one-shot tasks (e.g. contract review)
	 * whose input must not bleed into or be retrieved from the shared cache.
	 */
	skipPromptCacheLookup?: boolean;
	/**
	 * When true, provider credentials resolved for this run are not mirrored
	 * into `process.env`. Use for isolated runs that must not mutate shared
	 * process state.
	 */
	skipProcessEnvMirror?: boolean;
	/** Abort controller for cancellation */
	abortController?: AbortController;
	/**
	 * Wall-clock budget in ms. ClaudeAgent creates an internal abort signal and
	 * aborts the SDK query when the budget elapses, then yields a typed
	 * `kind: "aborted"` error message before exiting. Callers that pass both
	 * `timeoutMs` and an external `abortController` abort on whichever fires
	 * first.
	 */
	timeoutMs?: number;
	/** Permission mode */
	permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
	/** Sandbox configuration for isolated execution */
	sandbox?: SandboxConfig;
	/** Image attachments for vision capabilities */
	images?: ImageAttachment[];
	/** PDF attachments for native PDF API support */
	pdfs?: PDFAttachment[];
	/** File attachments to be saved to workspace */
	fileAttachments?: FileAttachment[];
	/** Skills configuration */
	skillsConfig?: SkillsConfig;
	/** MCP configuration */
	mcpConfig?: McpConfig;
	/** Active character (mate) ID for character-scoped chat */
	characterId?: string;
	/** Focused insight IDs (from web agent) */
	focusedInsightIds?: string[];
	/** Focused insights data (from web agent) */
	focusedInsights?: Array<{
		id: string;
		title: string;
		description?: string | null;
		details?: unknown[] | null;
		timeline?: Array<{ title?: string; description?: string }> | null;
		groups?: string[] | null;
		platform?: string | null;
	}>;
	/** Callback for insight changes (used for optimistic updates in native agent mode) */
	onInsightChange?: (data: {
		action: "create" | "update" | "delete";
		insightId?: string;
		insight?: Record<string, unknown>;
	}) => void;
	/** Callback invoked after provider-managed user inputs have been materialized. */
	onInputsMaterialized?: () => void | Promise<void>;
	/**
	 * Callback invoked when the MCP-backed `AskUserQuestion` tool needs to ask
	 * the user. Presence of this callback gates registration of the
	 * `ask-user-question` MCP server — non-interactive contexts (cron,
	 * subagent, execute) should not pass it.
	 */
	onAskUserQuestion?: (question: AgentQuestion) => void;
	/** Callback invoked when the MCP Bash tool detects a sudo password prompt. */
	onPasswordRequired?: (request: { id: string; command: string }) => void;
	/** Callback for scoped assistant rule updates from upsertAssistantRules. */
	onRulesUpdated?: (data: {
		scopeType: "global" | "task";
		scopeId: string;
		rules: Array<{
			id: string;
			ruleType: string;
			ruleKey: string;
			value: Record<string, unknown>;
			displayLabel: string;
			enabled: boolean;
			source: string;
		}>;
	}) => void;
	/**
	 * Called when the agent SDK has fully resolved a tool call's input — i.e.
	 * after streaming `input_json_delta` finishes and the assistant message
	 * is materialized. Hosts use this to inspect tool inputs that aren't
	 * available at the initial `tool_use` emission (which fires at
	 * `content_block_start` with empty/partial input under Anthropic's
	 * streaming protocol). Fires at most once per `toolUseId`.
	 */
	onToolUseSeen?: (data: {
		toolUseId: string;
		toolName: string;
		input: unknown;
	}) => void;
	/**
	 * Called after a first-party memory tool successfully persists a durable
	 * user fact. The host surfaces this as a chat notification card.
	 */
	onMemoryUpdate?: (data: {
		category: string;
		fileName: string;
		displayLabel: string;
		action: "create" | "update";
		description?: string;
		filePath?: string;
	}) => void;
	/** Callback for handling permission requests from SDK */
	onPermissionRequest?: (request: {
		toolName: string;
		toolInput: Record<string, unknown>;
		toolUseID: string;
		decisionReason?: string;
		blockedPath?: string;
		title?: string;
		displayName?: string;
		description?: string;
		agentID?: string;
	}) => Promise<{
		behavior: "allow" | "deny";
		updatedInput?: Record<string, unknown>;
		message?: string;
	}>;
	/** Enable streaming output (default: true) */
	stream?: boolean;
	/** User-defined AI Soul prompt (custom instructions) */
	aiSoulPrompt?: string | null;
	/** User language preference for agent responses */
	language?: string | null;
	/** User timezone for date/time operations */
	timezone?: string | null;

	// --------------------------------------------------------------------------
	// Provider-override surface (added for non-chat callers like
	// AgentContractReviewer). Each option here replaces the corresponding
	// provider default wholesale — there is no merging with chat-path defaults.
	// --------------------------------------------------------------------------

	/** Maximum agent turns before run stops. ClaudeAgent default 1000. */
	maxTurns?: number;
	/**
	 * Override the provider's default system prompt. The Claude provider
	 * interprets a plain string; other providers may ignore it. Use for
	 * hermetic one-shot tasks that need a bespoke instruction block without
	 * inheriting chat-path defaults (e.g. contract review).
	 */
	systemPrompt?: string;
	/**
	 * Override the provider's preset tool list. Either an allowlist `string[]`
	 * or the Claude SDK preset object `{ type: "preset", preset: "claude_code" }`.
	 */
	tools?: { type: "preset"; preset: "claude_code" } | string[];
	/**
	 * Replace the provider's default hook chain entirely (no merging with
	 * provider defaults). Pass an empty partial map to disable all hooks.
	 * Provider implementations narrow each callback to their SDK type internally.
	 */
	hooks?: AgentHooks;
	/** Per-run model override; takes precedence over `AgentConfig.model`. */
	model?: string;

	// --------------------------------------------------------------------------
	// Claude-only support bits — non-default paths chat never takes.
	// --------------------------------------------------------------------------

	/**
	 * Controls `sessionCwd` resolution inside ClaudeAgent.
	 * - `"session-wrapped"` (default): legacy behaviour, wraps `cwd` into
	 *   `sessions/<id>` so concurrent chats cannot clobber each other.
	 * - `"exact"`: use `cwd` verbatim after defensive expansion. Use when the
	 *   caller has pre-resolved a hermetic per-run workspace (e.g. contract
	 *   review's `mkdtemp`).
	 */
	cwdMode?: "exact" | "session-wrapped";
	/**
	 * Skip ClaudeAgent's `syncSkillsToClaude(sessionCwd)` global sync and copy
	 * skills from this directory into `sessionCwd/.claude/skills/` instead. Use
	 * for hermetic one-shot tasks that ship their own skill bundle.
	 */
	skillsSourceDir?: string;
	/**
	 * Controls the Claude SDK's session persistence (`query({ persistSession })`).
	 * When `false`, the SDK does NOT write the run transcript (including all
	 * Read tool output the agent sees) to `~/.claude/projects/<hash>/`. Set this
	 * to `false` for hermetic one-shot tasks whose inputs are sensitive (e.g.
	 * contract review, where the entire contract is read into context). When
	 * `undefined`, ClaudeAgent does not override the SDK default (currently
	 * `true`), preserving chat-path resume behaviour.
	 */
	persistSession?: boolean;
	/**
	 * @internal Claude-SDK child process env override. Other providers ignore.
	 * Used to bypass ClaudeAgent.buildEnvConfigForSession's `applyEnvToProcess`
	 * side effect for hermetic backend tasks (e.g. contract review).
	 */
	_envOverride?: Record<string, string>;
}

export interface PlanOptions extends AgentOptions {
	/** Planning-specific options */
}

export interface ExecuteOptions extends AgentOptions {
	/** Plan ID to execute */
	planId: string;
	/** Original prompt that created the plan */
	originalPrompt: string;
	/** Sandbox configuration */
	sandbox?: SandboxConfig;
	/** Plan object (optional - if not provided, will look up by planId) */
	plan?: TaskPlan;
}

// ============================================================================
// Agent Interface
// ============================================================================

/**
 * A one-shot agent run whose provider process has already been initialized.
 * The final prompt and request-scoped callbacks are bound when consumed.
 */
export interface PreparedAgentRun {
	consume(prompt: string, options?: AgentOptions): AsyncGenerator<AgentMessage>;
	close(reason?: string): Promise<void>;
}

/**
 * Base interface for all agent implementations.
 * Each provider (Claude, DeepAgents, etc.) must implement this interface.
 */
export interface IAgent {
	/** Provider name */
	readonly provider: AgentProvider;

	/**
	 * Run the agent with a prompt (direct execution mode)
	 */
	run(prompt: string, options?: AgentOptions): AsyncGenerator<AgentMessage>;

	/**
	 * Pre-initialize a one-shot direct run when supported by the provider.
	 * Callers must close unused handles.
	 */
	prepareRun?(options?: AgentOptions): Promise<PreparedAgentRun>;

	/**
	 * Run planning phase only (returns a plan for approval)
	 */
	plan(prompt: string, options?: PlanOptions): AsyncGenerator<AgentMessage>;

	/**
	 * Execute an approved plan
	 */
	execute(options: ExecuteOptions): AsyncGenerator<AgentMessage>;

	/**
	 * Stop the current execution
	 */
	stop(sessionId: string): Promise<void>;

	/**
	 * Get a stored plan by ID
	 */
	getPlan(planId: string): TaskPlan | undefined;

	/**
	 * Delete a stored plan
	 */
	deletePlan(planId: string): void;
}

// ============================================================================
// Session Management
// ============================================================================

export interface AgentSession {
	id: string;
	createdAt: Date;
	phase: "planning" | "executing" | "idle";
	isAborted: boolean;
	abortController: AbortController;
	config?: AgentConfig;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const DEFAULT_ALLOWED_TOOLS = [
	"Read",
	"Edit",
	"Write",
	"Glob",
	"Grep",
	"Bash",
	"WebSearch",
	"WebFetch",
	"Skill",
	"Task",
	"LSP",
	"TodoWrite",
];

// ============================================================================
// Factory Types
// ============================================================================

export type AgentFactory = (config: AgentConfig) => IAgent;

export type AgentRegistryInterface = {
	register(provider: AgentProvider, factory: AgentFactory): void;
	get(provider: AgentProvider): AgentFactory | undefined;
	create(config: AgentConfig): IAgent;
};

/**
 * API Request type for agent endpoints
 */
export interface AgentRequest {
	prompt: string;
	sessionId?: string;
	conversation?: Array<{
		role: "user" | "assistant" | "system";
		content: string;
	}>;
	/** Two-phase execution control */
	phase?: "plan" | "execute";
	planId?: string; // Reference to approved plan
	/** Workspace settings */
	workDir?: string; // Working directory for session outputs
	taskId?: string; // Task ID for session folder
	/** Provider selection (optional, defaults to env config) */
	provider?: AgentProvider;
	/** Provider-specific configuration */
	providerConfig?: Record<string, unknown>;
	/** Custom model configuration */
	modelConfig?: ModelConfig;
	/** Sandbox configuration for isolated execution */
	sandboxConfig?: SandboxConfig;
	/** Cloud auth token for embeddings API (needed in native mode) */
	authToken?: string;
}
