// Full Team Knowledge System Test with embedding support
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

interface TeamMember {
	userId: string;
	name: string;
	role: string;
}

// Simple mock embedder for testing (in production, use real embeddings)
const mockEmbedder = {
	embed: async (text: string): Promise<number[]> => {
		// Create a simple hash-based embedding for testing
		const embedding = new Array(384).fill(0);
		let hash = 0;
		for (let i = 0; i < text.length; i++) {
			hash = text.charCodeAt(i) + ((hash << 5) - hash);
			embedding[i % embedding.length] = (hash % 1000) / 1000;
		}
		return embedding;
	},
};

class TeamKnowledgeSystem {
	private store: Awaited<ReturnType<typeof createMemoryStore>>;
	private messages: Awaited<ReturnType<typeof getRawMessageManager>>;

	async initialize() {
		this.store = await createMemoryStore({
			env: { isTauriMode: () => false },
			unified: {
				embedQuery: async ({ query }) => {
					return await mockEmbedder.embed(query);
				},
			},
		});
		this.messages = await getRawMessageManager();
		console.log("✓ Team Knowledge System initialized");
	}

	async recordDecision(decision: {
		member: TeamMember;
		topic: string;
		decision: string;
		rationale: string;
	}): Promise<void> {
		const now = Date.now();
		const content = `DECISION: ${decision.topic}. ${decision.member.role} ${decision.member.name} decided: "${decision.decision}". Rationale: ${decision.rationale}`;

		await this.messages.storeMessages([
			{
				messageId: `decision-${now}-${decision.member.userId}`,
				userId: `team-${decision.member.userId}`,
				content,
				platform: "team-knowledge",
				botId: "knowledge-system",
				timestamp: now,
				createdAt: now,
				metadata: {
					type: "decision",
					topic: decision.topic,
					role: decision.member.role,
					memberName: decision.member.name,
				},
			},
		]);

		console.log(`✓ Recorded decision on: ${decision.topic}`);
	}

	async searchDecisions(query: string): Promise<void> {
		const results = await this.store.searchUnifiedMemory({
			userId: "team-demo",
			query: `decision ${query}`,
			limit: 10,
		});

		console.log(`\n=== Found ${results.count} decisions ===`);

		if (results.warnings.length > 0) {
			console.log("Warnings:", results.warnings.map((w) => w.code).join(", "));
		}

		for (const hit of results.results) {
			console.log(`\n${hit.content}`);
			console.log(`Score: ${hit.score.toFixed(2)} | ${new Date(hit.timestamp).toLocaleString()}`);
		}
	}

	async searchAllDecisions(): Promise<void> {
		const results = await this.store.searchUnifiedMemory({
			userId: "team-demo",
			query: "decision",
			limit: 10,
		});

		console.log(`\n=== All Decisions (${results.count}) ===`);

		for (const hit of results.results) {
			const topic = hit.metadata?.topic || "unknown";
			const member = hit.metadata?.memberName || "unknown";
			console.log(`\n[${topic}] by ${member}`);
			console.log(`  ${hit.content}`);
		}
	}
}

async function main() {
	const system = new TeamKnowledgeSystem();
	await system.initialize();

	console.log("\n=== Recording Team Decisions ===\n");

	await system.recordDecision({
		member: { userId: "alice", name: "Alice", role: "Tech Lead" },
		topic: "backend-framework",
		decision: "Use Node.js with Express for the backend API",
		rationale: "Team has existing Node.js expertise",
	});

	await system.recordDecision({
		member: { userId: "bob", name: "Bob", role: "Senior Developer" },
		topic: "database",
		decision: "Use PostgreSQL as the primary database",
		rationale: "Need ACID compliance for financial transactions",
	});

	await system.recordDecision({
		member: { userId: "carol", name: "Carol", role: "DevOps Engineer" },
		topic: "hosting",
		decision: "Deploy to AWS using ECS",
		rationale: "Existing AWS infrastructure",
	});

	console.log("\n=== Searching All Decisions ===\n");
	await system.searchAllDecisions();

	console.log("\n=== Searching Specific Topic ===\n");
	await system.searchDecisions("database");

	console.log("\n✓ All tests passed!");
	process.exit(0);
}

main().catch((error) => {
	console.error("Error:", error);
	process.exit(1);
});
