/**
 * `@melandlabs/workspace/promote` — Memory → Workspace promotion bridge.
 *
 * Takes a cluster of memory facts and materialises them as a single
 * wiki page in the workspace layer. The temporal context graph on the
 * memory side gives every promotion an explicit provenance trail back
 * to its constituent facts.
 *
 * Two-step pipeline:
 *   1. `bodyGenerator` (host-injected LLM) turns the facts into a
 *      page body + front-matter.
 *   2. `indexResource` runs the standard OKF ingestion path
 *      (creates version chain, chunks, FTS5 mirror). We then call
 *      `linkPromotedFacts` to bind the page version to its source
 *      facts so future search hits can expose `promoted_fact_ids`.
 */
import type { OkfFrontMatter } from "@melandlabs/contracts";
import type { EdgeProvenance, OkfFolderResource } from "./types";

export interface PromoteFactsInput {
	workspace_id: string;
	user_id: string;
	/** Memory fact ids to promote (source of truth). */
	fact_ids: string[];
	/** Title for the generated page; if omitted, the generator decides. */
	title?: string;
	/**
	 * Canonical key for the new page. Derived from `title` when omitted
	 * (slugified + .md suffix).
	 */
	canonical_key?: string;
	/**
	 * Host-injected LLM that materialises the page body from the
	 * facts. Required when you want a non-trivial body; omit to use
	 * a trivial concatenation (handy for tests).
	 */
	bodyGenerator?: (input: {
		facts: Array<PromotedFact>;
		title: string;
	}) => Promise<{ body: string; front_matter?: OkfFrontMatter }>;
	/** Tag for the new resource (default 'promoted-page'). */
	resource_type?: string;
	/** Identifies this promotion in edge provenance (`run_id`). */
	runId: string;
}

export interface PromotedFact {
	id: string;
	content: string;
	valid_from?: number;
	valid_until?: number | null;
	/** Optional metadata the caller passed through. */
	metadata?: Record<string, unknown>;
}

export interface PromoteFactsOutput {
	resource_id: number;
	version_id: number;
	canonical_key: string;
	title: string;
	facts_linked: number;
	edges_created: Array<{
		target_resource_id: number;
		edge_type: "cites";
	}>;
	warnings: Array<{ code: string; message: string }>;
}

/**
 * Materialise a cluster of memory facts into a wiki page.
 *
 * Pulls fact content from the host-supplied `factSource` callback (or
 * directly via the array shape when the caller has already loaded
 * them). Body generation is host-injected. After page creation,
 * `linkPromotedFacts` binds the page-version to the source facts.
 */
export async function promoteFactsToPage(
	store: import("./sqlite").SqliteWorkspaceStore,
	input: PromoteFactsInput & {
		/**
		 * Fact content source. Either pass `fact_ids` *and* a `factSource`
		 * callback; or pass `facts` directly with the bodies inline.
		 */
		factSource?: (fact_ids: string[]) => Promise<Array<PromotedFact>>;
		facts?: Array<PromotedFact>;
	},
): Promise<PromoteFactsOutput> {
	const warnings: Array<{ code: string; message: string }> = [];
	const { workspace_id, user_id, runId, resource_type } = input;

	if ((!input.facts || input.facts.length === 0) && input.fact_ids.length === 0) {
		warnings.push({
			code: "promote_no_facts",
			message: "promoteFactsToPage requires at least one fact_id or facts entry.",
		});
		return {
			resource_id: 0,
			version_id: 0,
			canonical_key: "",
			title: input.title ?? "",
			facts_linked: 0,
			edges_created: [],
			warnings,
		};
	}

	let facts: PromotedFact[];
	if (input.facts && input.facts.length > 0) {
		facts = input.facts;
	} else if (input.factSource) {
		try {
			facts = await input.factSource(input.fact_ids);
		} catch (error) {
			warnings.push({
				code: "promote_fact_source_failed",
				message: (error as Error).message ?? "factSource callback failed",
			});
			return {
				resource_id: 0,
				version_id: 0,
				canonical_key: "",
				title: input.title ?? "",
				facts_linked: 0,
				edges_created: [],
				warnings,
			};
		}
	} else {
		warnings.push({
			code: "promote_fact_source_missing",
			message: "Either `facts` or `factSource` must be supplied when `fact_ids` is non-empty.",
		});
		return {
			resource_id: 0,
			version_id: 0,
			canonical_key: "",
			title: input.title ?? "",
			facts_linked: 0,
			edges_created: [],
			warnings,
		};
	}

	const title = input.title ?? deriveTitleFromFacts(facts);
	const canonicalKey = input.canonical_key ?? `${slugify(title)}.md`;

	// Avoid clobbering an existing page at the same canonical key.
	const existing = store.findResourceByCanonicalKey({
		workspace_id,
		canonical_key: canonicalKey,
	});
	if (existing) {
		warnings.push({
			code: "promote_canonical_key_exists",
			message: `canonical_key '${canonicalKey}' already resolves to resource_id ${existing.id}; aborting to avoid overwrite. Pass an explicit canonical_key to force a different location.`,
		});
		return {
			resource_id: 0,
			version_id: 0,
			canonical_key: canonicalKey,
			title,
			facts_linked: 0,
			edges_created: [],
			warnings,
		};
	}

	// 1. Materialise body via host-injected LLM (or trivial concatenation).
	let body: string;
	let frontMatter: OkfFrontMatter | undefined;
	if (input.bodyGenerator) {
		try {
			const generated = await input.bodyGenerator({ facts, title });
			body = generated.body;
			frontMatter = generated.front_matter;
		} catch (error) {
			warnings.push({
				code: "promote_body_generator_failed",
				message: (error as Error).message ?? "bodyGenerator threw",
			});
			body = trivialConcat(facts, title);
		}
	} else {
		body = trivialConcat(facts, title);
	}

	// 2. Run the standard OKF ingestion path.
	const folderResource: OkfFolderResource = {
		canonical_key: canonicalKey,
		absolute_path: canonicalKey, // synthetic; indexResource doesn't read it back
		title,
		resource_type: resource_type ?? "promoted-page",
		body,
		size_bytes: Buffer.byteLength(body, "utf8"),
		front_matter: frontMatter,
	};

	const indexResult = await store.indexResource({
		workspace_id,
		user_id,
		resource: folderResource,
	});

	// 3. Bind facts to the page version.
	const linkResult = store.linkPromotedFacts({
		workspace_id,
		resource_id: indexResult.resource_id,
		version_id: indexResult.version_id,
		fact_ids: facts.map((f) => f.id),
	});

	// 4. Optional: write a `promote_facts` provenance on the page-level
	// edges. For now the link table captures the same fact, so we
	// don't double-write edges. Return empty edges_created.
	void runId;
	void ({} as EdgeProvenance);

	return {
		resource_id: indexResult.resource_id,
		version_id: indexResult.version_id,
		canonical_key: canonicalKey,
		title,
		facts_linked: linkResult.inserted,
		edges_created: [],
		warnings,
	};
}

function deriveTitleFromFacts(facts: PromotedFact[]): string {
	const first = facts[0]?.content ?? "Untitled";
	// Take the first 80 chars of the first fact content, trimmed.
	const trimmed = first.replace(/\s+/g, " ").slice(0, 80).trim();
	return trimmed.length > 0 ? trimmed : "Untitled";
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

function trivialConcat(facts: PromotedFact[], title: string): string {
	const body = facts.map((f) => `- ${f.content}`).join("\n");
	return `# ${title}\n\n${body}\n`;
}
