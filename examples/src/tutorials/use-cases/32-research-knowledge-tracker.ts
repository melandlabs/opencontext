import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
	const store = await createMemoryStore();
	const messages = await getRawMessageManager();

	console.log("📚 Research Knowledge Tracker initialized\n");

	const now = Date.now();

	// Initial finding on transformer attention
	await messages.storeMessages([
		{
			messageId: `finding-transformer-attention-${now}`,
			userId: "researcher-001",
			content:
				"Key finding: Transformer attention mechanisms show O(n²) complexity, limiting scalability to long sequences. This is the primary bottleneck.",
			platform: "research-tracker",
			botId: "research-assistant",
			timestamp: now,
			createdAt: now,
			metadata: {
				type: "finding",
				category: "llm-architecture",
				papers: ["vaswani2017"],
				authors: ["Vaswani", "Shazeer", "Parmar"],
				year: 2017,
				theme: "attention-mechanism",
				confidence: "high",
				tags: ["transformer", "attention", "complexity", "scalability"],
			},
		},
	]);
	console.log("✅ Stored initial finding");

	// New research 6 months later - sparse attention
	const newResearchTime = now + 86400000 * 180;
	await messages.storeMessages([
		{
			messageId: `finding-efficient-attention-${newResearchTime}`,
			userId: "researcher-001",
			content:
				"UPDATE: Sparse attention mechanisms (BigBird, Longformer) reduce complexity to O(n) or O(n√n) for long sequences. The O(n²) limitation is now partially solved.",
			platform: "research-tracker",
			botId: "research-assistant",
			timestamp: newResearchTime,
			createdAt: newResearchTime,
			metadata: {
				type: "finding",
				category: "llm-architecture",
				papers: ["zaheer2020", "beltagy2020"],
				authors: ["Zaheer", "Beltagy"],
				year: 2020,
				theme: "attention-mechanism",
				confidence: "high",
				tags: ["sparse-attention", "efficiency", "long-sequences"],
				updates: `finding-transformer-attention-${now}`,
				evolution: "partial-solution",
			},
		},
	]);
	console.log("✅ Added updated research (sparse attention)");

	// Related finding - state space models
	await messages.storeMessages([
		{
			messageId: `finding-state-space-models-${newResearchTime + 1000}`,
			userId: "researcher-001",
			content:
				"Alternative approach: State-space models (Mamba, S4) offer O(n) complexity with competitive performance on long sequences. Different paradigm than sparse attention.",
			platform: "research-tracker",
			botId: "research-assistant",
			timestamp: newResearchTime + 1000,
			createdAt: newResearchTime + 1000,
			metadata: {
				type: "finding",
				category: "llm-architecture",
				papers: ["gu2023", "gu2021"],
				authors: ["Gu", "Dao"],
				year: 2023,
				theme: "state-space-models",
				confidence: "emerging",
				tags: ["ssm", "mamba", "linear-complexity", "alternative-paradigm"],
				relatedThemes: ["attention-mechanism", "efficiency"],
			},
		},
	]);
	console.log("✅ Connected related research (state space models)");

	// Semantic search for efficiency findings
	const efficiencyFindings = await store.search({
		userId: "researcher-001",
		query: "approaches to improve transformer efficiency for long sequences",
		limit: 20,
	});

	console.log("\n📊 Findings on efficiency:");
	for (const hit of efficiencyFindings.results) {
		const meta = hit.metadata || {};
		console.log(`- ${hit.content}`);
		console.log(`  Papers: ${meta.papers?.join(", ")}`);
		console.log(`  Theme: ${meta.theme}, Year: ${meta.year}`);
	}

	// Time-travel: What did we know 3 months in?
	const knowledgeBeforeSparse = await store.search({
		userId: "researcher-001",
		query: "transformer attention complexity limitations",
		asOf: now + 86400000 * 90, // 3 months after initial finding
	});

	console.log("\n🕰️ What we knew 3 months in:");
	for (const hit of knowledgeBeforeSparse.results) {
		console.log(`- ${hit.content}`);
	}

	// Current knowledge
	const currentKnowledge = await store.search({
		userId: "researcher-001",
		query: "transformer attention complexity solutions",
	});

	console.log("\n✨ What we know now:");
	for (const hit of currentKnowledge.results) {
		console.log(`- ${hit.content}`);
	}

	// Find by theme
	async function findByTheme(theme: string) {
		const findings = await store.search({
			userId: "researcher-001",
			query: `research related to ${theme}`,
			metadata: {
				type: "finding",
			},
			limit: 50,
		});

		const themeMatches = findings.results.filter(
			(f) => f.metadata?.theme === theme || f.metadata?.relatedThemes?.includes(theme),
		);

		console.log(`\n🔗 Research connected to '${theme}':`);
		for (const hit of themeMatches) {
			const meta = hit.metadata || {};
			console.log(`- ${hit.content}`);
			console.log(`  Theme: ${meta.theme}, Papers: ${meta.papers?.join(", ")}`);
		}

		return themeMatches;
	}

	await findByTheme("attention-mechanism");

	// Synthesis of findings
	const synthesisTime = newResearchTime + 86400000 * 30;
	await messages.storeMessages([
		{
			messageId: `synthesis-efficiency-evolution-${synthesisTime}`,
			userId: "researcher-001",
			content:
				"SYNTHESIS: Long-sequence efficiency has evolved through three paradigms: (1) Original dense attention O(n²), (2) Sparse attention O(n) via approximations, (3) State-space models O(n) via architectural change. Each has trade-offs: accuracy vs speed, ease of implementation, hardware affinity. Current state: No clear winner, choice depends on use case.",
			platform: "research-tracker",
			botId: "research-assistant",
			timestamp: synthesisTime,
			createdAt: synthesisTime,
			metadata: {
				type: "synthesis",
				category: "llm-architecture",
				synthesizes: [
					`finding-transformer-attention-${now}`,
					`finding-efficient-attention-${newResearchTime}`,
					`finding-state-space-models-${newResearchTime + 1000}`,
				],
				themes: ["attention-mechanism", "state-space-models", "efficiency"],
				confidence: "high",
				tags: ["synthesis", "evolution", "trade-offs"],
			},
		},
	]);
	console.log("\n✅ Created synthesis");

	// Search by paper
	async function searchByPaper(paperId: string) {
		const findings = await store.search({
			userId: "researcher-001",
			query: `findings from paper ${paperId}`,
			limit: 20,
		});

		const paperFindings = findings.results.filter((f) => f.metadata?.papers?.includes(paperId));

		console.log(`\n📄 Findings citing ${paperId}:`);
		for (const hit of paperFindings) {
			console.log(`- ${hit.content}`);
			console.log(`  Category: ${hit.metadata?.category}`);
		}

		return paperFindings;
	}

	await searchByPaper("vaswani2017");

	// Find all syntheses
	const syntheses = await store.search({
		userId: "researcher-001",
		query: "research syntheses and overviews",
		metadata: {
			type: "synthesis",
		},
		limit: 10,
	});

	console.log("\n📝 Syntheses found:", syntheses.count);
	for (const hit of syntheses.results) {
		console.log(`- ${hit.content.substring(0, 80)}...`);
	}

	// Theme evolution tracking
	async function themeEvolution(theme: string) {
		const allFindings = await store.search({
			userId: "researcher-001",
			query: `research on ${theme}`,
			limit: 100,
		});

		const chronological = allFindings.results.sort((a, b) => a.timestamp - b.timestamp);

		console.log(`\n📈 Evolution of '${theme}':`);
		for (const finding of chronological) {
			const date = new Date(finding.timestamp).toLocaleDateString();
			console.log(`\n[${date}]`);
			console.log(`  ${finding.content.substring(0, 100)}...`);
		}
	}

	await themeEvolution("efficiency");

	console.log("\n✅ Research tracker demonstration complete");
}

main().catch((error) => {
	console.error("Research Knowledge Tracker failed:", error);
	process.exit(1);
});
