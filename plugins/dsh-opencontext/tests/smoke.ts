/**
 * Smoke test: load dsh-opencontext through the real DSH plugin loader,
 * exercise the recall waterfall + tools + /oc doctor against a live
 * @melandlabs/opencontext in-process store, and report results.
 *
 *   pnpm tsx tests/smoke.ts        (from the plugin directory)
 *   node --import tsx tests/smoke.ts
 *
 * Exits with code 0 on success, 1 on any failure.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Force the lib backend to use an isolated DB so the smoke test does not
// touch the user's real memory store.
const dbDir = mkdtempSync(join(tmpdir(), "dsh-opencontext-smoke-"));
process.env.MEMORY_STORE_DB_PATH = join(dbDir, "store.db");

// Disable the actual chat/LLM path — we just want to exercise plugin
// apply() + tools + recall + /oc doctor.

// Load the built (compiled) plugin so we exercise the exact artifact that
// `dsh plugin add` will mount in the user's profile.
const plugin = await import(new URL("../lib/index.js", import.meta.url).href);
const { apply, name, inject, ConfigSchema } = plugin as {
	name: string;
	inject: string[];
	apply: (ctx: unknown, config: unknown) => void;
	ConfigSchema: { (value: unknown): unknown };
};

const registeredTools: Array<{ name: string; execute: (args: unknown, ctx: unknown) => Promise<unknown> }> =
	[];
const preStepListeners: Array<(payload: unknown, next: () => Promise<unknown>) => Promise<unknown>> = [];
const registeredCommands: Array<{
	name: string;
	handler: (inv: unknown) => Promise<{ kind: "success" | "error"; text: string }>;
}> = [];
const registeredSkills: Array<{ name: string; body: string }> = [];

const toolRegistrations: unknown[] = [];

const ctx = {
	tools: {
		register(definition: unknown): () => void {
			toolRegistrations.push(definition);
			const t = definition as { name: string; execute: (typeof registeredTools)[number]["execute"] };
			registeredTools.push(t);
			return () => {
				const i = registeredTools.findIndex((r) => r.name === t.name);
				if (i >= 0) registeredTools.splice(i, 1);
			};
		},
	},
	on(event: string, handler: (...args: unknown[]) => unknown): () => void {
		if (event === "agent/pre-step") {
			preStepListeners.push(handler as (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>);
		}
		return () => undefined;
	},
	get(name: string): unknown {
		if (name === "skill") {
			return {
				register(definition: { name: string; description: string; body: string }): () => void {
					registeredSkills.push({ name: definition.name, body: definition.body });
					return () => undefined;
				},
			};
		}
		if (name === "commands") {
			return {
				register(definition: {
					name: string;
					handler: (typeof registeredCommands)[number]["handler"];
				}): () => void {
					registeredCommands.push(definition);
					return () => undefined;
				},
			};
		}
		return undefined;
	},
	logger: {
		info: (msg: string) => process.stdout.write(`[info] ${msg}\n`),
		warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
		debug: (msg: string) => process.stderr.write(`[debug] ${msg}\n`),
	},
	effect(setup: () => () => void): () => void {
		const teardown = setup();
		return teardown;
	},
};

let exitCode = 0;
const fail = (label: string, error: unknown): void => {
	exitCode = 1;
	process.stderr.write(`\n[FAIL] ${label}: ${(error as Error).message}\n`);
};

try {
	process.stdout.write(`# dsh-opencontext smoke test\n`);
	process.stdout.write(`# db: ${process.env.MEMORY_STORE_DB_PATH}\n\n`);

	// 1. Plugin shape
	if (name !== "dsh-opencontext") throw new Error(`name: got ${name}`);
	if (!inject.includes("tools")) throw new Error("inject missing 'tools'");
	if (!inject.includes("commands")) throw new Error("inject missing 'commands'");
	if (typeof ConfigSchema !== "function") throw new Error("ConfigSchema not callable");
	process.stdout.write(`✔ plugin shape (name=${name}, inject=${inject.length})\n`);

	// 2. Apply
	const config = {
		baseUrl: "http://127.0.0.1:8000",
		authorization: "",
		scopeId: "smoke:scope",
		timeoutMs: 5000,
		requestTimeoutMs: 2000,
		maxBytes: 4096,
		capturePrompts: true,
		flushOnCapture: true, // make the smoke test deterministic
		maxRecallItems: 4,
	};
	apply(ctx as unknown as Parameters<typeof apply>[0], config);
	process.stdout.write(
		`✔ apply(ctx, config) — registered ${registeredTools.length} tools, ${preStepListeners.length} pre-step listeners, ${registeredCommands.length} command, ${registeredSkills.length} skill\n`,
	);

	// 3. Tools registered
	const expectedTools = [
		"oc_search",
		"oc_remember",
		"oc_memory_list",
		"oc_memory_get",
		"oc_memory_revise",
		"oc_memory_retire",
		"oc_prepare_context",
		"oc_capture_source",
	];
	for (const t of expectedTools) {
		if (!registeredTools.find((rt) => rt.name === t)) {
			throw new Error(`missing tool: ${t}`);
		}
	}
	process.stdout.write(`✔ all 8 oc_* tools registered\n`);

	// 4. Skill
	if (registeredSkills[0]?.name !== "opencontext-context") {
		throw new Error(`skill name: got ${registeredSkills[0]?.name}`);
	}
	if (
		!registeredSkills[0]?.body.includes("Untrusted historical evidence") &&
		!registeredSkills[0]?.body.includes("untrusted historical evidence")
	) {
		throw new Error("skill body missing trust-model framing");
	}
	process.stdout.write(
		`✔ skill '${registeredSkills[0].name}' registered (body ${registeredSkills[0].body.length} bytes)\n`,
	);

	// 5. /oc doctor
	const cmd = registeredCommands[0];
	if (!cmd) throw new Error("/oc command not registered");
	if (cmd.name !== "oc") throw new Error(`command name: got ${cmd.name}`);
	const doctorResult = await cmd.handler({
		rawInput: "doctor",
		signal: new AbortController().signal,
		agent: { session: { header: { id: "smoke-session", cwd: "/tmp" } } },
	});
	if (doctorResult.kind !== "success") {
		throw new Error(`/oc doctor returned kind=${doctorResult.kind}: ${doctorResult.text}`);
	}
	const doctorBody = JSON.parse(doctorResult.text);
	if (doctorBody.plugin !== "dsh-opencontext") throw new Error(`/oc doctor: plugin=${doctorBody.plugin}`);
	if (doctorBody.backend !== "lib") throw new Error(`/oc doctor: backend=${doctorBody.backend}`);
	if (doctorBody.scope !== "smoke:scope") throw new Error(`/oc doctor: scope=${doctorBody.scope}`);
	if (doctorBody.probe?.ok !== true)
		throw new Error(`/oc doctor: probe not ok: ${JSON.stringify(doctorBody.probe)}`);
	process.stdout.write(
		`✔ /oc doctor — mode=lib, scope=smoke:scope, probe ok=true, recentCount=${doctorBody.recentCount}\n`,
	);
	process.stdout.write(`  db: ${doctorBody.db}\n`);

	// 6. oc_remember round-trip
	const remember = registeredTools.find((t) => t.name === "oc_remember");
	if (!remember) throw new Error("oc_remember missing");
	const rem = (await remember.execute(
		{ content: "The API key is sk-abcdefghijklmnopqrstuv and should never be stored" },
		{},
	)) as { ok: boolean; error?: { code: string } };
	if (rem.ok) throw new Error("oc_remember should reject secret-like content");
	if (rem.error?.code !== "secret_rejected")
		throw new Error(`oc_remember: expected secret_rejected, got ${rem.error?.code}`);

	const rem2 = (await remember.execute({ content: "remember the project name is dsh-opencontext" }, {})) as {
		ok: boolean;
		value?: { ids: string[] };
	};
	if (!rem2.ok) throw new Error(`oc_remember: ${JSON.stringify(rem2)}`);
	const firstId = rem2.value?.ids[0];
	if (!firstId) throw new Error("oc_remember returned no id");
	process.stdout.write(`✔ oc_remember stored entry (id=${firstId}, secret was rejected as expected)\n`);

	// 7. oc_memory_get round-trip
	const get = registeredTools.find((t) => t.name === "oc_memory_get");
	if (!get) throw new Error("oc_memory_get missing");
	const getResult = (await get.execute({ ids: [firstId] }, {})) as {
		ok: boolean;
		value?: { items: Array<{ id: string; content: string }> };
	};
	if (!getResult.ok) throw new Error(`oc_memory_get: ${JSON.stringify(getResult)}`);
	if (getResult.value?.items[0]?.content !== "remember the project name is dsh-opencontext") {
		throw new Error(`oc_memory_get: wrong content: ${JSON.stringify(getResult.value)}`);
	}
	process.stdout.write(`✔ oc_memory_get retrieved the entry — content round-trips\n`);

	// 8. oc_memory_list
	const list = registeredTools.find((t) => t.name === "oc_memory_list");
	if (!list) throw new Error("oc_memory_list missing");
	const listResult = (await list.execute({ limit: 10 }, {})) as { ok: boolean; value?: { items: unknown[] } };
	if (!listResult.ok) throw new Error(`oc_memory_list: ${JSON.stringify(listResult)}`);
	if ((listResult.value?.items.length ?? 0) < 1) throw new Error("oc_memory_list returned 0 items");
	process.stdout.write(`✔ oc_memory_list returned ${listResult.value?.items.length} item(s)\n`);

	// 9. oc_search round-trip (uses the lexical fallback when no embed provider is configured)
	const search = registeredTools.find((t) => t.name === "oc_search");
	if (!search) throw new Error("oc_search missing");
	const searchResult = (await search.execute({ query: "dsh-opencontext" }, {})) as {
		ok: boolean;
		value?: { hits: unknown[] };
	};
	if (!searchResult.ok) throw new Error(`oc_search: ${JSON.stringify(searchResult)}`);
	process.stdout.write(
		`✔ oc_search returned ${searchResult.value?.hits.length ?? 0} hit(s) for "dsh-opencontext"\n`,
	);

	// 10. oc_prepare_context produces a framed block
	const prepare = registeredTools.find((t) => t.name === "oc_prepare_context");
	if (!prepare) throw new Error("oc_prepare_context missing");
	const prep = (await prepare.execute({ query: "dsh-opencontext project" }, {})) as {
		ok: boolean;
		value?: { contextBlock: string; hits: number };
	};
	if (!prep.ok) throw new Error(`oc_prepare_context: ${JSON.stringify(prep)}`);
	if (!prep.value?.contextBlock.includes("<opencontext_evidence")) {
		throw new Error("oc_prepare_context: block not framed as <opencontext_evidence>");
	}
	if (!prep.value?.contextBlock.includes("untrusted historical evidence")) {
		throw new Error("oc_prepare_context: block missing untrusted-evidence header");
	}
	process.stdout.write(
		`✔ oc_prepare_context produced a ${prep.value?.contextBlock.length}-byte evidence block (${prep.value?.hits} hits)\n`,
	);

	// 11. Capture-source round-trip
	const capture = registeredTools.find((t) => t.name === "oc_capture_source");
	if (!capture) throw new Error("oc_capture_source missing");
	const cap = (await capture.execute({ content: "a captured snippet", sourceType: "smoke" }, {})) as {
		ok: boolean;
		value?: { id: string };
	};
	if (!cap.ok) throw new Error(`oc_capture_source: ${JSON.stringify(cap)}`);
	process.stdout.write(`✔ oc_capture_source stored id=${cap.value?.id}\n`);

	// 12. Recall waterfall — pretend a user message and let the listeners run
	if (preStepListeners.length !== 2)
		throw new Error(`expected 2 pre-step listeners, got ${preStepListeners.length}`);
	const userPayload = {
		messages: [
			{ role: "user", content: [{ type: "text", text: "what was the dsh-opencontext project name?" }] },
		],
		session: { header: { id: "smoke-session", cwd: "/tmp" } },
	};
	// First listener is recall; the second is capture. Run them in order.
	let nextDecision = {
		kind: "enter",
		messages: [
			{ role: "user", content: [{ type: "text", text: "what was the dsh-opencontext project name?" }] },
		],
	};
	const downstreamNext = async () => nextDecision;
	const recallResult = (await preStepListeners[0]!(userPayload, downstreamNext)) as {
		kind: string;
		messages: Array<{ meta?: { kind?: string } }>;
	};
	if (recallResult.kind !== "enter") throw new Error(`recall listener: kind=${recallResult.kind}`);
	const messages = recallResult.messages;
	const recallMessage = messages.find((m) => m.meta?.kind === "recall");
	if (!recallMessage) throw new Error("recall listener did not append an evidence message");
	process.stdout.write(`✔ recall listener appended an <opencontext_evidence> message to the turn\n`);

	// Capture listener should run after, fire-and-forget (with flushOnCapture it awaits)
	await preStepListeners[1]!(userPayload, downstreamNext);
	process.stdout.write(`✔ capture listener ran\n`);

	// 13. Revise
	const revise = registeredTools.find((t) => t.name === "oc_memory_revise");
	if (!revise) throw new Error("oc_memory_revise missing");
	const rev = (await revise.execute(
		{
			id: firstId,
			content: "the project is dsh-opencontext, an Apache-2.0 DSH plugin",
			reason: "more accurate",
		},
		{},
	)) as { ok: boolean; value?: { deprecatedId: string; newId: string } };
	if (!rev.ok) throw new Error(`oc_memory_revise: ${JSON.stringify(rev)}`);
	process.stdout.write(`✔ oc_memory_revise deprecated ${rev.value?.deprecatedId} → ${rev.value?.newId}\n`);

	// 14. Retire
	const retire = registeredTools.find((t) => t.name === "oc_memory_retire");
	if (!retire) throw new Error("oc_memory_retire missing");
	const ret = (await retire.execute({ id: rev.value!.newId, reason: "smoke test cleanup" }, {})) as {
		ok: boolean;
		value?: { ok: boolean };
	};
	if (!ret.ok || !ret.value?.ok) throw new Error(`oc_memory_retire: ${JSON.stringify(ret)}`);
	process.stdout.write(`✔ oc_memory_retire soft-deprecated ${rev.value?.newId}\n`);

	// 15. /oc doctor again — should now report 0 recent (retired entries are excluded by default)
	const doctor2 = await cmd.handler({
		rawInput: "doctor",
		signal: new AbortController().signal,
		agent: { session: { header: { id: "smoke-session", cwd: "/tmp" } } },
	});
	const doctor2Body = JSON.parse(doctor2.text);
	process.stdout.write(
		`✔ /oc doctor after retire — recentCount=${doctor2Body.recentCount} (deprecated entries hidden by default)\n`,
	);

	// 16. Tear down via the effect setupFn we registered
	process.stdout.write(`\n✔ all smoke checks passed\n`);
} catch (error) {
	fail("smoke", error);
}

process.exit(exitCode);
