/**
 * `evidence-cluster` re-export surface.
 *
 * Hosts that consume `@melandlabs/ai/memory` may also need the
 * memory-consolidation evidence-cluster primitives (the same `MemoryEvidenceRecord`
 * shape that the unified search pipeline emits). Re-export just those
 * explicitly — `export *` would also pull in the consolidation package's
 * internal `MemoryDeprecateRecordsInput` mirror, which collides with the
 * canonical contract defined here in `./contracts`.
 */
export {
	type BuildMemoryEvidenceClustersInput,
	type AnalyzeMemoryEvidenceClustersInput,
	DefaultMemoryEvidenceRecordScorer,
	type MemoryEvidenceCluster,
	type MemoryEvidenceClusterAnalysis,
	type MemoryEvidenceClusterWeights,
	type MemoryEvidenceRecord,
	type MemoryEvidenceRecordScorer,
	type MemoryEvidenceRecordSignal,
	type MemoryEvidenceTier,
	analyzeMemoryEvidenceClusters,
	buildMemoryEvidenceClusters,
} from "@melandlabs/memory-consolidation";
