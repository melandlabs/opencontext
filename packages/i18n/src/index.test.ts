import { describe, expect, it } from "vitest";
import { enUS, zhHans } from "./index";

describe("i18n locale exports", () => {
	it("exports enUS as a plain object", () => {
		expect(enUS).toBeDefined();
		expect(typeof enUS).toBe("object");
		expect(enUS).not.toBeNull();
		expect(Array.isArray(enUS)).toBe(false);
	});

	it("exports zhHans as a plain object", () => {
		expect(zhHans).toBeDefined();
		expect(typeof zhHans).toBe("object");
		expect(zhHans).not.toBeNull();
		expect(Array.isArray(zhHans)).toBe(false);
	});

	it("has a common namespace in both locales", () => {
		expect(enUS.common).toBeDefined();
		expect(typeof enUS.common).toBe("object");
		expect(zhHans.common).toBeDefined();
		expect(typeof zhHans.common).toBe("object");
	});

	it("has common.login as a non-empty string in both locales", () => {
		expect(typeof enUS.common.login).toBe("string");
		expect(enUS.common.login.length).toBeGreaterThan(0);
		expect(typeof zhHans.common.login).toBe("string");
		expect(zhHans.common.login.length).toBeGreaterThan(0);
	});

	it("has common.chat as a non-empty string in both locales", () => {
		expect(typeof enUS.common.chat).toBe("string");
		expect(enUS.common.chat.length).toBeGreaterThan(0);
		expect(typeof zhHans.common.chat).toBe("string");
		expect(zhHans.common.chat.length).toBeGreaterThan(0);
	});

	it("has common.save as a non-empty string in both locales", () => {
		expect(typeof enUS.common.save).toBe("string");
		expect(enUS.common.save.length).toBeGreaterThan(0);
		expect(typeof zhHans.common.save).toBe("string");
		expect(zhHans.common.save.length).toBeGreaterThan(0);
	});

	it("has platform names as non-empty strings in both locales", () => {
		expect(typeof enUS.platform.telegram).toBe("string");
		expect(enUS.platform.telegram.length).toBeGreaterThan(0);
		expect(typeof zhHans.platform.telegram).toBe("string");
		expect(zhHans.platform.telegram.length).toBeGreaterThan(0);

		expect(typeof enUS.platform.gmail).toBe("string");
		expect(enUS.platform.gmail.length).toBeGreaterThan(0);
		expect(typeof zhHans.platform.gmail).toBe("string");
		expect(zhHans.platform.gmail.length).toBeGreaterThan(0);
	});

	it("sets the correct locale identifier", () => {
		expect(enUS.common.locale).toBe("en");
		expect(zhHans.common.locale).toBe("zh");
	});

	it("shares the core top-level namespaces", () => {
		const enKeys = Object.keys(enUS);
		const zhKeys = Object.keys(zhHans);
		for (const key of ["common", "platform"]) {
			expect(enKeys).toContain(key);
			expect(zhKeys).toContain(key);
		}
	});

	it("has platform namespace in both locales", () => {
		expect(enUS.platform).toBeDefined();
		expect(typeof enUS.platform).toBe("object");
		expect(zhHans.platform).toBeDefined();
		expect(typeof zhHans.platform).toBe("object");
	});
});
