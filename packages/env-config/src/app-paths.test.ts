import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	OPENCONTEXT_HOME_ENV,
	ensureOpenContextDir,
	getOpenContextDir,
	getOpenContextPath,
} from "./app-paths";

let tempHome: string;

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "app-paths-test-"));
	vi.stubEnv("HOME", tempHome);
	vi.stubEnv(OPENCONTEXT_HOME_ENV, "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(tempHome, { recursive: true, force: true });
});

describe("getOpenContextDir", () => {
	it("defaults to ~/.opencontext when OPENCONTEXT_HOME is unset", () => {
		expect(getOpenContextDir()).toBe(join(tempHome, ".opencontext"));
	});

	it("honours OPENCONTEXT_HOME when set", () => {
		vi.stubEnv(OPENCONTEXT_HOME_ENV, "/custom/oc");
		expect(getOpenContextDir()).toBe("/custom/oc");
	});

	it("expands a bare ~ in OPENCONTEXT_HOME", () => {
		vi.stubEnv(OPENCONTEXT_HOME_ENV, "~");
		expect(getOpenContextDir()).toBe(tempHome);
	});

	it("expands a ~/ prefix in OPENCONTEXT_HOME", () => {
		vi.stubEnv(OPENCONTEXT_HOME_ENV, "~/myoc");
		expect(getOpenContextDir()).toBe(join(tempHome, "myoc"));
	});

	it("treats a whitespace-only OPENCONTEXT_HOME as unset", () => {
		vi.stubEnv(OPENCONTEXT_HOME_ENV, "   ");
		expect(getOpenContextDir()).toBe(join(tempHome, ".opencontext"));
	});
});

describe("getOpenContextPath", () => {
	it("joins segments under the root dir", () => {
		expect(getOpenContextPath("memory", "store.db")).toBe(
			join(tempHome, ".opencontext", "memory", "store.db"),
		);
	});

	it("returns the root dir when called with no segments", () => {
		expect(getOpenContextPath()).toBe(getOpenContextDir());
	});
});

describe("ensureOpenContextDir", () => {
	it("creates the root dir and returns its path", () => {
		const dir = ensureOpenContextDir();
		expect(dir).toBe(getOpenContextDir());
		expect(existsSync(dir)).toBe(true);
	});

	it("mkdir -p nested segments and returns the path", () => {
		const dir = ensureOpenContextDir("logs", "audit");
		expect(dir).toBe(join(tempHome, ".opencontext", "logs", "audit"));
		expect(existsSync(dir)).toBe(true);
	});
});
