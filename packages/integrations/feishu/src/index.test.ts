import { Permission } from "@melandlabs/integrations-channels";
import { describe, expect, it } from "vitest";
import { feishuEventToFriend, feishuEventToGroupMember } from "./index";

describe("feishuEventToFriend", () => {
	it("builds a Friend from open_id and name", () => {
		const friend = feishuEventToFriend("ou_123", "Alice");
		expect(friend).toEqual({
			id: "ou_123",
			name: "Alice",
			nickname: "Alice",
		});
	});

	it("falls back to open_id when name is omitted", () => {
		const friend = feishuEventToFriend("ou_456");
		expect(friend.id).toBe("ou_456");
		expect(friend.name).toBe("ou_456");
		expect(friend.nickname).toBeUndefined();
	});

	it("preserves empty string name", () => {
		const friend = feishuEventToFriend("ou_789", "");
		expect(friend.name).toBe("");
		expect(friend.nickname).toBe("");
	});
});

describe("feishuEventToGroupMember", () => {
	it("builds a GroupMember with full context", () => {
		const member = feishuEventToGroupMember("ou_123", "oc_456", "Engineering", "Bob");
		expect(member.id).toBe("ou_123");
		expect(member.memberName).toBe("Bob");
		expect(member.permission).toBe(Permission.Member);
		expect(member.group).toEqual({
			id: "oc_456",
			name: "Engineering",
			permission: Permission.Member,
		});
		expect(member.specialTitle).toBe("");
		expect(member.joinTimestamp).toEqual(new Date(0));
		expect(member.lastSpeakTimestamp).toEqual(new Date(0));
		expect(member.muteTimeRemaining).toBe(0);
	});

	it("falls back ids when names are omitted", () => {
		const member = feishuEventToGroupMember("ou_abc", "oc_xyz");
		expect(member.id).toBe("ou_abc");
		expect(member.memberName).toBe("ou_abc");
		expect(member.group.id).toBe("oc_xyz");
		expect(member.group.name).toBe("oc_xyz");
	});
});
