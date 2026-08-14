/**
 * Secret-pattern redaction. The exact regex set is a curated subset
 * helper: a small set of regexes that flag obvious credential-shaped
 * strings in user-supplied content. The plugin never sends anything
 * matching these patterns to the backend.
 *
 * Conservative on purpose — false positives just mean we skip a capture,
 * which is the safe failure mode.
 */

const SECRET_PATTERNS: readonly RegExp[] = [
	/(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{20,})/, // OpenAI / DeepSeek / Anthropic style
	/(?:^|[^A-Za-z0-9])(?:ghp_[A-Za-z0-9]{20,})/, // GitHub personal access token
	/(?:^|[^A-Za-z0-9])(?:xox[abp]-[A-Za-z0-9-]{10,})/, // Slack
	/(?:^|[^A-Za-z0-9])(?:AKIA[0-9A-Z]{16})/, // AWS access key
	/(?:^|[^A-Za-z0-9])(?:AIza[0-9A-Za-z_-]{35})/, // Google API key
	/(?:\bBEGIN [A-Z ]*PRIVATE KEY\b)/, // PEM private key
	/(?:\bpassword\s*[:=]\s*\S{6,})/i,
	/(?:\bsecret\s*[:=]\s*\S{6,})/i,
	/(?:\btoken\s*[:=]\s*[A-Za-z0-9._-]{16,})/i,
];

export function containsSecret(content: string): boolean {
	if (!content) return false;
	for (const pattern of SECRET_PATTERNS) {
		if (pattern.test(content)) return true;
	}
	return false;
}

/** Mask every long alphanumeric run in `value` with `***`, useful for
 *  trimming tokens out of log lines. */
export function redactSecrets(value: string): string {
	return value
		.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***");
}
