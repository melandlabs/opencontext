import type { Messages } from "./message";
import type { MessageEvent, MessageTarget, MessageHandler } from "./events";
import {
  createPlatformAdapterError,
  toPlatformAdapterError,
  type PlatformAdapterError,
  type PlatformAgentErrorCode,
} from "./errors";

/**
 * Base class for message platform adapters
 */
export abstract class MessagePlatformAdapter {
  public name: string;
  public botAccountId: number;
  protected listeners: Map<MessageTarget, MessageHandler<any>> = new Map();

  /**
   * Initialize the adapter
   */
  constructor() {
    this.name = "";
    this.botAccountId = 0; // To be set during initialization
  }

  async sendMessage(
    target: MessageTarget,
    id: string,
    message: string,
  ): Promise<void> {
    await this.sendMessages(target, id, [message]);
  }

  /**
   * Send a message proactively
   * @param target - Target type: 'private' or 'group'
   * @param id - Target ID
   * @param message - Message chain to send
   */
  async sendMessages(
    target: MessageTarget,
    id: string,
    messages: Messages,
  ): Promise<void> {
    throw new Error("Method not implemented");
  }

  /**
   * Reply to a message
   * @param event - Source message event
   * @param messages - Message chain to send as reply
   * @param quoteOrigin - Whether to quote the original message (default: false)
   */
  async replyMessages(
    event: MessageEvent,
    messages: Messages,
    quoteOrigin = false,
  ): Promise<void> {
    throw new Error("Method not implemented");
  }

  protected async runWithAdapterError<T>(
    operation: string,
    action: () => Promise<T>,
    opts?: {
      fallbackCode?: PlatformAgentErrorCode;
      fallbackMessage?: string;
      request_id?: string;
    },
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw this.toAdapterError(operation, error, opts);
    }
  }

  protected toAdapterError(
    operation: string,
    error: unknown,
    opts?: {
      fallbackCode?: PlatformAgentErrorCode;
      fallbackMessage?: string;
      request_id?: string;
    },
  ): PlatformAdapterError {
    return toPlatformAdapterError(
      this.getAdapterName(),
      operation,
      error,
      opts,
    );
  }

  protected createAdapterError(
    operation: string,
    code: PlatformAgentErrorCode,
    message: string,
    opts?: { request_id?: string; cause?: unknown },
  ): PlatformAdapterError {
    return createPlatformAdapterError(
      this.getAdapterName(),
      operation,
      code,
      message,
      opts,
    );
  }

  private getAdapterName(): string {
    return (
      this.name ||
      this.constructor.name.replace(/Adapter$/, "") ||
      "message-platform"
    );
  }

  /**
   * Register an event listener
   * @param target - Type of event to listen for
   * @param callback - Callback function to handle the event
   */
  registerListener<T extends MessageTarget>(
    target: T,
    handler: MessageHandler<T>,
  ): this {
    this.listeners.set(target, handler);
    return this;
  }

  /**
   * Unregister an event listener
   * @param target - Type of event to unregister
   */
  unregisterListener(target: MessageTarget): this {
    this.listeners.delete(target);
    return this;
  }
}
