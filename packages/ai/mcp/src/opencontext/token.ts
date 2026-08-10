import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type OpenContextAuthTokenSource = "env" | "file" | "missing";

export interface OpenContextAuthToken {
	token: string | null;
	source: OpenContextAuthTokenSource;
	path?: string;
	error?: string;
}

export function getOpenContextTokenPath(): string {
	return (
		process.env.OPENCONTEXT_TOKEN_PATH ??
		path.join(os.homedir(), ".opencontext", "token")
	);
}

function looksLikeJwt(token: string): boolean {
	return token.split(".").length >= 2;
}

export function decodeStoredOpenContextToken(rawToken: string): string {
	const trimmed = rawToken.trim();
	if (!trimmed || looksLikeJwt(trimmed)) {
		return trimmed;
	}

	try {
		const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
		return decoded || trimmed;
	} catch {
		return trimmed;
	}
}

export async function readOpenContextAuthToken(): Promise<OpenContextAuthToken> {
	const envToken = process.env.OPENCONTEXT_AUTH_TOKEN?.trim();
	if (envToken) {
		return {
			token: decodeStoredOpenContextToken(envToken),
			source: "env",
		};
	}

	const tokenPath = getOpenContextTokenPath();
	try {
		const fileToken = await fs.readFile(tokenPath, "utf8");
		const token = decodeStoredOpenContextToken(fileToken);
		return {
			token: token || null,
			source: token ? "file" : "missing",
			path: tokenPath,
		};
	} catch (error) {
		return {
			token: null,
			source: "missing",
			path: tokenPath,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
