import type {
  AgentGoal,
  AgentGoalLifecycleTransition,
  AgentGoalReplacement,
  DeliveryState,
  GoalCompletionPolicy,
  GoalEvaluationResult,
  GoalEvidence,
  GoalEvidenceType,
  GoalRunStatus,
  GoalStatus,
  PersistedAgentGoal,
  RuntimeInstruction,
  RuntimeInstructionDeliveryMode,
  RuntimeInstructionKind,
  RuntimeInstructionSource,
  RuntimeProvider,
  RuntimeSessionState,
} from "@openloomi/ai/agent/runtime-instructions";

export type AgentGoalSourceType = AgentGoal["source"]["type"];
export type AgentGoalSnapshot = AgentGoal;
export type AgentGoalEvaluationSnapshot = GoalEvaluationResult;
export type AgentRuntimeInstructionSnapshot = RuntimeInstruction;
export type AgentRuntimeInstructionPayload = RuntimeInstruction["payload"];
export type AgentGoalEvidencePayload = GoalEvidence["payload"];

export type AgentRuntimePendingOperation =
  | AgentGoalLifecycleTransition
  | AgentGoalReplacement;

/**
 * Historical command results are kept independently from the mutable Goal row
 * so an idempotent retry can return the exact revision originally committed.
 */
export type AgentGoalCommandCheckpoint =
  | {
      type: "goal_instruction";
      goal: PersistedAgentGoal;
      instruction: RuntimeInstruction;
    }
  | {
      type: "lifecycle";
      transition: AgentGoalLifecycleTransition;
    }
  | {
      type: "replacement";
      replacement: AgentGoalReplacement;
    };

export type AgentGoalSlot = "primary";
export type AgentGoalSlotState = "assigned" | "reserved" | "released";
export type AgentGoalCommandType =
  | "goal_instruction"
  | "lifecycle"
  | "replacement";
export type AgentGoalCommandPhase =
  | "committed"
  | "prepared"
  | "boundary_observed"
  | "finalized"
  | "activated";

export type {
  DeliveryState,
  GoalCompletionPolicy,
  GoalEvidenceType,
  GoalRunStatus,
  GoalStatus,
  RuntimeInstructionDeliveryMode,
  RuntimeInstructionKind,
  RuntimeInstructionSource,
  RuntimeProvider,
  RuntimeSessionState,
};
