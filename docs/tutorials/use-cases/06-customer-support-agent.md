# Use Case: Customer Support Agent

## The Scenario

A customer support bot that remembers each customer's history, past issues, and provides personalized service. Unlike a stateless chatbot, this agent can:

- Recall a customer's entire interaction history
- Detect when a customer is reporting a repeat issue
- Track issue resolution over time
- Provide context-aware support based on past preferences

This use case demonstrates how OpenContext scales to handle multiple users while maintaining rich temporal context for each.

## What You'll Build

A customer support agent that:
1. **Remembers customer profiles** - Name, preferences, account details
2. **Tracks interaction history** - Every conversation, issue, and resolution
3. **Detects repeat issues** - Temporal queries find similar past problems
4. **Operates across platforms** - Gmail, Slack, web chat unified
5. **Imports existing data** - Batch operations for customer data migration

## Concepts Demonstrated

- `remember` - Storing customer profiles and interactions
- `recall` - Retrieving customer history with filters
- `time-travel` - Querying what happened at specific times
- **Multi-user support** - Per-customer memory isolation
- **Metadata filtering** - Search by issue type, status, category
- **Batch operations** - Efficient data import
- **Cross-platform** - Unifying memory from Gmail, Slack, etc.

## Prerequisites

Before starting this tutorial, you should:
1. Complete the [Getting Started](../00-getting-started.md) tutorial
2. Understand the [Four Verbs](../01-user-guide.md#the-four-verbs) from the User Guide
3. Have Node.js >= 22 installed

## Implementation

### Step 1: Setting Up the Support Agent

```typescript
import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";

async function main() {
  const store = await createMemoryStore();
  const messages = await getRawMessageManager();

  console.log("🎧 Customer Support Agent initialized");
}
```

### Step 2: Creating Customer Profiles

Store customer information with searchable metadata:

```typescript
const now = Date.now();

// Customer profile for Alice
await messages.storeMessages([
  {
    messageId: `profile-alice-${now}`,
    userId: "customer-alice@example.com",
    content: "Alice Chen, Enterprise customer, Plan: Premium, Since: 2024-01",
    platform: "support",
    botId: "support-agent",
    timestamp: now,
    createdAt: now,
    metadata: {
      type: "profile",
      tier: "enterprise",
      plan: "premium",
      accountOwner: "alice.chen@company.com",
    },
  },
]);
```

### Step 3: Tracking Support Interactions

Every conversation creates a memory:

```typescript
// First interaction - login issue
const interaction1 = now + 1000;

await messages.storeMessages([
  {
    messageId: `ticket-login-issue-${interaction1}`,
    userId: "customer-alice@example.com",
    content: "Issue: Cannot login to dashboard. Error: 'Invalid credentials'. Status: Resolved - User was using wrong email. Suggested adding email hint to login form.",
    platform: "gmail",
    botId: "support-agent",
    timestamp: interaction1,
    createdAt: interaction1,
    metadata: {
      type: "ticket",
      category: "login",
      status: "resolved",
      severity: "low",
      resolution: "user-error",
    },
  },
]);

// Second interaction - feature request
const interaction2 = interaction1 + 86400000; // Next day

await messages.storeMessages([
  {
    messageId: `ticket-feature-request-${interaction2}`,
    userId: "customer-alice@example.com",
    content: "Feature request: Export data to CSV. User needs this for monthly reports. Priority: High for enterprise workflow.",
    platform: "slack",
    botId: "support-agent",
    timestamp: interaction2,
    createdAt: interaction2,
    metadata: {
      type: "ticket",
      category: "feature-request",
      status: "backlog",
      severity: "medium",
      featureId: "csv-export",
    },
  },
]);
```

### Step 4: Retrieving Customer History

When a customer contacts support, instantly recall their history:

```typescript
async function getCustomerHistory(customerEmail: string) {
  const history = await store.searchUnifiedMemory({
    userId: customerEmail,
    query: "customer interactions history",
    limit: 50,
  });

  console.log(`\n📋 Customer History for ${customerEmail}:`);

  // Group by type
  const profiles = history.results.filter(h => h.metadata?.type === "profile");
  const tickets = history.results.filter(h => h.metadata?.type === "ticket");

  if (profiles.length > 0) {
    console.log("\n👤 Profile:");
    for (const profile of profiles) {
      console.log(`  ${profile.content}`);
    }
  }

  if (tickets.length > 0) {
    console.log(`\n🎫 Support Tickets (${tickets.length}):`);
    for (const ticket of tickets) {
      const meta = ticket.metadata;
      console.log(`  [${meta.status}] ${ticket.content}`);
      console.log(`    Category: ${meta.category}, Severity: ${meta.severity}`);
    }
  }

  return history;
}

await getCustomerHistory("customer-alice@example.com");
```

### Step 5: Detecting Repeat Issues

Use temporal queries to find if this issue happened before:

```typescript
async function checkRepeatIssue(customerEmail: string, issueCategory: string) {
  // Search for past issues in the same category
  const pastIssues = await store.searchUnifiedMemory({
    userId: customerEmail,
    query: `issues related to ${issueCategory}`,
    metadata: {
      type: "ticket",
      category: issueCategory,
    },
    limit: 20,
  });

  const resolvedIssues = pastIssues.results.filter(
    r => r.metadata?.status === "resolved"
  );

  if (resolvedIssues.length > 0) {
    console.log(`\n⚠️ REPEAT ISSUE DETECTED`);
    console.log(`   Customer has had ${resolvedIssues.length} ${issueCategory} issue(s) before`);
    console.log(`   Most recent resolution:`);
    console.log(`   - ${resolvedIssues[0].content}`);
    return true;
  }

  return false;
}

// Simulate a repeat login issue
const repeatInteraction = interaction2 + 86400000 * 7; // 1 week later

await messages.storeMessages([
  {
    messageId: `ticket-login-repeat-${repeatInteraction}`,
    userId: "customer-alice@example.com",
    content: "Issue: Cannot login again. Same error as last time. User confirmed using correct email now.",
    platform: "gmail",
    botId: "support-agent",
    timestamp: repeatInteraction,
    createdAt: repeatInteraction,
    metadata: {
      type: "ticket",
      category: "login",
      status: "investigating",
      severity: "high",
      isRepeat: true,
    },
  },
]);

await checkRepeatIssue("customer-alice@example.com", "login");
```

### Step 6: Cross-Platform Memory Unification

The same customer across different platforms:

```typescript
// Web chat interaction
await messages.storeMessages([
  {
    messageId: `chat-pricing-${now + 2000}`,
    userId: "customer-alice@example.com",
    content: "Chat: User asked about team pricing for 10 seats. Needs quote by Friday.",
    platform: "web-chat",
    botId: "support-agent",
    timestamp: now + 2000,
    createdAt: now + 2000,
    metadata: {
      type: "ticket",
      category: "sales",
      status: "pending",
    },
  },
]);

// Search across all platforms
const allInteractions = await store.searchUnifiedMemory({
  userId: "customer-alice@example.com",
  query: "all customer communications",
  sources: ["memory"],
  limit: 50,
});

console.log("\n🌐 Cross-platform interactions:");
const platforms = new Set();
for (const hit of allInteractions.results) {
  platforms.add(hit.platform);
}
console.log(`   Platforms: ${Array.from(platforms).join(", ")}`);
```

### Step 7: Batch Import Customer Data

Migrate existing customer data:

```typescript
async function importCustomerData(customers: Array<{
  email: string;
  name: string;
  tier: string;
  tickets: Array<{
    content: string;
    category: string;
    status: string;
    timestamp: number;
  }>;
}>) {
  const batchSize = 100;
  const allMessages: Array<any> = [];

  for (const customer of customers) {
    const customerNow = Date.now();

    // Add profile
    allMessages.push({
      messageId: `import-profile-${customer.email}-${customerNow}`,
      userId: customer.email,
      content: `${customer.name}, ${customer.tier} customer`,
      platform: "support",
      botId: "support-agent",
      timestamp: customerNow,
      createdAt: customerNow,
      metadata: {
        type: "profile",
        tier: customer.tier,
        imported: true,
      },
    });

    // Add tickets
    for (const ticket of customer.tickets) {
      allMessages.push({
        messageId: `import-ticket-${customer.email}-${ticket.timestamp}`,
        userId: customer.email,
        content: ticket.content,
        platform: "support",
        botId: "support-agent",
        timestamp: ticket.timestamp,
        createdAt: customerNow,
        metadata: {
          type: "ticket",
          category: ticket.category,
          status: ticket.status,
          imported: true,
        },
      });
    }

    // Batch process
    if (allMessages.length >= batchSize) {
      await messages.storeMessages(allMessages.splice(0, batchSize));
    }
  }

  // Process remaining
  if (allMessages.length > 0) {
    await messages.storeMessages(allMessages);
  }

  console.log(`✅ Imported ${customers.length} customers with their ticket history`);
}

// Example usage
const existingCustomers = [
  {
    email: "bob@company.com",
    name: "Bob Smith",
    tier: "pro",
    tickets: [
      {
        content: "API rate limiting question resolved",
        category: "api",
        status: "resolved",
        timestamp: Date.now() - 86400000 * 30,
      },
    ],
  },
];

await importCustomerData(existingCustomers);
```

## Running the Example

The complete example is available at:
`examples/src/tutorials/use-cases/31-customer-support-agent.ts`

Run it with:

```bash
cd /path/to/opencontext/examples
pnpm install
node --experimental-strip-types src/tutorials/use-cases/31-customer-support-agent.ts
```

## Expected Output

```
🎧 Customer Support Agent initialized
✅ Created customer profile
✅ Logged support interactions
✅ Detected repeat issue

📋 Customer History for customer-alice@example.com:

👤 Profile:
  Alice Chen, Enterprise customer, Plan: Premium, Since: 2024-01

🎫 Support Tickets (3):
  [resolved] Issue: Cannot login to dashboard...
    Category: login, Severity: low
  [backlog] Feature request: Export data to CSV...
    Category: feature-request, Severity: medium
  [investigating] Issue: Cannot login again...
    Category: login, Severity: high

⚠️ REPEAT ISSUE DETECTED
   Customer has had 1 login issue(s) before
   Most recent resolution:
   - Issue: Cannot login to dashboard...

🌐 Cross-platform interactions: gmail, slack, web-chat
✅ Imported 1 customer with their ticket history
```

## Next Steps

- **Personal Memory Assistant** - See individual-focused memory patterns
- **Research Knowledge Tracker** - Learn advanced metadata strategies
- [Advanced Usage](../03-advanced-usage.md) - Platform integrations and webhooks

## Common Patterns

### Searching by Customer Tier

```typescript
const enterpriseCustomers = await store.searchUnifiedMemory({
  query: "enterprise customers",
  metadata: { tier: "enterprise" },
  limit: 100,
});
```

### Finding Unresolved Tickets

```typescript
const openTickets = await store.searchUnifiedMemory({
  query: "unresolved support tickets",
  metadata: {
    type: "ticket",
    status: "open",
  },
  limit: 50,
});
```

### Customer-Specific Time Travel

```typescript
// What issues did this customer have last month?
const lastMonthIssues = await store.searchUnifiedMemory({
  userId: customerEmail,
  query: "customer issues",
  asOf: thirtyDaysAgo,
});
```
