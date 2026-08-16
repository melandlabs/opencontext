# Use Case: Personal Memory Assistant

## The Scenario

Imagine an AI assistant that truly remembers you - your preferences, your notes, your habits, and how your thinking evolves over time. A personal memory assistant helps you capture thoughts, retrieve contextually relevant information, and see how your understanding has changed.

This is different from a simple note-taking app. With OpenContext's temporal memory, your assistant can:
- Remember your preferences across sessions
- Store notes with rich metadata for semantic search
- Show you what you thought about a topic in the past
- Update and correct memories as your understanding evolves

## What You'll Build

A personal memory assistant that:
1. **Captures preferences** - Theme, language, work habits, communication style
2. **Stores notes with metadata** - Tags, categories, importance levels
3. **Performs semantic search** - Find notes by meaning, not just keywords
4. **Time-travels through your thoughts** - See what you believed at specific points in time
5. **Improves memories** - Update facts and deprecate outdated information

## Concepts Demonstrated

- `remember` - Storing preferences and notes with metadata
- `recall` - Semantic search with filtering
- `time-travel` - Querying memory as of a specific time
- `improve` - Updating and correcting memories
- `forget` - Deprecating outdated information
- **Metadata filtering** - Using metadata for advanced search
- **Batch operations** - Efficiently importing existing notes

## Prerequisites

Before starting this tutorial, you should:
1. Complete the [Getting Started](../00-getting-started.md) tutorial
2. Understand the [Four Verbs](../01-user-guide.md#the-four-verbs) from the User Guide
3. Have Node.js >= 22 installed

## Implementation

### Step 1: Setting Up the Assistant

Create a new file `personal-memory-assistant.ts`:

```typescript
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const store = await createMemoryStore();
  const messages = await getRawMessageManager();

  console.log("🧠 Personal Memory Assistant initialized");
}
```

### Step 2: Storing User Preferences

Store user preferences with descriptive metadata:

```typescript
const now = Date.now();

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
```

### Step 3: Creating Rich Notes with Metadata

Store notes with searchable metadata:

```typescript
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
```

### Step 4: Semantic Search Across Memories

Use semantic search to find relevant information:

```typescript
// Search for project-related notes
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

// Filter by metadata type
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
```

### Step 5: Time-Travel Queries

See what you thought at a specific point in time:

```typescript
// First, let's simulate some time passing and a change of mind
const updatedTimestamp = noteTimestamp + 86400000; // 1 day later

// Store an updated view
await messages.storeMessages([
  {
    messageId: `note-project-update-${updatedTimestamp}`,
    userId: "user-123",
    content: "Personal knowledge graph should focus on temporal connections - how ideas relate and evolve over time",
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
```

### Step 6: Using Improve to Update Memories

When you learn new information that changes your understanding:

```typescript
const correctionTimestamp = updatedTimestamp + 3600000;

// Store a correction (using "improve" pattern)
await messages.storeMessages([
  {
    messageId: `correction-project-${correctionTimestamp}`,
    userId: "user-123",
    content: "Correction: The temporal aspect should apply to ALL connections, not just knowledge graphs. This is a fundamental principle.",
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

// Now when searching, the latest understanding surfaces
const latestUnderstanding = await store.searchUnifiedMemory({
  userId: "user-123",
  query: "what are my principles for knowledge management",
});

console.log("\n🎯 Latest understanding:");
for (const hit of latestUnderstanding.results) {
  console.log(`- ${hit.content}`);
}
```

### Step 7: Batch Import Existing Notes

If you have existing notes from another system:

```typescript
async function importExistingNotes(notes: Array<{
  content: string;
  category: string;
  tags: string[];
  createdAt: number;
}>) {
  const importBatch = notes.map((note, index) => ({
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
  console.log(`✅ Imported ${importBatch.length} notes`);
}

// Example usage
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

await importExistingNotes(existingNotes);
```

## Running the Example

The complete example is available at:
`examples/src/tutorials/use-cases/30-personal-memory-assistant.ts`

Run it with:

```bash
cd /Users/timi/codes/opencontext/examples
pnpm install
node --experimental-strip-types src/tutorials/use-cases/30-personal-memory-assistant.ts
```

## Expected Output

```
🧠 Personal Memory Assistant initialized
✅ Stored 2 preferences
✅ Stored 1 note
✅ Updated with new thinking
✅ Added correction

📝 Project Notes:
- Personal knowledge graph should focus on temporal connections...
  Category: project-idea, Importance: high

⚙️ User Preferences:
- User prefers dark mode in all applications (ui)
- User communicates in English but is learning Spanish (language)

🕰️ My thinking before the update:
- Consider building a personal knowledge graph...

✨ My current thinking:
- The temporal aspect should apply to ALL connections...

🎯 Latest understanding:
- Correction: The temporal aspect should apply to ALL connections...

✅ Imported 2 notes
```

## Next Steps

- **Customer Support Agent** - See how memory scales for multi-user scenarios
- **Research Knowledge Tracker** - Learn advanced temporal queries for research
- [Advanced Usage](../03-advanced-usage.md) - Explore multi-source search and platforms

## Common Patterns

### Searching by Category

```typescript
const workNotes = await store.searchUnifiedMemory({
  userId: "user-123",
  query: "work tasks",
  metadata: { category: "work" },
});
```

### Finding High-Priority Items

```typescript
const urgent = await store.searchUnifiedMemory({
  userId: "user-123",
  query: "important items",
  metadata: { importance: "high" },
});
```

### Tracking Evolution

Use the `asOf` parameter to see how your thinking changed:

```typescript
const then = await store.searchUnifiedMemory({
  userId: "user-123",
  query: "my approach",
  asOf: thirtyDaysAgo,
});

const now = await store.searchUnifiedMemory({
  userId: "user-123",
  query: "my approach",
});
```

Compare the results to see your growth.
