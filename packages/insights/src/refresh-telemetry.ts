/**
 * Timing telemetry utilities for email fetch operations.
 *
 * Provides formatting and filtering helpers for timing events
 * emitted during IMAP email fetch operations.
 */

export interface TimingEvent {
  phase: string;
  status: "start" | "success" | "failure" | "skip";
  durationMs?: number;
  details?: Record<string, unknown>;
  error?: unknown;
}

export interface ShouldLogTimingEventOptions {
  phase: string;
  status: "start" | "success" | "failure" | "skip";
  isSummaryPhase?: (phase: string) => boolean;
}

/**
 * Format an error for inclusion in telemetry logs.
 * Returns a safe, serializable representation of the error.
 */
export function formatTimingError(error: unknown): string {
  if (!error) return "unknown";

  if (error instanceof Error) {
    // Truncate long error messages to prevent log bloat
    const message =
      error.message.length > 200
        ? `${error.message.slice(0, 197)}...`
        : error.message;
    return `${error.name}: ${message}`;
  }

  if (typeof error === "string") {
    return error.length > 200 ? `${error.slice(0, 197)}...` : error;
  }

  try {
    const serialized = JSON.stringify(error);
    return serialized.length > 200
      ? `${serialized.slice(0, 197)}...`
      : serialized;
  } catch {
    return "unknown";
  }
}

/**
 * Determine whether a timing event should be logged based on its properties.
 *
 * Summary phases (like "imap_fetch_emails") are logged at all statuses,
 * while other phases are only logged for non-start events.
 */
export function shouldLogTimingEvent(
  options: ShouldLogTimingEventOptions,
): boolean {
  const { phase, status, isSummaryPhase } = options;

  // Never log start events except for summary phases
  if (status === "start") {
    if (isSummaryPhase?.(phase)) {
      return true;
    }
    return false;
  }

  // Always log non-start events for summary phases
  if (isSummaryPhase?.(phase)) {
    return true;
  }

  // For non-summary phases, only log failure and skip events
  return status === "failure" || status === "skip";
}
