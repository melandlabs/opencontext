# Use Case: Research Knowledge Tracker

## The Scenario

A research assistant that tracks academic findings, citations, and how your understanding evolves as new research emerges. Unlike static reference managers, this tracker:

- Stores findings with temporal context
- Tracks how your understanding changes over time
- Connects related research via metadata
- Shows what was known at any point in time

This use case demonstrates how OpenContext enables knowledge management where the evolution of understanding is as important as the facts themselves.

## What You'll Build

A research knowledge tracker that:
1. **Stores research findings** - Papers, citations, key insights with metadata
2. **Tracks understanding evolution** - How new research changes existing knowledge
3. **Connects related findings** - Papers, authors, themes via metadata
4. **Time-travels through knowledge** - See what was known at specific points
5. **Improves with new information** - Update understanding with `improve`

## Concepts Demonstrated

- `remember` - Storing findings with rich metadata
- `recall` - Semantic search across research corpus
- `time-travel` - Querying knowledge state at specific times
- `improve` - Updating understanding with new research
- **Metadata linking** - Connecting papers, authors, themes
- **Temporal queries** - Understanding knowledge evolution
- **Semantic connections** - Finding related research beyond keywords

## Prerequisites

Before starting this tutorial, you should:
1. Complete the [Getting Started](../00-getting-started.md) tutorial
2. Understand the [Four Verbs](../01-user-guide.md#the-four-verbs) from the User Guide
3. Have Node.js >= 22 installed

## Implementation

### Step 1: Setting Up the Research Tracker

```typescript
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const store = await createMemoryStore();
  const messages = await getRawMessageManager();

  console.log("📚 Research Knowledge Tracker initialized");
}
```

### Step 2: Storing Research Findings

Store findings with comprehensive metadata:

```typescript
const now = Date.now();

// Initial finding
await messages.storeMessages([
  {
    messageId: `finding-transformer-attention-${now}`,
    userId: "researcher-001",
    content: "Key finding: Transformer attention mechanisms show O(n²) complexity, limiting scalability to long sequences. This is the primary bottleneck.",
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
```

### Step 3: Tracking Understanding Evolution

As new research emerges, update your understanding:

```typescript
const newResearchTime = now + 86400000 * 180; // 6 months later

// New finding that changes understanding
await messages.storeMessages([
  {
    messageId: `finding-efficient-attention-${newResearchTime}`,
    userId: "researcher-001",
    content: "UPDATE: Sparse attention mechanisms (BigBird, Longformer) reduce complexity to O(n) or O(n√n) for long sequences. The O(n²) limitation is now partially solved.",
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
```

### Step 4: Connecting Related Research

Link findings through metadata:

```typescript
// Store related finding
await messages.storeMessages([
  {
    messageId: `finding-state-space-models-${newResearchTime + 1000}`,
    userId: "researcher-001",
    content: "Alternative approach: State-space models (Mamba, S4) offer O(n) complexity with competitive performance on long sequences. Different paradigm than sparse attention.",
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
```

### Step 5: Semantic Search Across Research

Find related research beyond exact keywords:

```typescript
// Search for efficiency improvements
const efficiencyFindings = await store.searchUnifiedMemory({
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
```

### Step 6: Time-Travel Through Knowledge

See what was understood at specific points:

```typescript
// What did we know before the new research?
const knowledgeBeforeSparse = await store.searchUnifiedMemory({
  userId: "researcher-001",
  query: "transformer attention complexity limitations",
  asOf: now + 86400000 * 90, // 3 months after initial finding
});

console.log("\n🕰️ What we knew 3 months in:");
for (const hit of knowledgeBeforeSparse.results) {
  console.log(`- ${hit.content}`);
}

// What do we know now?
const currentKnowledge = await store.searchUnifiedMemory({
  userId: "researcher-001",
  query: "transformer attention complexity solutions",
});

console.log("\n✨ What we know now:");
for (const hit of currentKnowledge.results) {
  console.log(`- ${hit.content}`);
}
```

### Step 7: Finding Related Work by Theme

Use metadata to find connected research:

```typescript
async function findByTheme(theme: string) {
  const findings = await store.searchUnifiedMemory({
    userId: "researcher-001",
    query: `research related to ${theme}`,
    metadata: {
      type: "finding",
    },
    limit: 50,
  });

  // Filter by theme or related themes
  const themeMatches = findings.results.filter(
    f => f.metadata?.theme === theme || f.metadata?.relatedThemes?.includes(theme)
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
await findByTheme("efficiency");
```

### Step 8: Using Improve for Synthesis

Synthesize multiple findings into improved understanding:

```typescript
const synthesisTime = newResearchTime + 86400000 * 30; // 1 month later

await messages.storeMessages([
  {
    messageId: `synthesis-efficiency-evolution-${synthesisTime}`,
    userId: "researcher-001",
    content: "SYNTHESIS: Long-sequence efficiency has evolved through three paradigms: (1) Original dense attention O(n²), (2) Sparse attention O(n) via approximations, (3) State-space models O(n) via architectural change. Each has trade-offs: accuracy vs speed, ease of implementation, hardware affinity. Current state: No clear winner, choice depends on use case.",
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
```

### Step 9: Citation-Aware Search

Search by paper or author:

```typescript
async function searchByPaper(paperId: string) {
  const findings = await store.searchUnifiedMemory({
    userId: "researcher-001",
    query: `findings from paper ${paperId}`,
    limit: 20,
  });

  const paperFindings = findings.results.filter(
    f => f.metadata?.papers?.includes(paperId)
  );

  console.log(`\n📄 Findings citing ${paperId}:`);
  for (const hit of paperFindings) {
    console.log(`- ${hit.content}`);
    console.log(`  Category: ${hit.metadata?.category}`);
  }

  return paperFindings;
}

await searchByPaper("vaswani2017");
```

## Running the Example

The complete example is available at:
`examples/src/tutorials/use-cases/32-research-knowledge-tracker.ts`

Run it with:

```bash
cd /Users/timi/codes/opencontext/examples
pnpm install
node --experimental-strip-types src/tutorials/use-cases/32-research-knowledge-tracker.ts
```

## Expected Output

```
📚 Research Knowledge Tracker initialized
✅ Stored initial finding
✅ Added updated research
✅ Connected related findings
✅ Created synthesis

📊 Findings on efficiency:
- UPDATE: Sparse attention mechanisms reduce complexity...
  Papers: zaheer2020, beltagy2020
  Theme: attention-mechanism, Year: 2020
- Alternative approach: State-space models...
  Papers: gu2023, gu2021
  Theme: state-space-models, Year: 2023

🕰️ What we knew 3 months in:
- Key finding: Transformer attention mechanisms show O(n²) complexity...

✨ What we know now:
- UPDATE: Sparse attention mechanisms reduce complexity...
- Alternative approach: State-space models...
- SYNTHESIS: Long-sequence efficiency has evolved...

🔗 Research connected to 'attention-mechanism':
- Key finding: Transformer attention mechanisms show O(n²) complexity...
  Theme: attention-mechanism, Papers: vaswani2017
- UPDATE: Sparse attention mechanisms reduce complexity...
  Theme: attention-mechanism, Papers: zaheer2020, beltagy2020

📄 Findings citing vaswani2017:
- Key finding: Transformer attention mechanisms show O(n²) complexity...
  Category: llm-architecture
```

## Next Steps

- **Personal Memory Assistant** - See individual-focused memory patterns
- **Customer Support Agent** - Learn multi-user memory management
- [Advanced Usage](../03-advanced-usage.md) - Multi-source search and insights

## Common Patterns

### Finding Recent Research

```typescript
const recent = await store.searchUnifiedMemory({
  query: "recent research findings",
  metadata: {
    type: "finding",
  },
  limit: 50,
});

// Filter by recency
const lastMonth = recent.results.filter(
  r => r.metadata?.year && r.metadata.year >= 2023
);
```

### Tracking Confidence Levels

```typescript
const highConfidence = await store.searchUnifiedMemory({
  query: "well-established findings",
  metadata: {
    type: "finding",
    confidence: "high",
  },
});
```

### Finding Synthesis Documents

```typescript
const syntheses = await store.searchUnifiedMemory({
  query: "research syntheses and overviews",
  metadata: {
    type: "synthesis",
  },
});
```

### Theme Evolution Tracking

```typescript
// How has our understanding of a theme evolved?
async function themeEvolution(theme: string) {
  const allFindings = await store.searchUnifiedMemory({
    query: `research on ${theme}`,
    limit: 100,
  });

  // Sort by timestamp
  const chronological = allFindings.results.sort((a, b) =>
    a.timestamp - b.timestamp
  );

  console.log(`\n📈 Evolution of '${theme}':`);
  for (const finding of chronological) {
    const date = new Date(finding.timestamp).toLocaleDateString();
    console.log(`\n[${date}]`);
    console.log(`  ${finding.content}`);
  }
}
```
