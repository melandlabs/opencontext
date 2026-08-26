/**
 * @melandlabs/opencontext — single-package facade.
 *
 * Re-exports every public surface of the OpenContext runtime so a host
 * application needs only one dependency:
 *
 *     pnpm add @melandlabs/opencontext
 *     import { createMemoryStore } from "@melandlabs/opencontext";
 *
 * Underlying workspace packages (@melandlabs/contracts,
 * @melandlabs/memory-store, @melandlabs/rag, @melandlabs/loop,
 * @melandlabs/ai) are bundled at build time and do not appear as runtime
 * dependencies in the published manifest.
 */

// ─── 1. Boundary contracts (types, schemas, errors, integration ids) ──────
// `UserType` lives here canonically — the broader channel-aware union
// from `@melandlabs/ai` is renamed to `AIUserType` in ai-reexport.ts to
// avoid a duplicate-type conflict on this facade.
export * from "@melandlabs/contracts";

// ─── 1b. App data directory paths (~/.opencontext or OPENCONTEXT_HOME) ────
export {
	OPENCONTEXT_HOME_ENV,
	getOpenContextDir,
	getOpenContextPath,
	ensureOpenContextDir,
} from "@melandlabs/env-config";

// ─── 2. Memory store: the four-verb memory API + unified search ───────────
export {
	createMemoryStore,
	createRawMessageStore,
	getRawMessageManager,
	isRawMessageStorageAvailable,
	getRawMessageStorageBackend,
	closeRawMessageStore,
	registerPostgresFactory,
	clearPostgresFactory,
	hasPostgresFactory,
	resolvePostgresFactory,
	clampUnifiedMemorySearchLimit,
	clampUnifiedMemorySearchThreshold,
	isRawMemorySemanticResult,
	mergeUnifiedMemorySearchResults,
	normalizeUnifiedMemoryReasoningStrategy,
	normalizeUnifiedMemorySearchSources,
	toKnowledgeResult,
	toMemoryResult,
	listNameToChannel,
	materializeSignals,
	mergeUnifiedMemorySearchResultsRrf,
	distillRawMessage,
	deriveFacts,
	createUserVoiceRewriter,
	createIdentityRewriter,
	createIterativeRecallPlanner,
	createIdentityIterativePlanner,
} from "@melandlabs/memory-store";

export type {
	MemoryStore,
	MemoryStoreConfig,
	RawMessageStorageBackend,
	RawMessageStorageManagerWithSearch,
	PostgresFactoryFn,
	PostgresRawMessageManagerLike,
	UnifiedMemorySearchInput,
	UnifiedMemorySearchOutput,
	UnifiedMemorySearchResult,
	UnifiedMemorySearchSource,
	UnifiedMemorySearchWarning,
	UnifiedMemoryReasoningStrategy,
	UnifiedMemoryReasoningInfo,
	HitChannel,
	HitSignals,
	MemoryStoreDb,
	MemoryStoreEnv,
	VectorBackend,
	EmbedQueryFn,
	UnifiedSearchKnowledgeResult,
	UnifiedSearchInsightsResult,
	UnifiedSearchReasoningDeps,
	RawMessage,
	QueryRewriter,
	QueryRewriterInput,
	QueryRewriterOptions,
	IterativeRecallCandidate,
	IterativeRecallExecutor,
	IterativeRecallPlanner,
	IterativeRecallPlannerOptions,
	IterativeRecallResult,
	IterativeRecallSearchRequest,
	IterativeRecallSearchResult,
	IterativeRecallStats,
	DistillInput,
	DistillOutput,
	DistillWarning,
	DeriveInput,
	DeriveOutput,
	DeriveWarning,
	EntityEdge,
	EntityKind,
	DerivedFact,
	DerivedKind,
} from "@melandlabs/memory-store";

// Unified search facade (its own subpath entry).
export { createUnifiedSearch } from "@melandlabs/memory-store/unified-search";
export type { UnifiedSearch } from "@melandlabs/memory-store/unified-search";

// Reasoning-backed memory retrieval providers.
export {
	createQueryRewriter,
	createIterativePlanner,
	createMemoryReasoningProviders,
	createDisabledMemoryReasoningProviders,
} from "./memory-reasoning";
export type {
	ReasoningModelOptions,
	MemoryReasoningProviders,
} from "./memory-reasoning";

// ─── 3. Retrieval: chunking, embeddings, vector stores, parsers ──────────
export {
	chunkText,
	countTokens,
	getOptimalChunkSize,
	estimateChunkCount,
	generateEmbedding,
	generateEmbeddings,
	cosineSimilarity,
	getEmbeddingDimensions,
	getEmbeddingModel,
	getModelPricing,
	getVectorStore,
	addDocumentToVectorStore,
	searchVectorStore,
	searchHybridVectorStore,
	deleteDocumentFromVectorStore,
	getVectorStoreStats,
	configureVectorService,
	UniversalEmbeddings,
	TextLoader,
	AppleDocumentLoader,
	parseFile,
	parseFileToDocument,
	getPdfPageCount,
	shouldUseNativePdf,
	isSupportedContentType,
	configureParsers,
	SQLiteVecStore,
	getSQLiteVecStore,
	resetSQLiteVecStore,
	ChromaVectorStore,
	HybridSearchAdapter,
	fuseHybridResults,
	LanceDBStore,
	MilvusStore,
} from "@melandlabs/rag";

export type {
	ChunkOptions,
	TextChunk,
	EmbeddingResult,
	IVectorStore,
	SearchResult,
	FileContent,
	ParsersConfig,
	VectorSearchResult,
	DocumentChunk,
	ChromaVectorStoreOptions,
	IHybridVectorStore,
	HybridSearchFilter,
	HybridSearchQuery,
	HybridFusionStrategy,
	HybridRetrievalConfig,
	VectorStoreBackend,
	VectorServiceConfig,
	HybridFusionInput,
	HybridSearchAdapterOptions,
	LexicalSearchProvider,
	LanceDBFtsOptions,
	LanceDBStoreOptions,
	MilvusStoreOptions,
} from "@melandlabs/rag";

// ─── 3b. Cloud / local embedding provider abstraction ─────────────────────
// Re-exported from `@melandlabs/ai-rag`, an **optional** peer dep. The
// factory `getConfiguredEmbeddingProvider()` honours the
// `EMBEDDING_PROVIDER` env var (`cloud` default | `local`) and returns
// a `LocalTransformersEmbeddingProvider` (ONNX via @huggingface/transformers,
// default model `Xenova/all-MiniLM-L6-v2`, 384 dims) or a `CloudEmbeddingProvider`
// (OpenRouter-compatible, default model `text-embedding-3-small`, 1536 dims).
//
// Host apps that need local embeddings must install `@melandlabs/ai-rag`
// themselves; if they don't, these bindings resolve to undefined at
// runtime and importing them will throw — same shape as the rest of the
// facade's optional peer deps.
export {
	getConfiguredEmbeddingProvider,
	getConfiguredEmbeddingModelName,
	getEmbeddingProviderType,
	CloudEmbeddingProvider,
} from "@melandlabs/ai-rag/embedding-provider";
export type {
	CloudEmbeddingProviderOptions,
	EmbeddingProvider,
	EmbeddingProviderFactoryOptions,
	EmbeddingProviderType,
} from "@melandlabs/ai-rag/embedding-provider";
// The local class is re-exported from its dedicated subpath (the
// embedding-provider subpath intentionally does not re-export it).
export {
	LocalTransformersEmbeddingProvider,
	type LocalTransformersEmbeddingProviderOptions,
} from "@melandlabs/ai-rag/local-transformers-embedding-provider";

// ─── 4. Loop engine: filesystem paths, CLI paths, preferences ────────────
export * from "@melandlabs/loop";

// ─── 5. Agent runtime: every ai export except the conflicting UserType ────
// `UserType` from `@melandlabs/ai` is renamed to `AIUserType` here.
export * from "./ai-reexport";

// ─── 6. Cron: scheduling primitives ────────────────────────────────────────
export {
	computeNextRun,
	createJobExecutionStreamResponse,
	formatDate,
	isJobDue,
	parseDate,
	validateCronExpression,
} from "@melandlabs/cron";
export type {
	CronJob,
	ExecuteJobOptions,
	JobAgentStreamEvent,
	JobConfig,
	JobExecutionContext,
	JobExecutionResult,
	JobTimezoneSource,
	ScheduleConfig,
	ScheduledJobLike,
	SchedulerConfig,
	SchedulerEvent,
} from "@melandlabs/cron";

// ─── 7. Search: live web search + query classifier ────────────────────────
export { needsRealTimeInfo, search } from "@melandlabs/search";
// SearchResult collides with the identically-named type from @melandlabs/rag;
// expose it under a web-search-specific name on the facade.
export type { SearchResult as WebSearchResult, SearchType } from "@melandlabs/search";

// ─── 8. Audit: structured operation logging ────────────────────────────────
export {
	AUDIT_LOG_PATH,
	clearAuditLogs,
	installAuditInterceptors,
	logCommandExec,
	logCredentialAccess,
	logFileRead,
	readAuditLogs,
} from "@melandlabs/audit";
export type { AuditEntry, CredentialAccessEntry } from "@melandlabs/audit";

// ─── 9. Voice: browser-oriented TTS / STT plugins ─────────────────────────
export { KokoroPlugin } from "@melandlabs/voice-kokoro";
export { WhisperPlugin } from "@melandlabs/voice-whisper";
export type {
	WhisperPluginOptions,
	WhisperTranscriptionInput,
	WhisperTranscriptionResult,
} from "@melandlabs/voice-whisper";

// Tutorial-compatibility aliases for APIs that were renamed after the docs were written.
export { KokoroPlugin as LocalKokoroTTS } from "@melandlabs/voice-kokoro";
export { WhisperPlugin as LocalWhisperSTT } from "@melandlabs/voice-whisper";

// ─── 10. Security: token encryption + SSRF protection ───────────────────────
export {
	SSRFValidationError,
	TokenEncryption,
	decryptToken,
	decryptTokenPair,
	encryptToken,
	encryptTokenPair,
	fetchWithSSRFProtection,
	isTrustedStorageUrl,
	validateUrlForSSRF,
} from "@melandlabs/security";
export type { DerivedKey } from "@melandlabs/security";

// ─── 11. Integrations: platform context factory ─────────────────────────────
export { createMinimalContext } from "@melandlabs/integrations/core";
export type {
	AIHandler,
	AIHandlerOptions,
	AppConfigProvider,
	AttachmentDownloadPayload,
	AuthProvider,
	BaileysAuthStateProvider,
	Bot,
	ClientRegistry,
	CloudSyncProvider,
	ConfigProvider,
	CredentialStore,
	FileIngester,
	InboundMessageHandler,
	IngestExternalOptions,
	IngestResult,
	IngestedAttachment,
	IntegrationAccount,
	IntegrationAccountWithBot,
	IntegrationContext,
	LocalUserType,
	PlatformId,
	SessionStore,
} from "@melandlabs/integrations/core";

// Tutorial-compatibility aliases for integration APIs that were renamed.
export { createMinimalContext as getIntegrationManager } from "@melandlabs/integrations/core";

// ─── 12. CLI entry points (used by the bundled bin scripts in dist/cli/) ──
// Re-export the server starters so the CLI bins can import them through
// the facade's main bundle (one canonical copy of the code).
export { startHttpServer } from "@melandlabs/memory-store/http";
export { startMcpServer } from "@melandlabs/memory-store/mcp";

// ─── 13. OKF v0.2 (Open Knowledge Format) importer / exporter ──────────
// Markdown + YAML-front-matter ⇄ RawMessage codec. The HTTP and MCP
// front-ends re-use the same `RawMessageStore` so a host that already
// runs `opencontext http` / `opencontext mcp` can serve `POST
// /v1/okf/import` and `memory.okfImport` without extra wiring.
export {
	parseOkf,
	parseOkfFrontMatter,
	stringifyOkf,
	validateOkfFrontMatter,
	okfToRawMessage,
	rawMessageToOkf,
	okfTypeToFactType,
	factTypeToOkfType,
	extractMarkdownLinks,
	slugify,
	ingestOkfString,
	readOkfPackage,
	writeOkfPackage,
	OkfError,
	okfIssue,
	parseOkfArgs,
	startOkf,
	startOkfServe,
	printOkfHelp,
	buildGraphFromMessages,
	buildGraphFromDir,
	isOkfType,
	OkfFrontMatterSchema,
	OkfDocumentSchema,
	OkfPackageManifestSchema,
	OKF_TYPES,
} from "@melandlabs/okf";
export type {
	OkfFrontMatter,
	OkfDocument,
	OkfPackageManifest,
	OkfSource,
	OkfVerification,
	OkfGenerated,
	OkfIssue,
	OkfIssueCode,
	ParsedOkfDocument,
	OkfToRawMessageOptions,
	OkfToRawMessageResult,
	RawMessageToOkfOptions,
	RawMessageToOkfResult,
	ReadOkfPackageOptions,
	OkfPackageFile,
	ReadOkfPackageResult,
	WriteOkfPackageOptions,
	WriteOkfPackageResult,
	OkfAction,
	OkfCommonOptions,
	OkfIngestOptions,
	OkfEmitOptions,
	OkfValidateOptions,
	OkfInspectOptions,
	OkfServeOptions,
	OkfServeStartOptions,
	StartedOkfServe,
	OkfHelpOptions,
	OkfOptions,
	OkfRunResult,
	OkfRunOptions,
	OkfIngestSummary,
	OkfEmitSummary,
	OkfValidateSummary,
	OkfInspectSummary,
	OkfInspectOutput,
	WikiGraph,
	WikiNode,
	WikiEdge,
	BuildGraphOptions,
} from "@melandlabs/okf";
