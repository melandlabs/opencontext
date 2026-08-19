import { defineConfig } from "tsup";

// @melandlabs/opencontext — single-package facade.
//
// tsup bundles every workspace @melandlabs/* package into one ESM file so the
// published artifact has zero npm-side workspace runtime dependencies.
// Third-party packages (zod, hono, better-sqlite3, …) stay external — they
// ship as normal `dependencies` in the manifest and pnpm resolves them for
// consumers at install time.
//
// `pg` is also external: it's a CommonJS-only package and tsup's bundler
// wraps it in `__commonJS` shims that throw `Dynamic require of "events"
// is not supported` when the bin scripts run under Node. Marking it
// external preserves a real `import { x } from "pg"` so Node's resolver
// handles it.
//
// The `openai@4` runtime shim drags in a chain of CJS-only packages
// (node-fetch@2 → whatwg-url@5 → tr46 → punycode, plus the formdata /
// abort-controller shims). They hit the exact same `__commonJS` problem as
// `pg` — importing the bundle under Node 22 ESM threw
// `Dynamic require of "punycode" is not supported`. Same pattern, same fix:
// externalize them so Node's resolver loads the real CJS packages and
// `require` works normally inside them.

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"cli/opencontext": "src/cli/opencontext.ts",
	},
	format: ["esm"],
	dts: true,
	sourcemap: false,
	clean: true,
	splitting: false,
	treeshake: true,
	target: "esnext",
	noExternal: [/^@melandlabs\/(?!ai-rag(?:\/|$))/],
	external: [
		"pg",
		"punycode",
		"whatwg-url",
		"tr46",
		"webidl-conversions",
		"node-fetch",
		"form-data",
		"form-data-encoder",
		"formdata-node",
		"formdata-polyfill",
		"node-domexception",
		"abort-controller",
		"agentkeepalive",
		"encoding",
		// `cross-spawn` is a transitive dep of the agent providers that
		// `@melandlabs/ai` re-exports through `./agent/index`. It's a CJS
		// package, so bundling it into this ESM-only facade wraps every
		// internal `require('child_process')` call inside tsup's
		// `__commonJS` shim — which then throws `Dynamic require of
		// "child_process" is not supported` the moment anything (the
		// examples runner, `opencontext mcp` over stdio, etc.) loads
		// `@melandlabs/opencontext` under ESM. Keep it external so Node's
		// resolver loads the real CJS package and `require` works normally.
		"cross-spawn",
		// ai-rag ships native deps (@huggingface/transformers ONNX runtime,
		// chromadb). Now bundled as a regular dependency since the facade has
		// static re-exports from it.
		// `fernet` is a CommonJS-only token-encryption library used by
		// `@melandlabs/security`. Bundling it into an ESM facade wraps its
		// `require('crypto')` call in tsup's `__commonJS` shim, which throws
		// `Dynamic require of "crypto" is not supported` at runtime. Keep it
		// external so Node's resolver loads the real CJS package.
		"fernet",
		// `yaml` is a transitive dependency of `@melandlabs/okf` (the OKF
		// v0.2 codec). It references Node's `process` global via a CJS-style
		// internal require, so bundling it into the facade triggers the same
		// `Dynamic require of "process" is not supported` failure as `fernet`.
		// Keep it external for the same reason.
		"yaml",
	],
});
