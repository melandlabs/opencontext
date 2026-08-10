import { describe, expect, it } from "vitest";

import { UserLocale } from "./user-locale";

describe("UserLocale.fromString", () => {
  it("accepts zh aliases", () => {
    for (const raw of ["zh", "zh-CN", "zh-Hans", "ZH", "zh-Hant"]) {
      const locale = UserLocale.fromString(raw);
      expect(locale?.code).toBe("zh-Hans");
    }
  });

  it("accepts en aliases", () => {
    for (const raw of ["en", "en-US", "EN", "en-GB"]) {
      const locale = UserLocale.fromString(raw);
      expect(locale?.code).toBe("en-US");
    }
  });

  it("returns null for empty or unknown values", () => {
    for (const raw of [null, undefined, "", "  ", "fr", "ja-JP"]) {
      expect(UserLocale.fromString(raw)).toBeNull();
    }
  });
});

describe("UserLocale.isChineseCode / isEnglishCode", () => {
  it("isChineseCode mirrors fromString", () => {
    expect(UserLocale.isChineseCode("zh-CN")).toBe(true);
    expect(UserLocale.isChineseCode("zh-Hant")).toBe(true);
    expect(UserLocale.isChineseCode("en")).toBe(false);
    expect(UserLocale.isChineseCode(null)).toBe(false);
    expect(UserLocale.isChineseCode("")).toBe(false);
  });

  it("isEnglishCode mirrors fromString", () => {
    expect(UserLocale.isEnglishCode("en-GB")).toBe(true);
    expect(UserLocale.isEnglishCode("zh")).toBe(false);
    expect(UserLocale.isEnglishCode(null)).toBe(false);
    expect(UserLocale.isEnglishCode("ja")).toBe(false);
  });
});

describe("UserLocale behavior", () => {
  it("default is English", () => {
    expect(UserLocale.default().code).toBe("en-US");
    expect(UserLocale.default().isEnglish()).toBe(true);
  });

  it("promptLabel is stable English", () => {
    expect(UserLocale.fromString("zh-Hans")?.promptLabel()).toBe(
      "Simplified Chinese",
    );
    expect(UserLocale.fromString("en")?.promptLabel()).toBe("English");
  });

  it("equals compares by code", () => {
    const a = UserLocale.fromString("zh-Hans");
    const b = UserLocale.fromString("zh-CN");
    const c = UserLocale.default();
    expect(a?.equals(b)).toBe(true);
    expect(a?.equals(c)).toBe(false);
    expect(a?.equals(null)).toBe(false);
  });
});
