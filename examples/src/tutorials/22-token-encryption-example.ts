import { TokenEncryption } from "@melandlabs/opencontext";

async function main() {
	// TokenEncryption reads ENCRYPTION_KEY from the environment.
	// The key should be 32 bytes, or a password from which a 32-byte key is derived.
	if (!process.env.ENCRYPTION_KEY) {
		console.log("Skipping: set ENCRYPTION_KEY to run this example.");
		return;
	}

	const encryptor = new TokenEncryption();
	const original = "sk-1234567890abcdef";

	// encryptToken / decryptToken are synchronous
	const encrypted = encryptor.encryptToken(original);
	console.log("Encrypted:", encrypted);

	const decrypted = encryptor.decryptToken(encrypted);
	console.log("Decrypted:", decrypted);
	console.log("Round-trip OK:", decrypted === original);
}

main().catch((error) => {
	console.error("Token encryption failed:", error);
	process.exit(1);
});
