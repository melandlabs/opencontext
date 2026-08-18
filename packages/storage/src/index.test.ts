import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	deleteFromLocalFs,
	listLocalFiles,
	localFileExists,
	readLocalFile,
	uploadToLocalFs,
} from "./adapters/local-fs";
import { LocalStorageProvider } from "./local";
import { MemoryStorageProvider } from "./memory";

describe("MemoryStorageProvider", () => {
	let provider: MemoryStorageProvider;

	beforeEach(() => {
		provider = new MemoryStorageProvider();
	});

	it("initializes without error", async () => {
		await expect(provider.initialize()).resolves.toBeUndefined();
	});

	it("saves, loads, and checks existence", async () => {
		const value = new TextEncoder().encode("hello memory");
		await provider.save("key1", value);

		expect(await provider.exists("key1")).toBe(true);
		const loaded = await provider.load("key1");
		expect(new TextDecoder().decode(loaded)).toBe("hello memory");
	});

	it("returns false for missing keys", async () => {
		expect(await provider.exists("missing")).toBe(false);
	});

	it("throws when loading a missing key", async () => {
		await expect(provider.load("missing")).rejects.toThrow("Key not found: missing");
	});

	it("deletes saved keys", async () => {
		await provider.save("key2", new TextEncoder().encode("value2"));
		expect(await provider.exists("key2")).toBe(true);

		await provider.delete("key2");
		expect(await provider.exists("key2")).toBe(false);
	});

	it("clears all entries and reports size", async () => {
		await provider.save("a", new Uint8Array([1]));
		await provider.save("b", new Uint8Array([2]));
		expect(provider.size).toBe(2);

		await provider.clear();
		expect(provider.size).toBe(0);
		expect(await provider.exists("a")).toBe(false);
	});
});

describe("LocalStorageProvider", () => {
	let tempDir: string;
	let provider: LocalStorageProvider;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-storage-local-"));
		provider = new LocalStorageProvider(tempDir);
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("initializes without error", async () => {
		await expect(provider.initialize()).resolves.toBeUndefined();
	});

	it("saves, loads, and checks existence", async () => {
		const value = new TextEncoder().encode("hello local");
		await provider.save("key1", value);

		expect(await provider.exists("key1")).toBe(true);
		const loaded = await provider.load("key1");
		expect(new TextDecoder().decode(loaded)).toBe("hello local");
	});

	it("returns false for missing keys", async () => {
		expect(await provider.exists("missing")).toBe(false);
	});

	it("deletes saved keys", async () => {
		await provider.save("key2", new TextEncoder().encode("value2"));
		expect(await provider.exists("key2")).toBe(true);

		await provider.delete("key2");
		expect(await provider.exists("key2")).toBe(false);
	});

	it("sanitizes path separators in keys", async () => {
		await provider.save("path/to/key", new TextEncoder().encode("sanitized"));
		expect(await provider.exists("path/to/key")).toBe(true);
		const loaded = await provider.load("path/to/key");
		expect(new TextDecoder().decode(loaded)).toBe("sanitized");

		// A single file named "path_to_key" should have been created
		const files = await fs.readdir(tempDir);
		expect(files).toContain("path_to_key");
	});

	it("sanitizes dot-dot sequences in keys into flat filenames", async () => {
		await provider.save("../escaped", new TextEncoder().encode("x"));
		expect(await provider.exists("../escaped")).toBe(true);

		await provider.save("..\\escaped", new TextEncoder().encode("y"));
		expect(await provider.exists("..\\escaped")).toBe(true);

		const files = await fs.readdir(tempDir);
		expect(files).toContain("__escaped");
	});
});

describe("local-fs adapter", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-storage-localfs-"));
	});

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("uploads a buffer and returns a local download URL", async () => {
		const data = Buffer.from("hello local fs");
		const result = await uploadToLocalFs("docs/file.txt", data, "text/plain", tempDir);

		expect(result.pathname).toBe("docs/file.txt");
		expect(result.url).toBe("/api/files/download?path=docs%2Ffile.txt");
		expect(result.downloadUrl).toBe(result.url);

		const written = await fs.readFile(path.join(tempDir, "docs/file.txt"), "utf8");
		expect(written).toBe("hello local fs");
	});

	it("uploads an ArrayBuffer", async () => {
		const data = new TextEncoder().encode("array buffer content").buffer;
		const result = await uploadToLocalFs("files/ab.bin", data, "application/octet-stream", tempDir);

		expect(result.pathname).toBe("files/ab.bin");
		const written = await fs.readFile(path.join(tempDir, "files/ab.bin"), "utf8");
		expect(written).toBe("array buffer content");
	});

	it("deletes an uploaded file", async () => {
		await uploadToLocalFs("to-delete.txt", Buffer.from("bye"), "text/plain", tempDir);
		expect(
			await fs
				.access(path.join(tempDir, "to-delete.txt"))
				.then(() => true)
				.catch(() => false),
		).toBe(true);

		await deleteFromLocalFs("to-delete.txt", tempDir);
		expect(
			await fs
				.access(path.join(tempDir, "to-delete.txt"))
				.then(() => true)
				.catch(() => false),
		).toBe(false);
	});

	it("deleteFromLocalFs is a no-op when the file does not exist", async () => {
		await expect(deleteFromLocalFs("missing.txt", tempDir)).resolves.toBeUndefined();
	});

	it("lists files recursively with metadata", async () => {
		await uploadToLocalFs("a.txt", Buffer.from("a"), "text/plain", tempDir);
		await uploadToLocalFs("sub/b.txt", Buffer.from("bb"), "text/plain", tempDir);

		const files = await listLocalFiles(tempDir);
		const pathnames = files.map((f) => f.pathname).sort();
		expect(pathnames).toEqual(["a.txt", "sub/b.txt"]);

		const aFile = files.find((f) => f.pathname === "a.txt");
		expect(aFile?.size).toBe(1);
		expect(aFile?.url).toBe("/api/files/download?path=a.txt");
		expect(aFile?.uploadedAt).toBeInstanceOf(Date);
	});

	it("listLocalFiles returns an empty array for a missing prefix", async () => {
		await expect(listLocalFiles(tempDir, "nonexistent")).resolves.toEqual([]);
	});

	it("reads a local file as a Buffer", async () => {
		await uploadToLocalFs("readable.txt", Buffer.from("read me"), "text/plain", tempDir);

		const buffer = await readLocalFile("readable.txt", tempDir);
		expect(Buffer.isBuffer(buffer)).toBe(true);
		expect(buffer.toString("utf8")).toBe("read me");
	});

	it("throws when reading a missing file", async () => {
		await expect(readLocalFile("missing.txt", tempDir)).rejects.toThrow("File not found: missing.txt");
	});

	it("checks file existence", async () => {
		await uploadToLocalFs("exists.txt", Buffer.from("yes"), "text/plain", tempDir);
		expect(localFileExists("exists.txt", tempDir)).toBe(true);
		expect(localFileExists("nope.txt", tempDir)).toBe(false);
	});
});

describe.skip("Vercel Blob adapter", () => {
	it("requires a mocked or real BLOB_READ_WRITE_TOKEN to run", () => {
		expect(process.env.BLOB_READ_WRITE_TOKEN).toBeDefined();
	});
});
