import type { MemorySummaryTier, MemoryTier } from "./contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MemoryForgettingPolicy {
  shortMaxAgeMs: number;
  midMaxAgeMs: number;
  scoreThresholds: {
    shortToMid: number;
    midToLong: number;
  };
  groupWindowMs: {
    short: number;
    mid: number;
  };
  minRecordsPerGroup: number;
  maxCandidatesPerTierPerRun: {
    short: number;
    mid: number;
  };
  lock: {
    keyPrefix: string;
    ttlMs: number;
  };
  groupByDimensionKeys: string[];
}

export interface MemoryForgettingPolicyOverrides {
  shortMaxAgeMs?: number;
  midMaxAgeMs?: number;
  scoreThresholds?: Partial<MemoryForgettingPolicy["scoreThresholds"]>;
  groupWindowMs?: Partial<MemoryForgettingPolicy["groupWindowMs"]>;
  minRecordsPerGroup?: number;
  maxCandidatesPerTierPerRun?: Partial<
    MemoryForgettingPolicy["maxCandidatesPerTierPerRun"]
  >;
  lock?: Partial<MemoryForgettingPolicy["lock"]>;
  groupByDimensionKeys?: string[];
}

export const DEFAULT_MEMORY_FORGETTING_POLICY: MemoryForgettingPolicy = {
  shortMaxAgeMs: 7 * DAY_MS,
  midMaxAgeMs: 365 * 10 * DAY_MS, // 10 years, effectively unlimited
  scoreThresholds: {
    shortToMid: 0.65,
    midToLong: 0.45,
  },
  groupWindowMs: {
    short: 1 * DAY_MS,
    mid: 7 * DAY_MS,
  },
  minRecordsPerGroup: 3,
  maxCandidatesPerTierPerRun: {
    short: 500,
    mid: 500,
  },
  lock: {
    keyPrefix: "memory_forgetting",
    ttlMs: 60_000,
  },
  groupByDimensionKeys: ["platform", "channel", "person", "botId"],
};

export function resolveMemoryForgettingPolicy(
  overrides?: MemoryForgettingPolicyOverrides,
): MemoryForgettingPolicy {
  if (!overrides) {
    return DEFAULT_MEMORY_FORGETTING_POLICY;
  }
  return {
    shortMaxAgeMs:
      overrides.shortMaxAgeMs ?? DEFAULT_MEMORY_FORGETTING_POLICY.shortMaxAgeMs,
    midMaxAgeMs:
      overrides.midMaxAgeMs ?? DEFAULT_MEMORY_FORGETTING_POLICY.midMaxAgeMs,
    scoreThresholds: {
      shortToMid:
        overrides.scoreThresholds?.shortToMid ??
        DEFAULT_MEMORY_FORGETTING_POLICY.scoreThresholds.shortToMid,
      midToLong:
        overrides.scoreThresholds?.midToLong ??
        DEFAULT_MEMORY_FORGETTING_POLICY.scoreThresholds.midToLong,
    },
    groupWindowMs: {
      short:
        overrides.groupWindowMs?.short ??
        DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.short,
      mid:
        overrides.groupWindowMs?.mid ??
        DEFAULT_MEMORY_FORGETTING_POLICY.groupWindowMs.mid,
    },
    minRecordsPerGroup:
      overrides.minRecordsPerGroup ??
      DEFAULT_MEMORY_FORGETTING_POLICY.minRecordsPerGroup,
    maxCandidatesPerTierPerRun: {
      short:
        overrides.maxCandidatesPerTierPerRun?.short ??
        DEFAULT_MEMORY_FORGETTING_POLICY.maxCandidatesPerTierPerRun.short,
      mid:
        overrides.maxCandidatesPerTierPerRun?.mid ??
        DEFAULT_MEMORY_FORGETTING_POLICY.maxCandidatesPerTierPerRun.mid,
    },
    lock: {
      keyPrefix:
        overrides.lock?.keyPrefix ??
        DEFAULT_MEMORY_FORGETTING_POLICY.lock.keyPrefix,
      ttlMs:
        overrides.lock?.ttlMs ?? DEFAULT_MEMORY_FORGETTING_POLICY.lock.ttlMs,
    },
    groupByDimensionKeys:
      overrides.groupByDimensionKeys ??
      DEFAULT_MEMORY_FORGETTING_POLICY.groupByDimensionKeys,
  };
}

export function summaryTierForTransition(
  fromTier: MemoryTier,
): MemorySummaryTier {
  if (fromTier === "short") {
    return "L1";
  }
  if (fromTier === "mid") {
    return "L2";
  }
  return "L3";
}

export function transitionTargetTier(fromTier: MemoryTier): MemoryTier {
  if (fromTier === "short") {
    return "mid";
  }
  return "long";
}

export function bucketStart(timestamp: number, windowMs: number): number {
  return Math.floor(timestamp / windowMs) * windowMs;
}
