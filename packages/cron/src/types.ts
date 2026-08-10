/**
 * Cron Job Types and Interfaces
 *
 * The `ScheduledJob` import is a *type-only* structural pull. We point it at
 * a tiny local interface so this package never needs to import the giant
 * `apps/web/lib/db/schema.ts` Drizzle table bundle. Apps that want a fully-
 * typed bridge to the Drizzle row can pass their own `ScheduledJob`-shaped
 * record into helpers in this package.
 */

export interface ScheduledJobLike {
  id: string;
  userId: string;
  name: string;
  description?: string | null;
  handler: string;
  schedule: unknown;
  jobConfig?: unknown;
  status: "active" | "paused" | "disabled";
  timezone?: string | null;
  nextRunAt?: Date | null;
  lastRunAt?: Date | null;
  lastResult?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Source of a job's timezone value.
 * - "explicit": Job has its own timezone override (not inherited from user preference).
 * - "user_preference": Job follows the user's timezone preference and will be re-aligned when the preference changes.
 */
export type JobTimezoneSource = "explicit" | "user_preference";

/**
 * Schedule configuration types
 */
export type ScheduleConfig =
  | { type: "cron"; expression: string; timezone?: string }
  | { type: "interval-hours"; hours: number }
  | { type: "interval-minutes"; minutes: number }
  | { type: "interval"; hours?: number; minutes?: number } // Legacy support
  | { type: "once"; at: Date | string };

/**
 * Job configuration types
 */
export type JobConfig = {
  type: "custom";
  handler: string;
  modelConfig?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
  /** Back-link to character that owns this job */
  characterId?: string;
};

/**
 * Job execution context
 */
export interface JobExecutionContext {
  userId: string;
  jobId: string;
  executionId: string;
  triggeredBy: "scheduler" | "manual" | "api";
  modelConfig?: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
  /** Back-link to character that owns this job */
  characterId?: string;
  /** User's timezone for date/time operations */
  timezone?: string;
  /**
   * Parsed jobConfig JSON for the executing job. Custom handlers
   * (e.g. `loop.action`) read this to recover action-specific
   * payloads the schedule API stuffed into the row. Optional —
   * non-custom-job callers may leave it undefined.
   */
  jobConfig?: Record<string, unknown>;
}

/**
 * Job execution result
 */
export interface JobExecutionResult {
  status: "success" | "error" | "timeout";
  output?: string;
  error?: string;
  result?: Record<string, unknown>;
  duration: number;
}

/**
 * Streamed events emitted by manual job executions for interactive chat UI.
 */
export type JobAgentStreamEvent =
  | {
      type: "execution_start";
      chatId: string;
      executionId: string;
      message: string;
      userMessageId: string;
      assistantMessageId: string;
    }
  | { type: "text"; content: string; messageId?: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      messageId?: string;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      output: unknown;
      isError?: boolean;
      messageId?: string;
    }
  | { type: "error"; content: string }
  | {
      type: "execution_done";
      executionId: string;
      status: "success" | "error" | "timeout";
    };

export interface ExecuteJobOptions {
  userMessageId?: string;
  assistantMessageId?: string;
  onAgentEvent?: (event: JobAgentStreamEvent) => void | Promise<void>;
  abortController?: AbortController;
}

/**
 * Cron job with computed fields. Uses the structural ScheduledJobLike to
 * keep this package free of Drizzle schema dependencies.
 */
export interface CronJob extends ScheduledJobLike {
  computedNextRun?: Date;
}

/**
 * Scheduler events
 */
export type SchedulerEvent =
  | { type: "job.started"; jobId: string; executionId: string }
  | {
      type: "job.completed";
      jobId: string;
      executionId: string;
      result: JobExecutionResult;
    }
  | { type: "job.failed"; jobId: string; executionId: string; error: string }
  | { type: "scheduler.started" }
  | { type: "scheduler.stopped" };

/**
 * Scheduler configuration
 */
export interface SchedulerConfig {
  enabled: boolean;
  maxConcurrentJobs?: number;
  jobTimeoutMs?: number;
  onError?: (error: Error, context: JobExecutionContext) => void;
  onEvent?: (event: SchedulerEvent) => void;
}
