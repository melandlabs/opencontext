import { isTrustedStorageUrl, validateUrlForSSRF } from "@melandlabs/opencontext";

async function main() {
	// validateUrlForSSRF rejects plain HTTP, loopback and private IPs by default.
	// Pass { strictWhitelist: false } to skip the known-storage-provider whitelist.
	try {
		const safe = await validateUrlForSSRF("https://api.example.com/data", {
			strictWhitelist: false,
		});
		console.log("Safe URL:", safe.toString());
	} catch (error) {
		console.error("Unsafe URL:", error);
	}

	// Check if a storage URL is trusted
	const trusted = isTrustedStorageUrl("https://s3.amazonaws.com/my-bucket/file.txt");
	console.log("Trusted storage URL:", trusted);
}

main().catch((error) => {
	console.error("URL validation failed:", error);
	process.exit(1);
});
