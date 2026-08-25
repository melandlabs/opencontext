/**
 * @melandlabs/memory-store public types re-exports.
 */

export type {
	EmbedQueryFn,
	MemoryStoreConfig,
	MemoryStoreDb,
	MemoryStoreEnv,
	MemoryStoreVectorConfig,
	UnifiedSearchDeps,
	UnifiedSearchInsightsResult,
	UnifiedSearchKnowledgeResult,
	VectorBackend,
} from "./config";

export type {
	UnifiedMemorySearchInput,
	UnifiedMemorySearchOutput,
	UnifiedMemorySearchResult,
	UnifiedMemorySearchSource,
	UnifiedMemorySearchWarning,
	HitChannel,
	HitSignals,
} from "./search/utilities";

export type { DeriveInput, DeriveOutput, DeriveWarning } from "./search/derive";
export type { DistillInput, DistillOutput, DistillWarning } from "./search/distill";

export type { DerivedFact, DerivedKind } from "@melandlabs/contracts/derived-fact";
export type { EntityEdge, EntityKind } from "@melandlabs/contracts/entity-edge";

export type { RawMessage } from "./config";
