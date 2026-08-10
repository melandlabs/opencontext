// ==============================================
// Message Definitions
// ==============================================

/**
 * Represents an array of message components.
 */
export type Messages = Message[];

/**
 * Union type for all supported message components.
 */
export type Message =
  | Unknown
  | PlainText
  | Source
  | Quote
  | At
  | AtAll
  | Image
  | Voice
  | Forward
  | File
  | Emoji;

// ==============================================
// Specific Message Components
// ==============================================

/**
 * Represents an unknown message component type.
 * @property {string} text - The raw text content of the unknown message.
 */
export type Unknown = {
  text: string;
};

/**
 * Represents metadata about the message source.
 * @property {number|string} id - Unique identifier for the message.
 * @property {Date} time - Timestamp when the message was sent.
 */
export type Source = {
  id: number | string;
  time: Date;
};

/**
 * Represents plain text content.
 */
export type PlainText = string;

/**
 * Represents a quoted message.
 * @property {number} [id] - Optional identifier for the quoted message.
 * @property {number|string} [groupId] - Optional group ID where the quoted message was sent.
 * @property {number|string} [senderId] - Optional sender ID of the quoted message.
 * @property {number|string} [targetId] - Optional target ID of the quoted message.
 * @property {Messages} origin - The original content of the quoted message.
 */
export type Quote = {
  id?: number;
  groupId?: number | string;
  senderId?: number | string;
  targetId?: number | string;
  origin: Messages;
};

/**
 * Represents an @ mention of a user.
 * @property {number|string} target - The ID of the user being mentioned.
 * @property {string} [display] - Optional display name for the mention.
 */
export type At = {
  target: number | string;
  display?: string;
};

/**
 * Represents an @all mention to notify all group members.
 */
export type AtAll = {};

/**
 * Represents an image message.
 * @property {string} [id] - Optional unique identifier for the image.
 * @property {string} url - URL where the image can be accessed.
 * @property {string} [path] - Optional local file path to the image.
 * @property {string} [base64] - Optional base64-encoded representation of the image.
 */
export type Image = {
  id?: string;
  size?: number;
  url: string;
  path?: string;
  base64?: string;
  contentType?: string;
};

/**
 * Represents a voice message.
 * @property {string} [id] - Optional unique identifier for the voice message.
 * @property {string} url - URL where the voice message can be accessed.
 * @property {string} [path] - Optional local file path to the voice message.
 * @property {string} [base64] - Optional base64-encoded representation of the voice message.
 * @property {string} [length] - Optional duration of the voice message.
 */
export type Voice = {
  id?: string;
  url: string;
  path?: string;
  base64?: string;
  length?: string;
};

/**
 * Represents a node in a forwarded message chain.
 * @property {string|number|undefined} senderId - ID of the sender of this message node.
 * @property {string} [senderName] - Optional name of the sender.
 * @property {Messages} [messages] - Optional messages included in this node.
 * @property {string} [messageId] - Optional unique identifier for this message node.
 * @property {Date} time - Timestamp when this message node was sent.
 */
export type ForwardMessageNode = {
  senderId: string | number | undefined;
  senderName?: string;
  messages?: Messages;
  messageId?: string;
  time: Date;
};

/**
 * Represents the display information for a forwarded message.
 * @property {string} title - Title of the forwarded message.
 * @property {string} brief - Brief summary of the forwarded message.
 * @property {string} source - Source information of the forwarded message.
 * @property {string[]} preview - Preview content for the forwarded message.
 * @property {string} summary - Summary of the forwarded message.
 */
export type ForwardMessageDisplay = {
  title: string;
  brief: string;
  source: string;
  preview: string[];
  summary: string;
};

/**
 * Represents a forwarded message.
 * @property {ForwardMessageDisplay} display - Display information for the forwarded message.
 * @property {ForwardMessageNode[]} nodes - Nodes containing the forwarded message content.
 */
export type Forward = {
  display: ForwardMessageDisplay;
  nodes: ForwardMessageNode[];
};

/**
 * Represents a file attachment.
 * @property {string} id - Unique identifier for the file.
 * @property {string} name - Name of the file.
 * @property {number} size - Size of the file in bytes.
 * @property {string} url - URL where the file can be downloaded.
 */
export type File = {
  id: string;
  name: string;
  size: number;
  url: string;
};

/**
 * Represents an emoji.
 * @property {string} type - Type of the emoji.
 * @property {number} id - Unique identifier for the emoji.
 * @property {string} name - Name of the emoji.
 */
export type Emoji = {
  type: string;
  id: number;
  name: string;
};
