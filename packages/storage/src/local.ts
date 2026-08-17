import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StorageProvider } from "./provider";

/**
 * Local file system implementation of the StorageProvider interface
 * Stores data as files in a designated directory
 */
export class LocalStorageProvider implements StorageProvider {
	private readonly storagePath: string;

	/**
	 * Initialize local storage provider
	 * @param basePath - Optional custom directory to use as the storage root.
	 *                   Defaults to "data/storage" resolved against the
	 *                   current working directory at construction time (not
	 *                   at module-load time, so re-chdir'd callers get a
	 *                   fresh root).
	 */
	constructor(basePath?: string) {
		this.storagePath = basePath ? path.resolve(basePath) : path.resolve("data", "storage");
		this.ensureStorageDirectory();
	}

	/**
	 * Ensure the storage directory exists (creates it if missing)
	 */
	private async ensureStorageDirectory(): Promise<void> {
		try {
			await fs.access(this.storagePath);
		} catch {
			// Create directory recursively if it doesn't exist
			await fs.mkdir(this.storagePath, { recursive: true });
		}
	}

	/**
	 * Validate and sanitize the key to prevent path traversal attacks
	 * @param key - Unique identifier for the data
	 * @returns Resolved and validated absolute file path
	 * @throws Error if the key attempts to escape the storage directory
	 */
	private resolveSafePath(key: string): string {
		// Strip separators and dot-dot sequences so a key like
		// `../../etc/passwd` becomes a flat filename inside the storage root.
		const sanitizedKey = key.replace(/[/\\]/g, "_").replace(/\.\./g, "_");
		const filePath = path.resolve(this.storagePath, sanitizedKey);

		// Belt-and-braces guard: if a future code path re-introduces separators,
		// `path.relative` detects real traversal (`..` or an absolute path).
		const relative = path.relative(this.storagePath, filePath);
		if (
			relative === "" ||
			relative.startsWith(`..${path.sep}`) ||
			relative === ".." ||
			path.isAbsolute(relative)
		) {
			throw new Error(`Invalid key: path traversal detected for "${key}"`);
		}

		return filePath;
	}

	/**
	 * Save data to a local file
	 * @param key - Unique identifier for the data
	 * @param value - Binary data to store
	 */
	async save(key: string, value: Uint8Array): Promise<void> {
		const filePath = this.resolveSafePath(key);
		await fs.writeFile(filePath, value);
	}

	/**
	 * Load data from a local file
	 * @param key - Unique identifier for the data
	 * @returns Stored binary data
	 */
	async load(key: string): Promise<Uint8Array> {
		const filePath = this.resolveSafePath(key);
		const data = await fs.readFile(filePath);
		return new Uint8Array(data.buffer);
	}

	/**
	 * Check if a file exists for the given key
	 * @param key - Unique identifier to check
	 * @returns True if the file exists, false otherwise
	 */
	async exists(key: string): Promise<boolean> {
		try {
			const filePath = this.resolveSafePath(key);
			await fs.access(filePath);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Delete the file associated with the given key
	 * @param key - Unique identifier for the data to delete
	 */
	async delete(key: string): Promise<void> {
		const filePath = this.resolveSafePath(key);
		await fs.unlink(filePath);
	}

	/**
	 * Initialize storage provider (no-op for local storage)
	 */
	async initialize(): Promise<void> {
		// Ensure directory exists on initialization
		await this.ensureStorageDirectory();
	}
}
