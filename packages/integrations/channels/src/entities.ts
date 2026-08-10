import { z } from "zod";

/**
 * Base entity interface representing a user or group.
 */
export interface Entity {
  /** Unique identifier. */
  id: number | string;
}

/**
 * Represents a private chat contact (friend).
 */
export const PrivateChatSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().optional(),
  nickname: z.string().optional(),
  remark: z.string().optional(),
});

export type PrivateChat = z.infer<typeof PrivateChatSchema>;

export type Friend = PrivateChat;

/**
 * Group member permission levels.
 */
export enum Permission {
  Member = "MEMBER",
  Administrator = "ADMINISTRATOR",
  Owner = "OWNER",
}

/**
 * Represents a group chat.
 */
export const GroupSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  permission: z.enum(Permission),
});

export type Group = z.infer<typeof GroupSchema>;

/**
 * Represents a member within a group.
 */
export const GroupMemberSchema = z.object({
  id: z.union([z.number(), z.string()]),
  memberName: z.string(),
  permission: z.enum(Permission),
  group: GroupSchema,
  specialTitle: z.string().default(""),
  joinTimestamp: z.date().default(new Date(0)),
  lastSpeakTimestamp: z.date().default(new Date(0)),
  muteTimeRemaining: z.number().default(0),
});

export type GroupMember = z.infer<typeof GroupMemberSchema>;
