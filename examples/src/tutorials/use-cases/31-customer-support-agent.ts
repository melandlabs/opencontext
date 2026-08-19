import { createMemoryStore, getRawMessageManager } from "@melandlabs/opencontext";
import { runIfMain } from "../../_helpers.ts";

async function main() {
	const store = await createMemoryStore();
	const messages = await getRawMessageManager();

	console.log("🎧 Customer Support Agent initialized\n");

	const now = Date.now();

	// Create customer profile
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
	console.log("✅ Created customer profile");

	// First support interaction - login issue
	const interaction1 = now + 1000;
	await messages.storeMessages([
		{
			messageId: `ticket-login-issue-${interaction1}`,
			userId: "customer-alice@example.com",
			content:
				"Issue: Cannot login to dashboard. Error: 'Invalid credentials'. Status: Resolved - User was using wrong email. Suggested adding email hint to login form.",
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
	console.log("✅ Logged first interaction (login issue)");

	// Second interaction - feature request
	const interaction2 = interaction1 + 86400000; // Next day
	await messages.storeMessages([
		{
			messageId: `ticket-feature-request-${interaction2}`,
			userId: "customer-alice@example.com",
			content:
				"Feature request: Export data to CSV. User needs this for monthly reports. Priority: High for enterprise workflow.",
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
	console.log("✅ Logged second interaction (feature request)");

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

	// Get customer history
	async function getCustomerHistory(customerEmail: string) {
		const history = await store.search({
			userId: customerEmail,
			query: "customer interactions history",
			limit: 50,
		});

		console.log(`\n📋 Customer History for ${customerEmail}:`);

		const profiles = history.results.filter((h) => h.metadata?.type === "profile");
		const tickets = history.results.filter((h) => h.metadata?.type === "ticket");

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

	// Detect repeat issue
	async function checkRepeatIssue(customerEmail: string, issueCategory: string) {
		const pastIssues = await store.search({
			userId: customerEmail,
			query: `issues related to ${issueCategory}`,
			metadata: {
				type: "ticket",
				category: issueCategory,
			},
			limit: 20,
		});

		const resolvedIssues = pastIssues.results.filter((r) => r.metadata?.status === "resolved");

		if (resolvedIssues.length > 0) {
			console.log("\n⚠️  REPEAT ISSUE DETECTED");
			console.log(`   Customer has had ${resolvedIssues.length} ${issueCategory} issue(s) before`);
			console.log("   Most recent resolution:");
			console.log(`   - ${resolvedIssues[0].content}`);
			return true;
		}

		return false;
	}

	// Simulate repeat login issue
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
	console.log("✅ Logged repeat login issue");

	await checkRepeatIssue("customer-alice@example.com", "login");

	// Cross-platform verification
	const allInteractions = await store.search({
		userId: "customer-alice@example.com",
		query: "all customer communications",
		sources: ["memory"],
		limit: 50,
	});

	console.log("\n🌐 Cross-platform interactions:");
	const platforms = new Set<string>();
	for (const hit of allInteractions.results) {
		platforms.add(hit.platform);
	}
	console.log(`   Platforms: ${Array.from(platforms).join(", ")}`);

	// Batch import existing customer data
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

	async function importCustomerData(
		customers: Array<{
			email: string;
			name: string;
			tier: string;
			tickets: Array<{
				content: string;
				category: string;
				status: string;
				timestamp: number;
			}>;
		}>,
	) {
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

		console.log(`\n✅ Imported ${customers.length} customers with their ticket history`);
	}

	await importCustomerData(existingCustomers);

	// Verify import
	const importedCustomers = await store.search({
		query: "imported customer data",
		metadata: {
			type: "profile",
			imported: true,
		},
		limit: 10,
	});

	console.log(`\n📊 Import verification: ${importedCustomers.count} imported customer profiles`);
}

export default main;
runIfMain("customer-support-agent", main, import.meta.url);
