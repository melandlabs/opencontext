/**
 * Map `ConversationMessage.imagePaths` to AI SDK `ImagePart` entries so the
 * standalone provider can carry multimodal single-turn calls (e.g. screenshot
 * analysis) without forking the agent locally.
 *
 * Pulled out of `standalone.ts` so the file-reading + MIME-detection rules can
 * be unit tested in isolation. The helper is laser-focused:
 *
 * 1. `readImageParts(paths)` — read each file with `node:fs/promises.readFile`,
 *    sniff a supported MIME type from the extension, and emit one
 *    `{ type: "image", image: <base64>, mediaType }` part per path. Throws when
 *    any path is missing, points at a directory, or uses an unsupported
 *    extension.
 * 2. `buildConversationMessages(conversation, prompt)` — turn the caller-
 *    supplied `ConversationMessage[]` plus the trailing user `prompt` into the
 *    AI SDK `ModelMessage[]` shape. User messages with `imagePaths` become
 *    multimodal `UserContent` arrays (`text` part + `image` parts); everything
 *    else keeps the legacy `{ role, content: string }` shape that downstream
 *    providers already accept.
 *
 * The helper is intentionally not re-exported from `packages/ai/src/agent/index.ts`
 * or the package root — it follows the `_internal/` convention (only source
 * siblings import it directly via `../_internal/standalone-images`).
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";

import type { ModelMessage } from "ai";

import type { ConversationMessage } from "../../types";

/**
 * Map a file extension to its IANA media type. Returns `undefined` for any
 * extension we don't recognise — the caller is expected to throw a descriptive
 * error so the run surfaces as an `upstream_error` `AgentMessage` instead of
 * silently sending the model a mislabelled blob.
 */
function mediaTypeForExtension(ext: string): string | undefined {
	const normalized = ext.toLowerCase();
	switch (normalized) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return undefined;
	}
}

/**
 * Read each path from disk, base64-encode the bytes, and return an array of
 * AI SDK `ImagePart` entries (`{ type: "image", image: <base64>, mediaType }`).
 *
 * Throws when:
 *
 * - any path is empty / whitespace-only (treated as a malformed input),
 * - any path is missing on disk or otherwise unreadable,
 * - any path's extension isn't in the supported image set (`.png`, `.jpg`,
 *   `.jpeg`, `.gif`, `.webp`).
 *
 * Reads are issued in parallel via `Promise.all` — the typical call has 1-4
 * attachments, so the parallelism saves a round-trip without complicating the
 * error semantics (the first rejection short-circuits via `Promise.all`).
 */
export async function readImageParts(
	paths: string[],
): Promise<Array<{ type: "image"; image: string; mediaType: string }>> {
	return Promise.all(
		paths.map(async (rawPath) => {
			const path = rawPath.trim();
			if (!path) {
				throw new Error("StandaloneAgent: imagePaths contains an empty entry. Drop it before calling run().");
			}
			const mediaType = mediaTypeForExtension(extname(path));
			if (!mediaType) {
				throw new Error(
					`StandaloneAgent: unsupported image extension for ${path}. Supported: png, jpg, jpeg, gif, webp.`,
				);
			}
			let bytes: Uint8Array;
			try {
				bytes = await readFile(path);
			} catch (cause) {
				const reason = cause instanceof Error ? cause.message : String(cause);
				throw new Error(`StandaloneAgent: failed to read image ${path}: ${reason}`);
			}
			return {
				type: "image" as const,
				image: Buffer.from(bytes).toString("base64"),
				mediaType,
			};
		}),
	);
}

/**
 * Build the AI SDK `ModelMessage[]` payload from a caller-supplied
 * `conversation` plus the trailing user `prompt`. User messages with one or
 * more `imagePaths` are emitted as multimodal `UserContent` arrays so the
 * downstream provider can render the attachments for vision-capable models.
 *
 * Non-user roles (assistant / system) and user messages without `imagePaths`
 * keep the legacy `{ role, content: string }` shape — the AI SDK accepts that
 * for every role and it lets the rest of the agent code stay string-typed.
 */
export async function buildConversationMessages(
	conversation: readonly ConversationMessage[] | undefined,
	prompt: string,
): Promise<ModelMessage[]> {
	const messages: ModelMessage[] = [];
	for (const message of conversation ?? []) {
		const imagePaths = message.imagePaths?.filter((path) => path.trim().length > 0);
		if (message.role === "user" && imagePaths && imagePaths.length > 0) {
			const imageParts = await readImageParts(imagePaths);
			messages.push({
				role: "user",
				content: [{ type: "text" as const, text: message.content }, ...imageParts],
			});
			continue;
		}
		messages.push({ role: message.role, content: message.content });
	}
	messages.push({ role: "user", content: prompt });
	return messages;
}
