/**
 * demo: @melandlabs/integrations — the host context and text utilities.
 *
 * Integration packages (gmail, slack, jira, …) never reach for a
 * database or an auth session directly. They receive an
 * `IntegrationContext`: six small provider interfaces — credential
 * store, auth, session store, file ingester, config, cloud sync — that
 * the *host application* supplies. That indirection is why the same
 * gmail package works in the desktop app, on the server, and in a test.
 *
 * `createMinimalContext(overrides)` builds one where anything you don't
 * supply falls back to a safe noop: reads return empty, writes discard.
 * You override only the providers your test or script actually needs.
 */

import { createMinimalContext } from "@melandlabs/integrations/core";
import { buildSnippet, htmlToPlainText, stripQuotedText } from "@melandlabs/integrations/utils";
import { info, makeCheck, runSection } from "../_helpers.ts";

export default async function demoIntegrationsCore() {
	await runSection("demo: @melandlabs/integrations (core + utils)", async () => {
		const check = makeCheck("demo/integrations");

		// ── The noop context ──────────────────────────────────────────
		const ctx = createMinimalContext({});
		info("demo/integrations", `context providers: ${Object.keys(ctx).join(", ")}`);
		check(
			"createMinimalContext supplies all six providers",
			["credentialStore", "authProvider", "sessionStore", "fileIngester", "configProvider", "cloudSyncProvider"].every(
				(k) => k in ctx,
			),
			`${Object.keys(ctx).length} providers`,
		);

		// Noop reads answer safely rather than throwing, so an integration
		// can run against an unconfigured host without special-casing.
		const accounts = await ctx.credentialStore.getAccountsByUserId("demo-user");
		const userId = await ctx.authProvider.getUserId();
		const enabled = await ctx.cloudSyncProvider.isEnabled();
		info("demo/integrations", `noop reads: accounts=${JSON.stringify(accounts)}, userId=${userId}, cloudSync=${enabled}`);
		check("noop credentialStore returns no accounts", Array.isArray(accounts) && accounts.length === 0);
		check("noop authProvider reports no signed-in user", userId === null);
		check("noop cloudSyncProvider reports itself disabled", enabled === false);

		// Noop writes are discarded — set() then get() still yields null.
		await ctx.sessionStore.set("demo-key", "demo-value");
		const readBack = await ctx.sessionStore.get("demo-key");
		info("demo/integrations", `noop sessionStore: set() then get() → ${JSON.stringify(readBack)} (writes are discarded)`);
		check("noop sessionStore discards writes instead of pretending to persist", readBack === null);

		// Missing optional config is `undefined`; missing *required* config throws.
		check("configProvider.get returns undefined for an unset key", (await ctx.configProvider.get("NOPE")) === undefined);
		let requiredThrew = false;
		try {
			await ctx.configProvider.getRequired("NOPE");
		} catch (err) {
			requiredThrew = true;
			info("demo/integrations", `getRequired("NOPE") threw: ${(err as Error).message}`);
		}
		check("configProvider.getRequired throws loudly for an unset key", requiredThrew);

		// Override just the one provider you care about.
		const custom = createMinimalContext({
			authProvider: {
				getUserId: async () => "user-42",
				getToken: async () => null,
				getLocalUserType: async () => "pro",
			},
		});
		const customUser = await custom.authProvider.getUserId();
		info("demo/integrations", `overridden authProvider.getUserId() = ${customUser}`);
		check("an override replaces only that provider", customUser === "user-42");
		check(
			"the other five providers still fall back to noops",
			(await custom.credentialStore.getAccountsByUserId("user-42")).length === 0,
		);

		// ── Text utilities ────────────────────────────────────────────
		// Integrations feed messages to an LLM, so they normalise markup
		// and trim quoted reply chains first.
		const plain = htmlToPlainText("<p>Hello <b>world</b></p><p>Second paragraph</p>");
		info("demo/integrations", `htmlToPlainText → ${JSON.stringify(plain)}`);
		check("htmlToPlainText strips tags but keeps the text", plain.includes("Hello") && plain.includes("world"));
		check("htmlToPlainText leaves no angle brackets behind", !plain.includes("<"));

		const snippet = buildSnippet("The quick brown fox jumps over the lazy dog repeatedly", 20);
		info("demo/integrations", `buildSnippet(…, 20) → ${JSON.stringify(snippet)}`);
		check("buildSnippet truncates to roughly the requested length", snippet.length <= 24, `${snippet.length} chars`);
		check("buildSnippet marks the truncation with an ellipsis", snippet.endsWith("..."));
		check(
			"a string shorter than the limit is returned unchanged",
			buildSnippet("short", 100) === "short",
		);

		const withQuote = "My actual reply.\n\nOn Mon, someone wrote:\n> the original message\n> second quoted line";
		const unquoted = stripQuotedText(withQuote);
		info("demo/integrations", `stripQuotedText → ${JSON.stringify(unquoted)}`);
		check("stripQuotedText keeps the new reply", unquoted.includes("My actual reply."));
		check("stripQuotedText drops the quoted chain", !unquoted.includes("the original message"));
	});
}
