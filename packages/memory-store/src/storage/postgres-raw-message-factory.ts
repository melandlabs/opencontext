/**
 * Lazy registration slot for the host's Postgres-backed raw message
 * manager. The actual `PostgresRawMessageManager` class lives in
 * `apps/web/lib/memory/postgres-raw-message-store.ts` because it owns
 * the schema-bound Drizzle table references.
 *
 * The package ships this factory so consumers can wire up their own
 * postgres implementation without forcing the package to take a
 * hard dependency on Drizzle schema files.
 */

import type { MemoryStoreEnv } from "../config";

export interface PostgresRawMessageManagerLike {
	init?(): Promise<void>;
	close?(): Promise<void>;
	upsertRawMessages?(input: {
		userId: string;
		messages: unknown[];
	}): Promise<unknown>;
	getMessageById?(input: {
		userId: string;
		messageId: string;
	}): Promise<unknown>;
	searchMessagesSemantically?(input: {
		userId: string;
		queryEmbedding: number[];
		embeddingModel?: string;
		limit?: number;
		scanLimit?: number;
		threshold?: number;
		includeArchived?: boolean;
		includeDeprecated?: boolean;
		platform?: string;
		botId?: string;
		channel?: string;
		person?: string;
		startTime?: number;
		endTime?: number;
	}): Promise<unknown[]>;
}

export type PostgresFactoryFn = (
	env?: MemoryStoreEnv,
) => Promise<PostgresRawMessageManagerLike>;

let factory: PostgresFactoryFn | null = null;

export function registerPostgresFactory(fn: PostgresFactoryFn): void {
	factory = fn;
}

export function clearPostgresFactory(): void {
	factory = null;
}

export async function resolvePostgresFactory(
	env?: MemoryStoreEnv,
): Promise<PostgresRawMessageManagerLike | null> {
	if (!factory) return null;
	return await factory(env);
}

export function hasPostgresFactory(): boolean {
	return factory !== null;
}
