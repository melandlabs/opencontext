# Use Case: Customer Health Scoring

## The Scenario

A customer success team needs to identify which enterprise accounts are at risk of churn — before the customer actually cancels. The traditional signals (NPS, ticket volume) are too coarse: by the time NPS drops, the customer is already gone.

This use case shows how to wire the `distill` + `derive` primitives into a real-time health-scoring pipeline:

- **Per-interaction**: `distill` extracts the product(s) and pain points mentioned in each support ticket / chat / email.
- **Per-window**: `derive` synthesizes higher-level signals over the past 21 days — frequency of complaints, contradiction candidates (positive sentiment alongside churn intent), and trending issues per product.
- **Per-search**: when a CSM opens a customer profile, `search` surfaces related tickets with per-channel signals (`semantic`, `lexical`, `entity`) so they can see whether a match was triggered by keyword, semantic similarity, or product-entity link.

The end state is a CRM-shaped record per customer with a numeric `healthScore` (0–100) and a list of derived signals that a Loop-engine schedule would forward to the CS team's tooling (Slack alerts, Salesforce update, etc.).

## What You'll Build

A self-contained walkthrough that:

1. **Seeds** two customers — Alice (enterprise, churn-risk) and Bob (pro, healthy) — with ~6 weeks of interactions each.
2. **Runs `distill`** on every interaction: extracts `EntityEdge`s (product names, pain-point keywords) and persists them to a host-side entity store (in-memory Map).
3. **Runs `derive`** over the past 21 days: emits `DerivedFact`s of kinds `summary`, `frequency`, `contradiction_candidate`, `temporal_trend`. Persists them to a CRM-shaped record.
4. **Rolls up a health score** from the derived signals: contradiction candidates are the heaviest hit (-25), trending escalations -20, frequency of pain points -15 × confidence.
5. **Demonstrates `signals.entity`** on a CSM-facing search: results that match via the entity channel show up with `signals.channels = ["semantic", "entity"]`, so the CSM understands WHY the customer was surfaced.

## Concepts Demonstrated

- `distill` — single-message entity extraction with host-injected extractor
- `derive` — windowed fact synthesis with host-injected deriver (all 4 `DerivedKind` shapes)
- `signals` — per-hit per-channel score breakdown on `search()` results
- **Entity channel** in unified search — surface product / pain-point mentions via the host's `entitySearch` dep
- **CRM-shaped persistence** — host decides where signals go; the SDK just provides the primitives

## Prerequisites

Before starting this tutorial, you should:

1. Complete the [Getting Started](../00-getting-started.md) tutorial
2. Understand the [Four Verbs](../01-user-guide.md#the-four-verbs) from the User Guide
3. Have skimmed the [Extract, Derive, and Per-Hit Signals](../03-advanced-usage.md#extract-derive-and-per-hit-signals) section in Advanced Usage

## Walkthrough

Run the end-to-end example via the examples runner:

```bash
cd examples
pnpm test
```

Look for the `[opencontext/customer-health-scoring]` block. You'll see:

```
  Customer: customer-alice@example.com (enterprise)
    [OK  ] distill(alice-3-…) returns 2 edge(s) without warnings
    ...
    [OK  ] derive(customer-alice@example.com) returns 3 fact(s) without warnings
    [OK  ] derive(customer-alice@example.com) covers ≥ 2 distinct kind(s) (kinds=summary,frequency,temporal_trend)
    [OK  ] CRM(customer-alice@example.com) reflects 3 derived signal(s)

  Customer: customer-bob@example.com (pro)
    [OK  ] distill(bob-3-…) returns 1 edge(s) without warnings
    ...
    [OK  ] derive(customer-bob@example.com) returns 1 fact(s) without warnings

  CRM rollup:
    alice: score=66 signals=3 products=sso-integration,billing-api,analytics-dashboard
    bob:   score=100 signals=1 products=sso-integration,analytics-dashboard
    [OK  ] alice scores lower than bob (churn risk vs healthy)
    [OK  ] alice carries at least one contradiction_candidate OR temporal_trend

  Per-hit signals with entity channel wired
    [OK  ] some hits carry signals.entity after entity channel is wired (4/10)
    [OK  ] top hit exposes rrf + at least one per-channel score (channels=["semantic","entity"])
```

### What's interesting

- **Alice vs Bob**: same pipeline, same extractor, same deriver — but Alice's 21-day window produced 3 derived signals (`summary`, `frequency`, `temporal_trend`) while Bob's only produced 1 (`summary`). The scoring function punishes the churn-shaped ones, so Alice lands at 66 while Bob stays at 100.
- **`signals.channels = ["semantic", "entity"]`** on the top hit means: "this message was surfaced both because it semantically matched your query AND because the entity store flagged it as mentioning `billing-api`." That's actionable context for a CSM — they're not just seeing a fuzzy match, they're seeing a product-linked match.
- **No LLM required**: the stub extractor is rule-based (matches known product tokens + pain-point keywords) and the stub deriver counts tokens. In production you'd swap in your real LLM-backed extractor / deriver without touching the rest of the pipeline — that's the whole point of `distill` / `derive` being opt-in + host-injected.

## Implementation

The full source is in [`examples/src/tutorials/use-cases/35-customer-health-scoring.ts`](../../examples/src/tutorials/use-cases/35-customer-health-scoring.ts). Key snippets:

### Entity extractor (stub)

```typescript
const entityExtractor = async (input: {
  userId: string;
  messageId: string;
  content: string;
}): Promise<EntityEdge[]> => {
  const out: EntityEdge[] = [];
  const lowered = input.content.toLowerCase();

  // Known product tokens → `product` kind
  for (const product of ["billing-api", "analytics-dashboard", "sso-integration"]) {
    if (lowered.includes(product) || /* regex variants */) {
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

  // Pain-point keywords → `concept` kind with host-defined relation
  for (const pain of ["bug", "outage", "broken", "frustrated", "disappointed", "switching"]) {
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
```

### Deriver (stub) — emits all 4 `DerivedKind` shapes

```typescript
const deriver = async (input: {
  userId: string;
  userScope: { userId: string; botIds?: string[] };
  recentFactTexts: string[];
  window?: { from: number; to: number };
}): Promise<DerivedFact[]> => {
  // Always emit a `summary`
  out.push({ text: `Last ${facts.length} interactions…`, kind: "summary", sources, derivedAt });

  // Emit `frequency` when pain-point mentions are clustered
  if (painCount > 0) {
    out.push({ text: `Customer mentioned pain points ${painCount} times…`, kind: "frequency", ... });
  }

  // Emit `contradiction_candidate` when churn intent meets positive sentiment
  if (allText.includes("switching") && allText.includes("happy")) {
    out.push({ text: `Potential contradiction…`, kind: "contradiction_candidate", ... });
  }

  // Emit `temporal_trend` when a product keeps showing up in issues
  if (billingHits >= 2) {
    out.push({ text: `Repeated "billing-api" issues…`, kind: "temporal_trend", ... });
  }
  return out;
};
```

### Per-customer pipeline

```typescript
for (const interaction of customerInteractions) {
  await messages.storeMessages([interaction]);
  const { edges } = await distillRawMessage({ entityExtractor }, {
    userId: customer.email,
    messageId: interaction.messageId,
    content: interaction.content,
    persist: async (edges) => { /* write to host's entity store */ },
  });
}

const { facts } = await deriveFacts({ deriver }, {
  userId: customer.email,
  query: "customer satisfaction churn risk",
  candidateTexts: recentTexts,
  window: { from: now - 21 * DAY, to: now },
  persist: async (facts) => { /* write to host's CRM store */ },
});
```

## Production swap-ins

| Stub in the demo | Production replacement |
|---|---|
| `entityExtractor` (rule-based) | LLM-backed extractor: OpenAI function-call, Anthropic tool-use, or hosted NER. Same `EntityEdge[]` shape, same `persist` hook for the host. |
| `deriver` (token-counter) | LLM-backed deriver: prompt with the candidate texts, parse out 0–N `DerivedFact`s. Same input/output contract. |
| In-memory `entityStore` Map | Real entity store: graph nodes, Postgres table, vector index. Any shape — the SDK never reads it directly. |
| In-memory `crm` Map | Real CRM: Salesforce / HubSpot / Linear API. The `persist` callback is your write boundary. |
| Manual `scoreFromSignals()` | Periodic cron (Loop engine) running the rollup + alerting logic. |

## What you get out of the box

- **Per-message**: `EntityEdge`s flowing into your entity store as interactions land.
- **Per-window**: `DerivedFact`s rolling into your CRM as the Loop-engine cron fires.
- **Per-search**: per-channel `signals` so CSMs can see why a customer match surfaced (semantic vs keyword vs entity link).
- **Best-effort by design**: any of the three primitives can degrade to `{ edges: [], warnings: [...] }` when the host hasn't wired its LLM — no exceptions, no breakage.

## Next Steps

- See [`03-advanced-usage.md#extract-derive-and-per-hit-signals`](../03-advanced-usage.md#extract-derive-and-per-hit-signals) for the underlying API contract.
- See the runnable source: [`examples/src/tutorials/use-cases/35-customer-health-scoring.ts`](../../examples/src/tutorials/use-cases/35-customer-health-scoring.ts).