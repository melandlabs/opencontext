import { z } from "zod";

/**
 * Maximum number of custom insight filters a single user can create.
 * Keep this in sync with any product limits on the client.
 */
export const MAX_CUSTOM_INSIGHT_FILTERS = 12;

export const insightFilterSlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9][a-z0-9-_]+$/i, {
    message:
      "Slug must start with an alphanumeric character and can only include letters, numbers, dashes, or underscores.",
  });

const colorHexSchema = z.string().regex(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i, {
  message: "Color must be a valid hex value like #4F46E5.",
});

const matchPreferenceSchema = z.enum(["any", "all"]);

const stringToken = z.string().min(1).max(120);

const stringTokenList = (min: number, max: number) =>
  z.array(stringToken).min(min).max(max);

export const insightFilterConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("importance"),
    values: stringTokenList(1, 6),
  }),
  z.object({
    kind: z.literal("urgency"),
    values: stringTokenList(1, 6),
  }),
  z.object({
    kind: z.literal("platform"),
    values: stringTokenList(1, 12),
  }),
  z.object({
    kind: z.literal("task_label"),
    values: stringTokenList(1, 12),
  }),
  z.object({
    kind: z.literal("account"),
    values: stringTokenList(1, 12),
  }),
  z.object({
    kind: z.literal("category"),
    values: stringTokenList(1, 12),
  }),
  z.object({
    kind: z.literal("people"),
    values: stringTokenList(1, 16),
    match: matchPreferenceSchema.default("any"),
    caseSensitive: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("groups"),
    values: stringTokenList(1, 16),
    match: matchPreferenceSchema.default("any"),
  }),
  z.object({
    kind: z.literal("keyword"),
    values: stringTokenList(1, 10),
    match: matchPreferenceSchema.default("any"),
    fields: z
      .array(
        z.enum([
          "title",
          "description",
          "details",
          "sources",
          "groups",
          "insight_keywords",
          "people",
        ]),
      )
      .optional(),
  }),
  z.object({
    kind: z.literal("mentions_me"),
    // Zero array for Consistent type.
    values: z.array(z.string()).min(0).max(0),
  }),
  z.object({
    kind: z.literal("time_window"),
    withinHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30),
  }),
  z.object({
    kind: z.literal("has_tasks"),
    values: z
      .array(
        z.enum(["myTasks", "waitingForMe", "waitingForOthers", "nextActions"]),
      )
      .min(1)
      .max(4)
      .default(["myTasks", "waitingForMe", "waitingForOthers"]),
  }),
]);

export type InsightFilterCondition = z.infer<
  typeof insightFilterConditionSchema
>;

export const insightFilterDefinitionSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(insightFilterConditionSchema).min(1).max(12),
});

export type InsightFilterDefinition = z.infer<
  typeof insightFilterDefinitionSchema
>;

/**
 * Logical operators for filter expressions (supports AND/OR/NOT; AND has higher precedence than OR, NOT has the highest precedence)
 */
export type InsightFilterLogicOp = "and" | "or" | "not";

/**
 * Binary operator expression (AND/OR): requires left and right operands
 */
export interface InsightFilterBinaryExpr {
  op: Exclude<InsightFilterLogicOp, "not">; // Restrict to AND/OR only
  left: InsightFilter;
  right: InsightFilter;
}

/**
 * Unary operator expression (NOT): requires only a single operand
 */
export interface InsightFilterNotExpr {
  op: "not";
  operand: InsightFilter; // Replaces left/right for single operand usage
}

/**
 * Binary tree-style filter expression (supports infinite nesting with type safety)
 * Optimizations:
 * 1. NOT (unary operator) only requires the `operand` field
 * 2. AND/OR (binary operators) retain the `left` and `right` fields
 *
 * Example 1: NOT (A AND B)
 * {
 *   op: "NOT",
 *   operand: { op: "AND", left: filterA, right: filterB }
 * }
 *
 * Example 2: A OR (NOT B AND C)
 * {
 *   op: "OR",
 *   left: filterA,
 *   right: { op: "AND", left: { op: "NOT", operand: filterB }, right: filterC }
 * }
 */
export type InsightFilter =
  | InsightFilterDefinition // Atomic filter rule
  | InsightFilterBinaryExpr // Binary operators (AND/OR)
  | InsightFilterNotExpr; // Unary operator (NOT)

/**
 * Reverse Polish Notation (RPN, postfix notation) item: atomic filter rule + logical operator
 * NOT usage rule for RPN: Operand comes first, followed by the NOT operator (e.g., filterB, NOT → represents NOT B)
 *
 * Example 1: A OR (B AND C AND D) translates to RPN: [filterA, filterB, filterC, filterD, 'AND', 'AND', 'OR']
 * Example 2: A OR (NOT B AND C) translates to RPN: [filterA, filterB, NOT, filterC, AND, OR]
 */
export type InsightFilterRPNItem =
  | InsightFilterDefinition
  | InsightFilterLogicOp;

export const insightFilterCreateSchema = z.object({
  label: z.string().min(1).max(64),
  slug: insightFilterSlugSchema,
  description: z.string().max(256).optional(),
  color: colorHexSchema.optional(),
  icon: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-_]+$/i, {
      message:
        "Icon should be the name of a registered icon (letters, numbers, dash, underscore).",
    })
    .optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isPinned: z.boolean().optional(),
  definition: z.any().optional(),
});

export const insightFilterUpdateSchema = z
  .object({
    label: z.string().min(1).max(64).optional(),
    slug: insightFilterSlugSchema.optional(),
    description: z.string().max(256).optional(),
    color: colorHexSchema.or(z.literal(null)).optional(),
    icon: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-_]+$/i)
      .or(z.literal(null))
      .optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
    isPinned: z.boolean().optional(),
    isArchived: z.boolean().optional(),
    definition: z.any().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "At least one field must be provided.",
  );

export type InsightFilterCreatePayload = z.infer<
  typeof insightFilterCreateSchema
>;

export type InsightFilterUpdatePayload = z.infer<
  typeof insightFilterUpdateSchema
>;

export type InsightFilterResponse = {
  id: string;
  userId: string;
  label: string;
  slug: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  sortOrder: number;
  isPinned: boolean;
  isArchived: boolean;
  source: "user" | "system";
  definition: InsightFilter;
  createdAt: string;
  updatedAt: string;
};

export function sanitizeFilterSlug(slug: string) {
  return slug.trim().toLowerCase();
}

export function sanitizeColorToken(color: string | null | undefined) {
  if (!color) return null;
  const value = color.startsWith("#") ? color : `#${color}`;
  return value.toUpperCase();
}

export type InsightFilterSummary = Pick<
  InsightFilterResponse,
  "id" | "label" | "slug" | "color" | "icon"
>;
