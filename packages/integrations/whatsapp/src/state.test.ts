/**
 * WhatsApp State Utilities - Contract Tests
 *
 * 20 test cases covering 4 pure functions.
 * No Baileys Socket mock, no side effects.
 */

import { describe, it, expect } from "vitest";
import {
  parseQrCodeState,
  isOwnMessage,
  routeMessageType,
  resolveBaileysConnectionState,
  type ExtractedMessageInfo,
} from "./state";

// ---------------------------------------------------------------------------
// F1: parseQrCodeState Tests
// ---------------------------------------------------------------------------

describe("parseQrCodeState", () => {
  // Valid QR codes (index 0-3)
  it("AC-WA1-F1: parses valid QR with index 0", () => {
    const result = parseQrCodeState("data1,data2,data3,0");
    expect(result.isValid).toBe(true);
    expect(result.codeIndex).toBe(0);
  });

  it("AC-WA1-F1: parses valid QR with index 3", () => {
    const result = parseQrCodeState("data1,data2,data3,3");
    expect(result.isValid).toBe(true);
    expect(result.codeIndex).toBe(3);
  });

  it("AC-WA1-F1: parses QR with index in middle of range", () => {
    const result = parseQrCodeState("data1,data2,data3,2");
    expect(result.isValid).toBe(true);
    expect(result.codeIndex).toBe(2);
  });

  // Invalid QR codes (index out of range)
  it("AC-WA1-F1: marks QR invalid when index is 4", () => {
    const result = parseQrCodeState("data1,data2,data3,4");
    expect(result.isValid).toBe(false);
    expect(result.codeIndex).toBe(4);
  });

  it("AC-WA1-F1: marks QR invalid when index is 5", () => {
    const result = parseQrCodeState("data1,data2,data3,5");
    expect(result.isValid).toBe(false);
    expect(result.codeIndex).toBe(5);
  });

  it("AC-WA1-F1: marks QR invalid when index is negative", () => {
    const result = parseQrCodeState("data1,data2,data3,-1");
    expect(result.isValid).toBe(false);
    expect(result.codeIndex).toBe(-1);
  });

  // Edge cases
  it("AC-WA1-F1: marks QR invalid when less than 4 parts", () => {
    const result = parseQrCodeState("only,three,parts");
    expect(result.isValid).toBe(false);
    expect(result.codeIndex).toBe(-1);
  });

  it("AC-WA1-F1: marks QR invalid for empty string", () => {
    const result = parseQrCodeState("");
    expect(result.isValid).toBe(false);
    expect(result.codeIndex).toBe(-1);
  });

  it("AC-WA1-F1: marks QR invalid for non-numeric index", () => {
    const result = parseQrCodeState("data1,data2,data3,abc");
    expect(result.isValid).toBe(false);
    expect(result.codeIndex).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// F2: isOwnMessage Tests
// ---------------------------------------------------------------------------

describe("isOwnMessage", () => {
  const createMessage = (
    overrides: Partial<ExtractedMessageInfo> = {},
  ): ExtractedMessageInfo => ({
    id: "msg-1",
    chatType: "private",
    chatName: "Test",
    sender: "alice",
    text: "hello",
    timestamp: Date.now(),
    isOutgoing: false,
    ...overrides,
  });

  it("AC-WA1-F2: returns true when sender matches selfJid", () => {
    const msg = createMessage({ sender: "alice", isOutgoing: false });
    expect(isOwnMessage(msg, "alice")).toBe(true);
  });

  it("AC-WA1-F2: returns true when isOutgoing is explicitly true", () => {
    const msg = createMessage({ sender: "bob", isOutgoing: true });
    expect(isOwnMessage(msg, "alice")).toBe(true);
  });

  it("AC-WA1-F2: returns false when sender differs from selfJid", () => {
    const msg = createMessage({ sender: "bob", isOutgoing: false });
    expect(isOwnMessage(msg, "alice")).toBe(false);
  });

  it("AC-WA1-F2: returns false when selfJid is undefined", () => {
    const msg = createMessage({ sender: "alice" });
    expect(isOwnMessage(msg, undefined)).toBe(false);
  });

  it("AC-WA1-F2: returns false when message is null", () => {
    expect(isOwnMessage(null, "alice")).toBe(false);
  });

  it("AC-WA1-F2: returns false when message is undefined", () => {
    expect(isOwnMessage(undefined, "alice")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F3: routeMessageType Tests
// ---------------------------------------------------------------------------

describe("routeMessageType", () => {
  it("AC-WA1-F3: routes conversation message to text", () => {
    const msg = { message: { conversation: "hello" } };
    expect(routeMessageType(msg)).toBe("text");
  });

  it("AC-WA1-F3: routes extendedTextMessage with text to text", () => {
    const msg = { message: { extendedTextMessage: { text: "hello" } } };
    expect(routeMessageType(msg)).toBe("text");
  });

  it("AC-WA1-F3: routes imageMessage to image", () => {
    const msg = { message: { imageMessage: { url: "http://..." } } };
    expect(routeMessageType(msg)).toBe("image");
  });

  it("AC-WA1-F3: routes videoMessage to video", () => {
    const msg = { message: { videoMessage: { url: "http://..." } } };
    expect(routeMessageType(msg)).toBe("video");
  });

  it("AC-WA1-F3: routes audioMessage to audio", () => {
    const msg = { message: { audioMessage: {} } };
    expect(routeMessageType(msg)).toBe("audio");
  });

  it("AC-WA1-F3: routes documentMessage to document", () => {
    const msg = { message: { documentMessage: { fileName: "doc.pdf" } } };
    expect(routeMessageType(msg)).toBe("document");
  });

  it("AC-WA1-F3: routes stickerMessage to sticker", () => {
    const msg = { message: { stickerMessage: {} } };
    expect(routeMessageType(msg)).toBe("sticker");
  });

  it("AC-WA1-F3: routes unknown message type to other", () => {
    const msg = { message: { unsupportedMessage: {} } };
    expect(routeMessageType(msg)).toBe("other");
  });

  it("AC-WA1-F3: routes null to other", () => {
    expect(routeMessageType(null)).toBe("other");
  });

  it("AC-WA1-F3: routes undefined to other", () => {
    expect(routeMessageType(undefined)).toBe("other");
  });

  it("AC-WA1-F3: routes empty object to other", () => {
    expect(routeMessageType({})).toBe("other");
  });

  it("AC-WA1-F3: routes message without message property to other", () => {
    expect(routeMessageType({ key: "value" })).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// F4: resolveBaileysConnectionState Tests
// ---------------------------------------------------------------------------

describe("resolveBaileysConnectionState", () => {
  it("AC-WA1-F4: maps 'open' to 'connected'", () => {
    expect(resolveBaileysConnectionState("open")).toBe("connected");
  });

  it("AC-WA1-F4: maps 'connecting' to 'connecting'", () => {
    expect(resolveBaileysConnectionState("connecting")).toBe("connecting");
  });

  it("AC-WA1-F4: maps 'close' to 'disconnected'", () => {
    expect(resolveBaileysConnectionState("close")).toBe("disconnected");
  });

  it("AC-WA1-F4: maps null to 'disconnected'", () => {
    expect(resolveBaileysConnectionState(null)).toBe("disconnected");
  });

  it("AC-WA1-F4: maps undefined to 'disconnected'", () => {
    expect(resolveBaileysConnectionState(undefined)).toBe("disconnected");
  });
});
