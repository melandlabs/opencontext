/**
 * Cross-cutting zod schemas shared between runtime and UI.
 *
 * Keep this file lean — domain-specific schemas belong in their respective
 * runtime packages (memory-store, integrations/<platform>, ai, etc.). Only
 * schemas that genuinely straddle the runtime/UI boundary live here.
 *
 * `zod` is an optional peer dependency; importing from `@melandlabs/contracts/schemas`
 * requires the consumer to have zod installed. Runtime and UI both already do.
 */
import { z } from "zod";

import type { IntegrationId } from "./integration-id.js";
import { INTEGRATION_IDS } from "./integration-id.js";
import type { UserType } from "./user-type.js";
import { USER_TYPES } from "./user-type.js";

export const UserTypeSchema = z.enum(
	USER_TYPES as unknown as [UserType, ...UserType[]],
);

export const IntegrationIdSchema = z.enum(
	INTEGRATION_IDS as unknown as [IntegrationId, ...IntegrationId[]],
);
