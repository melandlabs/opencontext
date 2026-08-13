/**
 * An `Episode` is the durable, raw-event envelope that a stream of `RawMessage`
 * records belongs to. Episodes are produced by ingest adapters (chat
 * transcripts, meeting summaries, voice memos) and serve as the join key
 * between raw messages and higher-tier derivations (summaries, decisions).
 *
 * The optional `sourceEpisodeId` on `RawMessage` points back here.
 */
export interface Episode {
	episodeId: string;
	userId: string;
	sourceChannel: string;
	startedAt: number;
	endedAt?: number;
	participantIds?: string[];
	summary?: string;
	topicKeys?: string[];
	metadata?: Record<string, unknown>;
}
