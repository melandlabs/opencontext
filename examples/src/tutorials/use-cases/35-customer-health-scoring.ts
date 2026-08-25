/**
 * Customer Health Scoring — end-to-end walkthrough that wires the new
 * `distill` + `derive` primitives into a customer success workflow.
 *
 * Pipeline:
 *   1. Store ~6 weeks of interactions for two enterprise customers:
 *      Alice (churning — satisfaction decline, repeated bugs, feature
 *      complaints) and Bob (healthy — questions answered, on a
 *      growth path, no escalations).
 *   2. After ingest, run `distill` over each new support ticket to
 *      extract product / feature / pain-point entities — these go to
 *      a host-managed entity store (here: an in-memory Map) so the
 *      unified search entity channel can pick them up later.
 *   3. Run `derive` over the past 21 days of candidate fact texts;
 *      the host wires a rule-based deriver that surfaces four signal
 *      shapes: `summary`, `frequency`, `contradiction_candidate`,
 *      `temporal_trend`. Persist the resulting `DerivedFact[]` into
 *      a CRM-shaped Map that the Loop engine would forward to the
 *      CS team's tooling.
 *   4. Run `search` with `mergeStrategy: "rrf"` and the entity
 *      channel wired; show that the health hits carry
 *      `signals.entity` so CS agents can see WHY a customer was
 *      surfaced (semantic similarity vs. literal keyword match vs.
 *      product-entity link).
 *
 * Run via the examples runner:
 *
 *     cd examples && pnpm test
 */

import type { DerivedFact, EntityEdge } from "@melandlabs/contracts";
import {
	createMemoryStore,
	createUnifiedSearch,
	deriveFacts,
	distillRawMessage,
	type HitSignals,
	getRawMessageManager,
} from "@melandlabs/opencontext";
import { runIfMain } from "../../_helpers.ts";

// ─── Shared check helpers ─────────────────────────────────────────────────

let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
	const tag = ok ? "OK  " : "FAIL";
	const suffix = detail ? ` (${detail})` : "";
	console.log(`    [${tag}] ${label}${suffix}`);
	if (!ok) failed += 1;
}

// ─── Host-side persistence mocks (CRM + entity store) ──────────────────────

interface HealthSignal {
	text: string;
	kind: DerivedFact["kind"];
	confidence: number;
	sources: string[];
}

interface CrmRecord {
	customerEmail: string;
	tier: string;
	healthScore: number; // 0–100, higher is healthier
	signals: HealthSignal[];
	productMentions: string[];
}

const crm: Map<string, CrmRecord> = new Map();
const entityStore: Map<string, Set<string>> = new Map(); // label → Set<messageId>

function pushCrmSignal(email: string, signal: HealthSignal) {
	const existing = crm.get(email) ?? {
		customerEmail: email,
		tier: "enterprise",
		healthScore: 50,
		signals: [],
		productMentions: [],
	};
	existing.signals.push(signal);
	crm.set(email, existing);
}

function noteEntity(label: string, messageId: string) {
	const bucket = entityStore.get(label) ?? new Set<string>();
	bucket.add(messageId);
	entityStore.set(label, bucket);

	// In production the host's entitySearch would do label-match scoring.
	// Here we mirror what an entitySearch would resolve: the label itself
	// AND its hyphen-split parts (so a search query for "billing" still
	// finds messages tagged with `billing-api`). The unified search
	// splits `query` into keywords and looks each one up in the entity
	// store — without this split-index the entity sub-query wouldn't see
	// compound product labels.
	const parts = label.split("-");
	for (const part of parts) {
		if (part === label || part.length < 3) continue;
		const sub = entityStore.get(part) ?? new Set<string>();
		sub.add(messageId);
		entityStore.set(part, sub);
	}
}

// ─── Stub extractors / derivers (rule-based so the demo has no LLM deps) ──

/**
 * Trivial extractor: pulls uppercase product / feature tokens
 * (≥ 3 chars) and known pain-point keywords. In production this is
 * where you'd call your LLM extractor — the SDK doesn't care which.
 */
const entityExtractor = async (input: {
	userId: string;
	messageId: string;
	content: string;
}): Promise<EntityEdge[]> => {
	const out: EntityEdge[] = [];
	const lowered = input.content.toLowerCase();

	// Known product tokens → `product` kind
	const productTokens = ["billing-api", "analytics-dashboard", "sso-integration"];
	for (const product of productTokens) {
		// Match either the hyphenated form, the space-separated form, or
		// the bare prefix (e.g. "SSO" alone counts as a mention of the
		// sso-integration product).
		const barePrefix = product.split("-")[0] ?? product;
		if (
			lowered.includes(product) ||
			lowered.includes(product.replace(/-/g, " ")) ||
			(barePrefix.length >= 3 && new RegExp(`\\b${barePrefix}\\b`, "i").test(input.content))
		) {
			out.push({
				label: product,
				kind: "product",
				relation: "mentions",
				sourceMessageId: input.messageId,
				extractedAt: Date.now(),
				confidence: 0.9,
			});
		}
	}

	// Known pain-point keywords → `concept` kind with a dedicated
	// `pain_point` relation. Host-defined string.
	const painPoints = ["bug", "outage", "broken", "frustrated", "disappointed", "switching"];
	for (const pain of painPoints) {
		if (lowered.includes(pain)) {
			out.push({
				label: pain,
				kind: "concept",
				relation: "pain_point",
				sourceMessageId: input.messageId,
				extractedAt: Date.now(),
				confidence: 0.75,
			});
		}
	}
	return out;
};

/**
 * Stub deriver: scans the candidate fact texts and emits up to four
 * `DerivedFact` shapes based on simple counts. The real deriver would
 * call an LLM, but the SDK surface is identical either way.
 */
const deriver = async (input: {
	userId: string;
	userScope: { userId: string; botIds?: string[] };
	recentFactTexts: string[];
	window?: { from: number; to: number };
}): Promise<DerivedFact[]> => {
	const out: DerivedFact[] = [];
	const facts = input.recentFactTexts;
	const allText = facts.join(" \n ").toLowerCase();
	const now = Date.now();

	// summary — always present
	out.push({
		text: `Last ${facts.length} support interactions include ${facts.filter((f) => f.includes("Issue: ")).length} ticket(s) and ${facts.filter((f) => f.includes("Chat: ")).length} chat(s).`,
		kind: "summary",
		sources: facts.map((_, i) => `cand-${i}`),
		confidence: 0.7,
		derivedAt: now,
	});

	// frequency — count pain-point mentions
	const painWords = ["bug", "outage", "broken", "frustrated", "disappointed"];
	const painCount = painWords.reduce(
		(acc, w) => acc + (allText.match(new RegExp(`\\b${w}\\b`, "g"))?.length ?? 0),
		0,
	);
	if (painCount > 0) {
		out.push({
			text: `Customer mentioned pain points ${painCount} times in the window — risk: dissatisfaction.`,
			kind: "frequency",
			sources: facts.map((_, i) => `cand-${i}`),
			confidence: Math.min(0.95, 0.5 + painCount * 0.1),
			derivedAt: now,
		});
	}

	// contradiction_candidate — "switching" near "we love" or similar
	if (allText.includes("switching") && (allText.includes("love") || allText.includes("happy"))) {
		out.push({
			text: `Potential contradiction: switching intent detected alongside positive sentiment — needs CSM follow-up.`,
			kind: "contradiction_candidate",
			sources: facts.map((_, i) => `cand-${i}`),
			confidence: 0.8,
			derivedAt: now,
		});
	}

	// temporal_trend — repeated product issues
	const billingHits = (allText.match(/\bbilling[- ]?api\b/g) ?? []).length;
	if (billingHits >= 2) {
		out.push({
			text: `Repeated "billing-api" issues over the window (${billingHits} mentions) — trending escalation.`,
			kind: "temporal_trend",
			sources: facts.map((_, i) => `cand-${i}`),
			confidence: 0.85,
			derivedAt: now,
		});
	}

	return out;
};

// ─── Score helpers ─────────────────────────────────────────────────────────

function scoreFromSignals(signals: HealthSignal[]): number {
	let score = 100;
	for (const s of signals) {
		if (s.kind === "contradiction_candidate") score -= 25;
		if (s.kind === "temporal_trend" && s.text.includes("escalation")) score -= 20;
		if (s.kind === "frequency" && s.text.includes("dissatisfaction")) {
			score -= Math.round(15 * s.confidence);
		}
	}
	return Math.max(0, Math.min(100, score));
}

function summarizeCrm(email: string): string {
	const record = crm.get(email);
	if (!record) return "no record";
	return `score=${record.healthScore} signals=${record.signals.length} products=${record.productMentions.join(",") || "(none)"}`;
}

// ─── 1. Seed customer interactions ────────────────────────────────────────

interface Interaction {
	messageId: string;
	daysAgo: number;
	content: string;
	metadata: Record<string, unknown>;
}

const DAY = 86_400_000;

function aliceInteractions(now: number): Interaction[] {
	return [
		{
			messageId: `alice-1-${now}`,
			daysAgo: 20,
			content: "Chat: Happy with the new SSO integration rollout. Thanks team!",
			metadata: { type: "chat", sentiment: "positive" },
		},
		{
			messageId: `alice-2-${now}`,
			daysAgo: 15,
			content: "Issue: billing-api double-charged our team this month. Severity: high.",
			metadata: { type: "ticket", category: "billing", severity: "high" },
		},
		{
			messageId: `alice-3-${now}`,
			daysAgo: 12,
			content: "Issue: billing-api still flaky after the fix. Customers complaining. Frustrated.",
			metadata: { type: "ticket", category: "billing", severity: "high", isRepeat: true },
		},
		{
			messageId: `alice-4-${now}`,
			daysAgo: 8,
			content: "Chat: Was told billing-api bug is resolved but our account is still broken.",
			metadata: { type: "chat", sentiment: "negative" },
		},
		{
			messageId: `alice-5-${now}`,
			daysAgo: 5,
			content: "Email: We're evaluating alternatives. Disappointed with the broken billing experience.",
			metadata: { type: "email", sentiment: "negative", intent: "churn-risk" },
		},
		{
			messageId: `alice-6-${now}`,
			daysAgo: 1,
			content: "Issue: analytics-dashboard throwing 500s for the past 3 hours. Outage suspected.",
			metadata: { type: "ticket", category: "analytics", severity: "high", isOutage: true },
		},
	];
}

function bobInteractions(now: number): Interaction[] {
	return [
		{
			messageId: `bob-1-${now}`,
			daysAgo: 18,
			content: "Chat: How do we add a new SSO integration for our dev environment?",
			metadata: { type: "chat", sentiment: "neutral" },
		},
		{
			messageId: `bob-2-${now}`,
			daysAgo: 14,
			content: "Email: Thanks — the SSO docs were clear. We love the analytics-dashboard export feature.",
			metadata: { type: "email", sentiment: "positive" },
		},
		{
			messageId: `bob-3-${now}`,
			daysAgo: 10,
			content: "Chat: We're rolling SSO out to 3 more teams next month — happy to be a reference customer.",
			metadata: { type: "chat", sentiment: "positive", intent: "expansion" },
		},
		{
			messageId: `bob-4-${now}`,
			daysAgo: 4,
			content: "Email: Feature request — would love CSV export on analytics-dashboard. Not blocking.",
			metadata: { type: "email", sentiment: "neutral", intent: "feature-request" },
		},
	];
}

// ─── 2. Run the pipeline for one customer ─────────────────────────────────

async function runPipelineForCustomer(opts: {
	email: string;
	tier: string;
	interactions: Interaction[];
	now: number;
	messages: Awaited<ReturnType<typeof getRawMessageManager>>;
}) {
	console.log(`\n  Customer: ${opts.email} (${opts.tier})`);

	// Initialize CRM record
	crm.set(opts.email, {
		customerEmail: opts.email,
		tier: opts.tier,
		healthScore: 50,
		signals: [],
		productMentions: [],
	});

	// Step A: store interactions
	const toStore = opts.interactions.map((it) => ({
		messageId: it.messageId,
		userId: opts.email,
		content: it.content,
		platform: (it.metadata.platform as string) ?? "support",
		botId: "cs-loop",
		timestamp: opts.now - it.daysAgo * DAY,
		createdAt: opts.now - it.daysAgo * DAY,
		metadata: it.metadata,
	}));
	await opts.messages.storeMessages(toStore);

	// Step B: distill entities for each interaction
	for (const it of opts.interactions) {
		const distill = await distillRawMessage(
			{ entityExtractor },
			{
				userId: opts.email,
				messageId: it.messageId,
				content: it.content,
				persist: async (edges) => {
					for (const e of edges) {
						noteEntity(e.label, e.sourceMessageId);
						if (e.kind === "product") {
							const record = crm.get(opts.email)!;
							if (!record.productMentions.includes(e.label)) {
								record.productMentions.push(e.label);
							}
						}
					}
				},
			},
		);
		check(
			`distill(${it.messageId.slice(0, 24)}…) returns ${distill.edges.length} edge(s) without warnings`,
			distill.edges.length > 0 && distill.warnings.length === 0,
			`edges=${distill.edges.length}`,
		);
	}

	// Step C: derive facts over the past 21 days
	const windowFrom = opts.now - 21 * DAY;
	const windowTo = opts.now;
	const recentTexts = opts.interactions
		.filter((it) => opts.now - it.daysAgo * DAY >= windowFrom)
		.map((it) => it.content);

	const deriveOut = await deriveFacts(
		{ deriver },
		{
			userId: opts.email,
			query: "customer satisfaction churn risk",
			candidateTexts: recentTexts,
			window: { from: windowFrom, to: windowTo },
			persist: async (facts) => {
				for (const f of facts) {
					pushCrmSignal(opts.email, {
						text: f.text,
						kind: f.kind,
						confidence: f.confidence ?? 0.5,
						sources: f.sources,
					});
				}
			},
		},
	);
	check(
		`derive(${opts.email}) returns ${deriveOut.facts.length} fact(s) without warnings`,
		deriveOut.facts.length > 0 && deriveOut.warnings.length === 0,
		`facts=${deriveOut.facts.length}`,
	);
	// Healthy customers may only yield a `summary` — the lower bound
	// is 1, not 2. Churning customers should always surface extra
	// kinds (frequency / temporal_trend / contradiction_candidate).
	const kindSet = new Set(deriveOut.facts.map((f) => f.kind));
	const minKinds = opts.tier === "enterprise" ? 2 : 1;
	check(
		`derive(${opts.email}) covers ≥ ${minKinds} distinct kind(s)`,
		kindSet.size >= minKinds,
		`kinds=${[...kindSet].join(",")}`,
	);

	// Step D: roll up the health score from the derived signals
	const record = crm.get(opts.email)!;
	record.healthScore = scoreFromSignals(record.signals);

	check(`CRM(${opts.email}) reflects ${record.signals.length} derived signal(s)`, record.signals.length > 0);
}

// ─── 3. Search with entity channel + per-hit signals ──────────────────────

async function runSearchSignals() {
	console.log("\n  Per-hit signals with entity channel wired");

	// Build a self-contained in-memory semantic/lexical mock so we don't
	// need to spin up the real store here. The mock mirrors the same
	// hit shape that `searchRawMessagesAnn` would return.
	const aliceHits = Array.from(entityStore.entries())
		.filter(([, ids]) => ids.size > 0)
		.flatMap(([label, ids]) =>
			Array.from(ids).map((id) => ({
				id,
				content: `mock-content-for-${id}`,
				similarity: 0.8,
				metadata: { scoring: "entity" },
				entityLabel: label,
			})),
		);

	const search = createUnifiedSearch({
		embedQuery: async () => new Array(4).fill(0.1),
		searchRawMessagesAnn: async () => aliceHits,
		searchRawMessagesLexical: async () => [],
		// Entity sub-query: surface any message that mentioned a known
		// product. The score is intentionally simple — the real
		// provider would do label-match scoring.
		entitySearch: async ({ keywords }) => {
			const matches: Array<{ messageId: string; label: string; score: number }> = [];
			for (const keyword of keywords) {
				const ids = entityStore.get(keyword);
				if (!ids) continue;
				for (const id of ids) {
					matches.push({ messageId: id, label: keyword, score: 0.8 });
				}
			}
			return matches;
		},
	});

	const out = await search.search({
		userId: "customer-alice@example.com",
		query: "billing-api problems",
		mergeStrategy: "rrf",
	});

	check("search returns hits from the in-memory mock", out.results.length > 0, `count=${out.results.length}`);

	const hitsWithEntityChannel = out.results.filter((r) => r.signals?.channels.includes("entity"));
	check(
		"some hits carry signals.entity after entity channel is wired",
		hitsWithEntityChannel.length > 0,
		`${hitsWithEntityChannel.length}/${out.results.length}`,
	);

	const top = out.results[0];
	const topSignals = top?.signals as HitSignals | undefined;
	check(
		"top hit exposes rrf + at least one per-channel score",
		topSignals?.rrf !== undefined &&
			(topSignals?.semantic !== undefined ||
				topSignals?.lexical !== undefined ||
				topSignals?.entity !== undefined),
		`channels=${JSON.stringify(topSignals?.channels ?? [])}`,
	);
}

// ─── Entry point ──────────────────────────────────────────────────────────

async function main() {
	console.log("💼 Customer Health Scoring — distill + derive + signals\n");

	const store = await createMemoryStore();
	const messages = await getRawMessageManager();
	const now = Date.now();

	await runPipelineForCustomer({
		email: "customer-alice@example.com",
		tier: "enterprise",
		interactions: aliceInteractions(now),
		now,
		messages,
	});
	await runPipelineForCustomer({
		email: "customer-bob@example.com",
		tier: "pro",
		interactions: bobInteractions(now),
		now,
		messages,
	});

	console.log("\n  CRM rollup:");
	console.log(`    alice: ${summarizeCrm("customer-alice@example.com")}`);
	console.log(`    bob:   ${summarizeCrm("customer-bob@example.com")}`);

	const alice = crm.get("customer-alice@example.com")!;
	const bob = crm.get("customer-bob@example.com")!;
	check(
		"alice scores lower than bob (churn risk vs healthy)",
		alice.healthScore < bob.healthScore,
		`alice=${alice.healthScore} bob=${bob.healthScore}`,
	);
	check(
		"alice carries at least one contradiction_candidate OR temporal_trend",
		alice.signals.some((s) => s.kind === "contradiction_candidate" || s.kind === "temporal_trend"),
	);

	await runSearchSignals();

	await store.raw.close?.();

	console.log(`\nSummary: ${failed === 0 ? "all passed" : `${failed} failed`}`);
	if (failed > 0) process.exitCode = 1;
}

runIfMain("customer-health-scoring", main, import.meta.url);

export default main;
