/**
 * A `Decision` is a first-class artifact representing an explicit choice the
 * user (or their team) committed to. Decisions cross-cut raw conversation
 * (episodes), memory records, and graph nodes. They are intentionally
 * minimal here — domain packages extend with workflow state, approval chain,
 * and PROV-O style provenance.
 */
export interface Decision {
	decisionId: string;
	userId: string;
	title: string;
	rationale?: string;
	decidedAt: number;
	decidedBy?: string;
	outcome?: string;
	relatedEpisodeIds?: string[];
	relatedRecordIds?: string[];
	metadata?: Record<string, unknown>;
}
