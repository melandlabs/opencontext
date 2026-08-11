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
	sourcemap: true,
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
		// ai-rag ships native deps (@huggingface/transformers ONNX runtime,
		// chromadb). Keep it external in the facade bundle so the published
		// artifact stays lean; `opencontext http` only needs it when the
		// user opts into `--embedding-provider local` or `--*-backend=chroma`,
		// in which case it's an optional peer dep they install themselves.
		"@melandlabs/ai-rag",
		"@melandlabs/ai-rag/local-transformers-embedding-provider",
		"@melandlabs/ai-rag/chroma-store",
	],
});
