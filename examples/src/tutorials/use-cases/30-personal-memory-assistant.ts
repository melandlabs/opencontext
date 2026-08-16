import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
	const store = await createMemoryStore();
	const messages = await getRawMessageManager();

	console.log("🧠 Personal Memory Assistant initialized\n");

	const now = Date.now();

	// Store user preferences
	await messages.storeMessages([
		{
			messageId: `pref-theme-${now}`,
			userId: "user-123",
			content: "User prefers dark mode in all applications",
			platform: "personal-assistant",
			botId: "memory-assistant",
			timestamp: now,
			createdAt: now,
			metadata: {
				type: "preference",
				category: "ui",
				priority: "high",
			},
		},
		{
			messageId: `pref-language-${now}`,
			userId: "user-123",
			content: "User communicates in English but is learning Spanish",
			platform: "personal-assistant",
			botId: "memory-assistant",
			timestamp: now,
			createdAt: now,
			metadata: {
				type: "preference",
				category: "language",
			},
		},
	]);
	console.log("✅ Stored 2 preferences");

	// Store a project idea note
	const noteTimestamp = now + 1000;
	await messages.storeMessages([
		{
			messageId: `note-project-idea-${noteTimestamp}`,
			userId: "user-123",
			content: "Consider building a personal knowledge graph that connects ideas across domains",
			platform: "personal-assistant",
			botId: "memory-assistant",
			timestamp: noteTimestamp,
			createdAt: noteTimestamp,
			metadata: {
				type: "note",
				category: "project-idea",
				tags: ["knowledge-graph", "innovation", "long-term"],
				importance: "high",
				context: "shower-thought",
			},
		},
	]);
	console.log("✅ Stored 1 note");

	// Semantic search - project notes
	const projectNotes = await store.searchUnifiedMemory({
		userId: "user-123",
		query: "What project ideas have I had?",
		limit: 10,
	});

	console.log("\n📝 Project Notes:");
	for (const hit of projectNotes.results) {
		const meta = hit.metadata || {};
		console.log(`- ${hit.content}`);
		console.log(`  Category: ${meta.category}, Importance: ${meta.importance}`);
	}

	// Search preferences by metadata type
	const preferences = await store.searchUnifiedMemory({
		userId: "user-123",
		query: "user preferences",
		metadata: {
			type: "preference",
		},
		limit: 20,
	});

	console.log("\n⚙️ User Preferences:");
	for (const hit of preferences.results) {
		console.log(`- ${hit.content} (${hit.metadata?.category})`);
	}

	// Time-travel: Simulate evolution of thinking
	const updatedTimestamp = noteTimestamp + 86400000; // 1 day later

	// Store updated view
	await messages.storeMessages([
		{
			messageId: `note-project-update-${updatedTimestamp}`,
			userId: "user-123",
			content:
				"Personal knowledge graph should focus on temporal connections - how ideas relate and evolve over time",
			platform: "personal-assistant",
			botId: "memory-assistant",
			timestamp: updatedTimestamp,
			createdAt: updatedTimestamp,
			metadata: {
				type: "note",
				category: "project-idea",
				tags: ["knowledge-graph", "temporal", "evolution"],
				importance: "high",
				replaces: `note-project-idea-${noteTimestamp}`,
			},
		},
	]);
	console.log("\n✅ Updated with new thinking");

	// Query: What was I thinking before the update?
	const beforeUpdate = await store.searchUnifiedMemory({
		userId: "user-123",
		query: "knowledge graph project",
		asOf: noteTimestamp + 3600000, // 1 hour after original note
	});

	console.log("\n🕰️ My thinking before the update:");
	for (const hit of beforeUpdate.results) {
		console.log(`- ${hit.content}`);
	}

	// Query: What's my current thinking?
	const currentThinking = await store.searchUnifiedMemory({
		userId: "user-123",
		query: "knowledge graph project",
	});

	console.log("\n✨ My current thinking:");
	for (const hit of currentThinking.results) {
		console.log(`- ${hit.content}`);
	}

	// Use improve pattern: correction that deprecates previous understanding
	const correctionTimestamp = updatedTimestamp + 3600000;

	await messages.storeMessages([
		{
			messageId: `correction-project-${correctionTimestamp}`,
			userId: "user-123",
			content:
				"Correction: The temporal aspect should apply to ALL connections, not just knowledge graphs. This is a fundamental principle.",
			platform: "personal-assistant",
			botId: "memory-assistant",
			timestamp: correctionTimestamp,
			createdAt: correctionTimestamp,
			metadata: {
				type: "correction",
				category: "principle",
				deprecates: [`note-project-update-${updatedTimestamp}`],
			},
		},
	]);
	console.log("\n✅ Added correction");

	// Latest understanding
	const latestUnderstanding = await store.searchUnifiedMemory({
		userId: "user-123",
		query: "what are my principles for knowledge management",
	});

	console.log("\n🎯 Latest understanding:");
	for (const hit of latestUnderstanding.results) {
		console.log(`- ${hit.content}`);
	}

	// Batch import existing notes
	const existingNotes = [
		{
			content: "Read about spaced repetition - could apply this to memory management",
			category: "learning",
			tags: ["spaced-repetition", "memory"],
			createdAt: Date.now() - 86400000 * 7, // 1 week ago
		},
		{
			content: "Investigation: How do biological memory systems handle conflicting information?",
			category: "research-question",
			tags: ["biology", "memory", "conflict-resolution"],
			createdAt: Date.now() - 86400000 * 3, // 3 days ago
		},
	];

	const importBatch = existingNotes.map((note, index) => ({
		messageId: `import-note-${index}-${Date.now()}`,
		userId: "user-123",
		content: note.content,
		platform: "personal-assistant",
		botId: "memory-assistant",
		timestamp: note.createdAt,
		createdAt: Date.now(),
		metadata: {
			type: "note",
			category: note.category,
			tags: note.tags,
			imported: true,
		},
	}));

	await messages.storeMessages(importBatch);
	console.log(`\n✅ Imported ${importBatch.length} existing notes`);

	// Verify import
	const importedNotes = await store.searchUnifiedMemory({
		userId: "user-123",
		query: "imported notes",
		metadata: {
			type: "note",
			imported: true,
		},
		limit: 10,
	});

	console.log(`\n📋 Imported notes verified: ${importedNotes.count} notes found`);
}

main().catch((error) => {
	console.error("Personal Memory Assistant failed:", error);
	process.exit(1);
});
