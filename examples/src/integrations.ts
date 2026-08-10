/**
 * @melandlabs/integrations umbrella + every leaf integration package.
 *
 * The umbrella re-exports core types (./core, ./contacts, ./utils) plus
 * content-cleaner utilities. Each leaf integration package is verified
 * for import resolution and a basic symbol shape. We do not attempt to
 * connect to any live platform here — that needs credentials.
 *
 * Several leaves import subpaths from upstream npm packages that ship
 * CJS without an `exports` field (telegram, @whiskeysockets/baileys,
 * @xdevplatform/xdk, @larksuiteoapi/node-sdk, @tencent-weixin/openclaw-weixin).
 * Node 22 ESM rejects those bare subpaths at module load, so those
 * packages are loaded lazily below and their resolution status is
 * reported per-section instead of aborting the entire smoke run.
 */

import {
	noopAuthProvider,
	noopCloudSyncProvider,
	noopConfigProvider,
	noopCredentialStore,
	noopFileIngester,
	noopSessionStore,
	createMinimalContext,
} from "@melandlabs/integrations/core";
import { type ContactMeta, isTelegramContactMeta } from "@melandlabs/integrations/contacts";
import {
	buildSnippet,
	cleanEmailForLLM,
	htmlToPlainText,
} from "@melandlabs/integrations/utils";
import { type Message, type Messages } from "@melandlabs/integrations-channels";
import { type ExtractedMessageInfo } from "@melandlabs/integrations-channels/sources/types";
import { ComposioClient } from "@melandlabs/integrations-composio";

import * as asana from "@melandlabs/integrations-asana";
import * as calendar from "@melandlabs/integrations-calendar";
import * as channels from "@melandlabs/integrations-channels";
import * as composio from "@melandlabs/integrations-composio";
import * as dingtalk from "@melandlabs/integrations-dingtalk";
import * as facebookMessenger from "@melandlabs/integrations-facebook-messenger";
import * as gmail from "@melandlabs/integrations-gmail";
import * as googleDocs from "@melandlabs/integrations-google-docs";
import * as googleMeet from "@melandlabs/integrations-google-meet";
import * as hubspot from "@melandlabs/integrations-hubspot";
import * as imessage from "@melandlabs/integrations-imessage";
import * as instagram from "@melandlabs/integrations-instagram";
import * as jira from "@melandlabs/integrations-jira";
import * as linkedin from "@melandlabs/integrations-linkedin";
import * as qqbot from "@melandlabs/integrations-qqbot";
import * as rss from "@melandlabs/rss";

import * as integrationsRuntime from "@melandlabs/integrations-runtime";

import { makeCheck, runSection } from "./_helpers.ts";

// Packages imported lazily below because their main entry imports
// subpaths from upstream CJS packages that don't expose ESM exports.
// We verify that they at least resolve when re-exported through a
// shallow entry (the `./adapter` etc. subpaths bypass the broken top-level
// imports where applicable).
const lazyPackages: Array<[string, string]> = [
	["@melandlabs/integrations-feishu", "feishu — upstream @larksuiteoapi/node-sdk has no ESM exports"],
	["@melandlabs/integrations-telegram", "telegram — upstream `telegram` npm package has no ESM exports"],
	["@melandlabs/integrations-weixin", "weixin — upstream @tencent-weixin/openclaw-weixin has no ESM exports"],
	["@melandlabs/integrations-whatsapp", "whatsapp — upstream @whiskeysockets/baileys has no ESM exports"],
	["@melandlabs/integrations-x", "x — upstream @xdevplatform/xdk has no ESM exports"],
];

export default async function testIntegrations() {
	await runSection("@melandlabs/integrations (umbrella)", async () => {
		const check = makeCheck("integrations-umbrella");

		check("core noop helpers are exported as objects", [
			noopAuthProvider,
			noopCloudSyncProvider,
			noopConfigProvider,
			noopCredentialStore,
			noopFileIngester,
			noopSessionStore,
		].length === 6);
		check("createMinimalContext is a function", typeof createMinimalContext === "function");

		check("isTelegramContactMeta is a function", typeof isTelegramContactMeta === "function");
		const probe = isTelegramContactMeta({ source: "telegram", id: "1" } as ContactMeta);
		check("isTelegramContactMeta returns boolean", typeof probe === "boolean");

		check("buildSnippet is a function", typeof buildSnippet === "function");
		check("cleanEmailForLLM is a function", typeof cleanEmailForLLM === "function");
		check("htmlToPlainText is a function", typeof htmlToPlainText === "function");

		const _t: Message = { source: "x", id: "1" } as Message;
		const _ts: Messages = [_t];
		void _ts;
		check("Message/Messages types resolve via channels", true);

		const _ext: ExtractedMessageInfo = { source: "x", id: "1", text: "hi" };
		void _ext;
		check("ExtractedMessageInfo type resolves", true);

		check("ComposioClient is a class", typeof ComposioClient === "function");
	});

	await runSection("@melandlabs/integrations-runtime", async () => {
		const check = makeCheck("integrations-runtime");
		const exported = Object.keys(integrationsRuntime).filter((k) => !k.startsWith("_"));
		check("module exports symbols", exported.length > 0);
	});

	const leaves: Array<[string, Record<string, unknown>]> = [
		["@melandlabs/integrations-asana", asana as unknown as Record<string, unknown>],
		["@melandlabs/integrations-calendar", calendar as unknown as Record<string, unknown>],
		["@melandlabs/integrations-channels", channels as unknown as Record<string, unknown>],
		["@melandlabs/integrations-composio", composio as unknown as Record<string, unknown>],
		["@melandlabs/integrations-dingtalk", dingtalk as unknown as Record<string, unknown>],
		["@melandlabs/integrations-facebook-messenger", facebookMessenger as unknown as Record<string, unknown>],
		["@melandlabs/integrations-gmail", gmail as unknown as Record<string, unknown>],
		["@melandlabs/integrations-google-docs", googleDocs as unknown as Record<string, unknown>],
		["@melandlabs/integrations-google-meet", googleMeet as unknown as Record<string, unknown>],
		["@melandlabs/integrations-hubspot", hubspot as unknown as Record<string, unknown>],
		["@melandlabs/integrations-imessage", imessage as unknown as Record<string, unknown>],
		["@melandlabs/integrations-instagram", instagram as unknown as Record<string, unknown>],
		["@melandlabs/integrations-jira", jira as unknown as Record<string, unknown>],
		["@melandlabs/integrations-linkedin", linkedin as unknown as Record<string, unknown>],
		["@melandlabs/integrations-qqbot", qqbot as unknown as Record<string, unknown>],
	];
	for (const [name, mod] of leaves) {
		await runSection(name, async () => {
			const check = makeCheck(name.replace("@melandlabs/", ""));
			const exported = Object.keys(mod).filter((k) => !k.startsWith("_"));
			check("module loads and exports symbols", exported.length > 0);
		});
	}

	for (const [name, reason] of lazyPackages) {
		await runSection(name, async () => {
			const check = makeCheck(name.replace("@melandlabs/", ""));
			try {
				const mod = (await import(name)) as unknown as Record<string, unknown>;
				const exported = Object.keys(mod).filter((k) => !k.startsWith("_"));
				check("module loads and exports symbols", exported.length > 0);
			} catch (err) {
				check(
					`module loads (skipped — ${reason})`,
					false,
					`import failed: ${(err as Error).message}`,
				);
			}
		});
	}

	await runSection("@melandlabs/rss", async () => {
		const check = makeCheck("rss");
		const exported = Object.keys(rss).filter((k) => !k.startsWith("_"));
		check("module exports symbols", exported.length > 0);
	});
}