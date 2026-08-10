import type { MemoryRecord, MemoryTier } from "./contracts";

export interface MemoryRecordIngestInput extends Omit<MemoryRecord, "tier"> {
  tier?: MemoryTier;
}

/**
 * Normalize a single memory record before persistence.
 * New records default to short-term tier when tier is omitted.
 */
export function normalizeMemoryRecordForIngest(
  input: MemoryRecordIngestInput,
): MemoryRecord {
  return {
    ...input,
    tier: input.tier ?? "short",
  };
}

/**
 * Normalize a batch of records before persistence.
 */
export function normalizeMemoryRecordsForIngest(
  inputs: MemoryRecordIngestInput[],
): MemoryRecord[] {
  return inputs.map(normalizeMemoryRecordForIngest);
}
