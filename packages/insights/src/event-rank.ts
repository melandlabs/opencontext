/**
 * EventRank sorting algorithm
 * Inspired by PageRank, used to calculate "impact" scores for events
 *
 * Core formula:
 * ER(Ei) = (1-d)×Si + d×Σ(ER(Ej) / Out(Ej)) × Wj→i
 *
 * Where:
 * - ER(Ei): EventRank score for event Ei
 * - d: Damping factor (default 0.8)
 * - Si: Inherent base score for event Ei
 * - In(Ei): Set of events pointing to Ei
 * - Out(Ej): Number of downstream events from Ej
 * - Wj→i: Correlation weight from Ej to Ei (0-1)
 */

import type { InsightBase } from "./types";

export interface EventRankScore {
  insightId: string;
  score: number;
  breakdown: {
    baseScore: number; // Inherent base score
    eventRank: number; // EventRank contribution
    total: number;
  };
}

export interface EventEdge {
  fromId: string;
  toId: string;
  weight: number; // 0-1
}

/**
 * Get the timestamp of an insight
 * @param insight - Insight object
 * @returns Date object
 */
export function getInsightTime(insight: InsightBase): Date {
  if (insight.details && insight.details.length > 0) {
    const time = insight.details[insight.details.length - 1].time;
    if (time) {
      return new Date(time);
    }
  }
  return new Date(insight.time);
}

/**
 * Check if the platform is an email channel
 * @param platform - Platform name
 * @returns true if it is an email channel
 */
export function isEmailChannel(platform?: string | null): boolean {
  if (!platform) return false;
  const p = platform.toLowerCase();
  return p === "email" || p === "gmail" || p === "outlook";
}

/**
 * Get channel weight multiplier
 * Email channels have lower weight and need decay
 * @param platform - Platform name
 * @returns Weight multiplier (0-1)
 */
export function getChannelWeightMultiplier(platform?: string | null): number {
  if (isEmailChannel(platform)) {
    return 0.6; // Email channel weight decays by 40%
  }
  return 1.0;
}

/**
 * Calculate the inherent base score (Si) for an Insight
 * Based on Layer 1: Time dimension + Spatial dimension
 *
 * @param insight - The insight to calculate
 * @param options - Optional configuration
 * @param options.customMultiplier - Custom weight multiplier (default 1.0)
 * @param options.lastViewedAt - Last viewed time (for time decay)
 * @param options.applyChannelDecay - Whether to apply channel weight decay (default true)
 */
export function calculateBaseScore(
  insight: InsightBase,
  options?: {
    customMultiplier?: number;
    lastViewedAt?: Date;
    applyChannelDecay?: boolean;
  },
): number {
  let score = 0;

  // ========== 0. Channel weight decay ==========
  // Email channels have lower weight and need decay
  const applyDecay = options?.applyChannelDecay ?? true;
  let channelMultiplier = 1.0;
  if (applyDecay) {
    channelMultiplier = getChannelWeightMultiplier(insight.platform);
  }

  // ========== 1. Overdue risk score ==========
  const now = new Date();
  const insightTime = new Date(insight.time);
  const daysSince =
    (now.getTime() - insightTime.getTime()) / (1000 * 60 * 60 * 24);

  if (insight.dueDate) {
    const dueDate = new Date(insight.dueDate);
    const daysUntilDue =
      (dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

    // Already overdue
    if (daysUntilDue < 0) {
      const overdueDays = Math.abs(daysUntilDue);
      if (overdueDays > 7) {
        score += 9; // Severely overdue
      } else if (overdueDays > 3) {
        score += 7; // Overdue for a while
      } else {
        score += 5; // Just became overdue
      }
    }
    // Due within 24 hours
    else if (daysUntilDue <= 1) {
      score += 6;
    }
    // Due within 3 days
    else if (daysUntilDue <= 3) {
      score += 4;
    }
    // Due within 7 days
    else if (daysUntilDue <= 7) {
      score += 2;
    }
  } else {
    // If no dueDate, judge by creation time
    if (daysSince > 7) {
      score += 2; // Old task, might be procrastination
    } else if (daysSince <= 1) {
      score += 1; // New task
    }
  }

  // ========== 2. Relevance score ==========
  // waitingForMe: Waiting for me to handle (high priority)
  if (insight.waitingForMe && insight.waitingForMe.length > 0) {
    score += 3 + Math.min(insight.waitingForMe.length, 5); // Maximum +5
  }

  // myTasks: My tasks
  if (insight.myTasks && insight.myTasks.length > 0) {
    score += 3 + Math.min(insight.myTasks.length, 5);
  }

  // waitingForOthers: Waiting for others (medium priority)
  if (insight.waitingForOthers && insight.waitingForOthers.length > 0) {
    score += 1 + Math.min(insight.waitingForOthers.length, 2);
  }

  // ========== 3. Value return score ==========
  // High importance
  if (insight.importance === "high") {
    score += 3;
  } else if (insight.importance === "medium") {
    score += 1;
  }

  // High urgency
  if (insight.urgency === "high") {
    score += 6;
  } else if (insight.urgency === "medium") {
    score += 2;
  }

  // isUnreplied: Unreplied message
  if (insight.isUnreplied) {
    score += 1;
  }

  // ========== 4. Time decay ==========
  // More recent events have slightly higher weight
  if (daysSince <= 1) {
    score *= 1.1;
  } else if (daysSince > 14) {
    score *= 0.8; // Older events decay
  }

  // ========== 5. Apply custom weight multiplier ==========
  // finalScore = baseScore × customWeightMultiplier × channelMultiplier
  const finalMultiplier = options?.customMultiplier ?? 1.0;
  score = score * finalMultiplier * channelMultiplier;

  return Math.min(Math.round(score * 10) / 10, 10); // Limit to 0-10 score
}

/**
 * Build the relationship graph between Insights
 * Based on waitingForMe, waitingForOthers, myTasks and other fields
 * Optimized version: uses hash index to reduce O(n²) to O(n)
 */
export function buildEventGraph<T extends InsightBase>(
  insights: T[],
): EventEdge[] {
  const edges: EventEdge[] = [];

  if (insights.length === 0) {
    return edges;
  }

  // 1. Pre-calculate all base scores
  const baseScores = new Map<string, number>();
  // Pre-build ID -> Insight map for O(1) lookup
  const insightById = new Map<string, T>();
  insights.forEach((insight) => {
    baseScores.set(insight.id, calculateBaseScore(insight));
    insightById.set(insight.id, insight);
  });

  // 2. Pre-build lookup maps: person -> insights containing that person
  const peopleMap = new Map<string, Set<string>>();
  insights.forEach((insight) => {
    if (insight.people) {
      for (const person of insight.people) {
        if (!peopleMap.has(person)) {
          peopleMap.set(person, new Set());
        }
        peopleMap.get(person)?.add(insight.id);
      }
    }
  });

  // 3. Pre-build lookup maps: keyword -> insights containing that keyword
  const keywordMap = new Map<string, Set<string>>();
  insights.forEach((insight) => {
    if (insight.topKeywords) {
      for (const keyword of insight.topKeywords) {
        if (!keywordMap.has(keyword)) {
          keywordMap.set(keyword, new Set());
        }
        keywordMap.get(keyword)?.add(insight.id);
      }
    }
  });

  // 4. Build edges (using hash index instead of nested loops)
  // Collect source nodes of each edge for subsequent limiting
  const outgoingEdgesMap = new Map<string, EventEdge[]>();

  insights.forEach((insight) => {
    // If event A's people overlap with event B's people
    // then B -> A (B is a prerequisite for A, if B is more urgent)
    if (insight.people && insight.people.length > 0) {
      // Collect all insight IDs that need to be checked (via person association)
      const relatedInsightIds = new Set<string>();
      for (const person of insight.people) {
        const relatedIds = peopleMap.get(person);
        if (relatedIds) {
          for (const id of relatedIds) {
            if (id !== insight.id) {
              relatedInsightIds.add(id);
            }
          }
        }
      }

      // Only check related insights (using Map lookup instead of find)
      const insightScore = baseScores.get(insight.id) || 0;
      for (const otherId of relatedInsightIds) {
        const other = insightById.get(otherId);
        if (!other) continue;

        const otherScore = baseScores.get(other.id) || 0;

        if (otherScore > insightScore) {
          const edge: EventEdge = {
            fromId: other.id,
            toId: insight.id,
            weight: 0.7,
          };
          edges.push(edge);

          // Record source nodes of the edge
          if (!outgoingEdgesMap.has(other.id)) {
            outgoingEdgesMap.set(other.id, []);
          }
          outgoingEdgesMap.get(other.id)?.push(edge);
        }
      }
    }

    // Association based on topKeywords
    if (insight.topKeywords && insight.topKeywords.length > 0) {
      // Collect all insight IDs that need to be checked (via keyword association)
      const relatedInsightIds = new Set<string>();
      for (const keyword of insight.topKeywords) {
        const relatedIds = keywordMap.get(keyword);
        if (relatedIds) {
          for (const id of relatedIds) {
            if (id !== insight.id) {
              relatedInsightIds.add(id);
            }
          }
        }
      }

      // Only check related insights (using Map lookup instead of find)
      for (const otherId of relatedInsightIds) {
        const other = insightById.get(otherId);
        if (!other) continue;

        const edge: EventEdge = {
          fromId: other.id,
          toId: insight.id,
          weight: 0.3,
        };
        edges.push(edge);

        // Record source nodes of the edge
        if (!outgoingEdgesMap.has(other.id)) {
          outgoingEdgesMap.set(other.id, []);
        }
        outgoingEdgesMap.get(other.id)?.push(edge);
      }
    }
  });

  // 5. Limit outgoing edges per node (max 10), to avoid edge explosion
  const MAX_OUTGOING_EDGES = 10;
  const limitedEdges: EventEdge[] = [];

  // Sort by weight and limit outgoing edges per node
  outgoingEdgesMap.forEach((nodeEdges) => {
    // Sort by weight descending
    nodeEdges.sort((a, b) => b.weight - a.weight);
    // Keep only the highest weighted edges
    const limited = nodeEdges.slice(0, MAX_OUTGOING_EDGES);
    limitedEdges.push(...limited);
  });

  return limitedEdges;
}

/**
 * Calculate EventRank
 * Iteratively calculate until convergence (max 20 times)
 * Optimized version: adaptive iteration count based on dataset size
 */
export function calculateEventRank<T extends InsightBase>(
  insights: T[],
  options: {
    dampingFactor?: number; // Damping factor d, default 0.8
    maxIterations?: number; // Max iterations, default 20
    convergenceThreshold?: number; // Convergence threshold, default 0.001
    // Weight multipliers (from insightWeights table)
    weightMultipliers?: Map<string, number>; // insightId -> customWeightMultiplier
  } = {},
): Map<string, EventRankScore> {
  const {
    dampingFactor = 0.8,
    maxIterations: userMaxIterations = 20,
    convergenceThreshold = 0.001,
  } = options;

  const n = insights.length;
  if (n === 0) {
    return new Map();
  }

  // Adaptive iteration control:
  // - Dataset < 50: use full algorithm (default 20 iterations)
  // - Dataset 50-100: 10 iterations
  // - Dataset 100-200: 5 iterations
  // - Dataset > 200: use simplified scoring (no graph iteration)
  let maxIterations = userMaxIterations;
  if (n < 50) {
    maxIterations = userMaxIterations;
  } else if (n <= 100) {
    maxIterations = Math.min(10, userMaxIterations);
  } else if (n <= 200) {
    maxIterations = Math.min(5, userMaxIterations);
  } else {
    // Large dataset uses simplified scoring, skip graph iteration
    maxIterations = 0;
  }

  // 1. Calculate inherent base scores
  const baseScores = new Map<string, number>();
  insights.forEach((insight) => {
    const customMultiplier = options.weightMultipliers?.get(insight.id);
    baseScores.set(
      insight.id,
      calculateBaseScore(insight, { customMultiplier }),
    );
  });

  // 2. Build event graph
  const edges = buildEventGraph(insights);

  // For large dataset (>200), directly return base scores as result
  if (n > 200 || maxIterations === 0) {
    const result = new Map<string, EventRankScore>();
    insights.forEach((insight) => {
      const baseScore = baseScores.get(insight.id) || 0;
      result.set(insight.id, {
        insightId: insight.id,
        score: baseScore,
        breakdown: {
          baseScore,
          eventRank: 0,
          total: baseScore,
        },
      });
    });
    return result;
  }

  // 3. Build adjacency list
  const incomingEdges = new Map<
    string,
    Array<{ fromId: string; weight: number }>
  >();
  const outgoingCount = new Map<string, number>();

  insights.forEach((insight) => {
    incomingEdges.set(insight.id, []);
    outgoingCount.set(insight.id, 0);
  });

  edges.forEach((edge) => {
    const incoming = incomingEdges.get(edge.toId);
    if (incoming) {
      incoming.push({ fromId: edge.fromId, weight: edge.weight });
    }
    outgoingCount.set(edge.fromId, (outgoingCount.get(edge.fromId) || 0) + 1);
  });

  // 4. Initialize EventRank to base scores
  const eventRank = new Map<string, number>();
  insights.forEach((insight) => {
    eventRank.set(insight.id, baseScores.get(insight.id) || 0);
  });

  // 5. Iterative calculation
  for (let iter = 0; iter < maxIterations; iter++) {
    const newEventRank = new Map<string, number>();
    let maxDiff = 0;

    insights.forEach((insight) => {
      const baseScore = baseScores.get(insight.id) || 0;
      const incoming = incomingEdges.get(insight.id) || [];

      // ER(Ei) = (1-d)×Si + d×Σ(ER(Ej) / Out(Ej)) × Wj→i
      let incomingSum = 0;
      incoming.forEach(({ fromId, weight }) => {
        const erFrom = eventRank.get(fromId) || 0;
        const outCount = outgoingCount.get(fromId) || 1;
        incomingSum += (erFrom / outCount) * weight;
      });

      const newScore =
        (1 - dampingFactor) * baseScore + dampingFactor * incomingSum;
      newEventRank.set(insight.id, newScore);

      // Calculate max difference (for convergence detection)
      const oldScore = eventRank.get(insight.id) || 0;
      maxDiff = Math.max(maxDiff, Math.abs(newScore - oldScore));
    });

    // Update EventRank
    newEventRank.forEach((score, id) => {
      eventRank.set(id, score);
    });

    // Check convergence
    if (maxDiff < convergenceThreshold) {
      break;
    }
  }

  // 6. Build return result
  const result = new Map<string, EventRankScore>();
  insights.forEach((insight) => {
    const baseScore = baseScores.get(insight.id) || 0;
    const erScore = eventRank.get(insight.id) || 0;

    result.set(insight.id, {
      insightId: insight.id,
      score: erScore,
      breakdown: {
        baseScore,
        eventRank: erScore - baseScore,
        total: erScore,
      },
    });
  });

  return result;
}

/**
 * Categorize Insights into four types based on final score
 * Action-oriented categorization based on EventRank algorithm:
 * - urgent: Urgent todo - Urgent matters requiring immediate handling
 * - important: Important follow-up - Important but non-urgent matters
 * - monitor: Keep watch - Need to follow up but not urgent
 * - archive: Temporarily set aside - Low priority matters
 */
export type ActionCategory = "urgent" | "important" | "monitor" | "archive";

/**
 * Get the active time of an event (most recent update or user view)
 * @param insight - Insight object
 * @param lastViewedAt - User's last viewed time
 * @returns Most recent active time
 */
export function getInsightActiveTime(
  insight: InsightBase,
  lastViewedAt?: Date,
): Date {
  const lastUpdate = insight.updatedAt ? new Date(insight.updatedAt) : null;
  const insightTime = new Date(insight.time);

  // If user view time exists and is later than last update time, use view time
  if (lastViewedAt && (!lastUpdate || lastViewedAt > lastUpdate)) {
    return lastViewedAt;
  }

  // Otherwise use last update time, or creation time if not available
  return lastUpdate || insightTime;
}

/**
 * Check if an event is "cold" (no activity for 24 hours)
 * @param insight - Insight object
 * @param lastViewedAt - User's last viewed time
 * @param hours - Cooling hours, default 24
 * @returns true if the event is cold
 */
export function isInsightCold(
  insight: InsightBase,
  lastViewedAt?: Date,
  hours = 24,
): boolean {
  const activeTime = getInsightActiveTime(insight, lastViewedAt);
  const hoursSinceActive =
    (Date.now() - activeTime.getTime()) / (60 * 60 * 1000);
  return hoursSinceActive >= hours;
}

/**
 * Apply gradual degradation rules
 * urgent → important → monitor → archive
 * Auto-degrade after 24 hours of no activity
 * @param baseCategory - Base category (determined by content)
 * @param insight - Insight object
 * @param lastViewedAt - User's last viewed time
 * @returns Degraded category
 */
export function applyCategoryDecay(
  baseCategory: ActionCategory,
  insight: InsightBase,
  lastViewedAt?: Date,
): ActionCategory {
  if (!isInsightCold(insight, lastViewedAt, 24)) {
    return baseCategory;
  }

  // Cold event degradation rules
  const decayMap: Record<ActionCategory, ActionCategory> = {
    urgent: "important",
    important: "monitor",
    monitor: "archive",
    archive: "archive", // archive does not degrade further
  };

  return decayMap[baseCategory];
}

export function categorizeByActionability(
  insight: InsightBase,
  eventRankScore: number, // Use EventRank score to assist categorization
): ActionCategory {
  const baseScore = calculateBaseScore(insight);
  const hasMyTasks = insight.myTasks && insight.myTasks.length > 0;
  const hasWaitingForMe =
    insight.waitingForMe && insight.waitingForMe.length > 0;

  // Urgent: Urgent todo - Action items requiring immediate execution
  // 1. Has my tasks + high urgency/high severity
  // 2. Waiting for me to handle + high urgency
  // 3. Overdue + has tasks/waiting for me
  const isOverdue = insight.dueDate && new Date(insight.dueDate) < new Date();
  if (
    (hasMyTasks && (insight.urgency === "high" || baseScore >= 7)) ||
    (hasWaitingForMe && insight.urgency === "high") ||
    (isOverdue && (hasMyTasks || hasWaitingForMe))
  ) {
    return "urgent";
  }

  // Important: Important follow-up - Important but non-urgent action items
  // 1. Has my tasks (regardless of urgency)
  // 2. High importance + has tasks/waiting for me
  // 3. Has due date (not overdue) + has tasks
  if (
    hasMyTasks ||
    (insight.importance === "high" && (hasMyTasks || hasWaitingForMe)) ||
    (insight.dueDate && !isOverdue && (hasMyTasks || hasWaitingForMe))
  ) {
    return "important";
  }

  // Monitor: Keep watch - Need to follow up but not urgent
  // 1. Waiting for others to reply
  // 2. Unreplied messages
  // 3. Medium priority items with due date
  // 4. High importance but no direct action items
  if (
    (insight.waitingForOthers && insight.waitingForOthers.length > 0) ||
    insight.isUnreplied ||
    insight.dueDate ||
    (insight.importance === "high" && !hasMyTasks && !hasWaitingForMe) ||
    eventRankScore >= 5
  ) {
    return "monitor";
  }

  // Archive: Temporarily set aside - Low priority, for record only
  return "archive";
}

/**
 * Comprehensive sorting function
 * Combines EventRank scores and categories for sorting
 */
export function sortInsightsByEventRank<T extends InsightBase>(
  insights: T[],
  options?: {
    dampingFactor?: number;
    maxIterations?: number;
    convergenceThreshold?: number;
    // Weight multipliers (from insightWeights table)
    weightMultipliers?: Map<string, number>; // insightId -> customWeightMultiplier
    // User's last viewed time (for gradual degradation)
    lastViewedAtMap?: Map<string, Date>; // insightId -> lastViewedAt
  },
): {
  sorted: T[];
  scores: Map<string, EventRankScore>;
  categories: Map<string, ActionCategory>;
} {
  // 1. Calculate EventRank
  const scores = calculateEventRank(insights, options);

  // 2. Categorize (apply gradual degradation)
  const categories = new Map<string, ActionCategory>();
  insights.forEach((insight) => {
    const score = scores.get(insight.id);
    if (score) {
      const baseCategory = categorizeByActionability(insight, score.score);
      const lastViewedAt = options?.lastViewedAtMap?.get(insight.id);
      const finalCategory = applyCategoryDecay(
        baseCategory,
        insight,
        lastViewedAt,
      );
      categories.set(insight.id, finalCategory);
    }
  });

  // 3. Sort
  const categoryOrder: Record<ActionCategory, number> = {
    urgent: 0,
    important: 1,
    monitor: 2,
    archive: 3,
  };

  const sorted = [...insights].sort((a, b) => {
    const categoryA = categories.get(a.id) || "archive";
    const categoryB = categories.get(b.id) || "archive";

    // First sort by category
    const orderA = categoryOrder[categoryA];
    const orderB = categoryOrder[categoryB];
    if (orderA !== orderB) {
      return orderA - orderB;
    }

    // Within the same category, sort by insight time descending (newest to oldest)
    const timeA = getInsightTime(a).getTime();
    const timeB = getInsightTime(b).getTime();
    return timeB - timeA;
  });

  return { sorted, scores, categories };
}

/**
 * Enhanced EventRank calculation (Day 2)
 * Uses LLM to extract precise dependencies between events
 *
 * Current implementation: directly calls calculateEventRank, uses graph algorithm for event sorting
 * Future plan: when useLLMDependencies=true, use LLM to extract more precise dependencies
 *
 * Note: This is an async function reserved as interface for future LLM integration
 */
export async function calculateEventRankEnhanced<T extends InsightBase>(
  insights: T[],
  options: {
    dampingFactor?: number;
    maxIterations?: number;
    convergenceThreshold?: number;
    // LLM extraction options (currently not implemented, reserved as interface)
    useLLMDependencies?: boolean; // Whether to use LLM to extract dependencies
    maxInsightsForLLM?: number; // Maximum number of insights LLM can process
    llmTimeoutMs?: number; // LLM call timeout
    // Weight multipliers (from insightWeights table)
    weightMultipliers?: Map<string, number>; // insightId -> customWeightMultiplier
  } = {},
): Promise<Map<string, EventRankScore>> {
  // Currently directly calls the standard version algorithm
  // LLM dependency extraction logic can be added here in the future
  return calculateEventRank(insights, {
    dampingFactor: options.dampingFactor,
    maxIterations: options.maxIterations,
    convergenceThreshold: options.convergenceThreshold,
    weightMultipliers: options.weightMultipliers,
  });
}

/**
 * Enhanced sorting function (Day 2)
 * Sort after using LLM to extract dependencies
 */
export async function sortInsightsByEventRankEnhanced<T extends InsightBase>(
  insights: T[],
  options?: {
    dampingFactor?: number;
    maxIterations?: number;
    convergenceThreshold?: number;
    useLLMDependencies?: boolean;
    maxInsightsForLLM?: number;
    llmTimeoutMs?: number;
    // Weight multipliers (from insightWeights table)
    weightMultipliers?: Map<string, number>; // insightId -> customWeightMultiplier
    // User's last viewed time (for gradual degradation)
    lastViewedAtMap?: Map<string, Date>; // insightId -> lastViewedAt
  },
): Promise<{
  sorted: T[];
  scores: Map<string, EventRankScore>;
  categories: Map<string, ActionCategory>;
}> {
  // 1. Calculate enhanced EventRank
  const scores = await calculateEventRankEnhanced(insights, options);

  // 2. Categorize (apply gradual degradation)
  const categories = new Map<string, ActionCategory>();
  insights.forEach((insight) => {
    const score = scores.get(insight.id);
    if (score) {
      const baseCategory = categorizeByActionability(insight, score.score);
      const lastViewedAt = options?.lastViewedAtMap?.get(insight.id);
      const finalCategory = applyCategoryDecay(
        baseCategory,
        insight,
        lastViewedAt,
      );
      categories.set(insight.id, finalCategory);
    }
  });

  // 3. Sort
  const categoryOrder: Record<ActionCategory, number> = {
    urgent: 0,
    important: 1,
    monitor: 2,
    archive: 3,
  };

  const sorted = [...insights].sort((a, b) => {
    const categoryA = categories.get(a.id) || "archive";
    const categoryB = categories.get(b.id) || "archive";

    // First sort by category
    const orderA = categoryOrder[categoryA];
    const orderB = categoryOrder[categoryB];
    if (orderA !== orderB) {
      return orderA - orderB;
    }

    // Within the same category, sort by insight time descending (newest to oldest)
    const timeA = getInsightTime(a).getTime();
    const timeB = getInsightTime(b).getTime();
    return timeB - timeA;
  });

  return { sorted, scores, categories };
}
