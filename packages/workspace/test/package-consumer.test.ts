import {
	createSqliteWorkspaceStore,
	resolveWorkspaceCitation,
	searchWorkspaceContext,
} from "@melandlabs/workspace";
import type { RuntimeContext, WorkspaceSearchHit } from "@melandlabs/workspace";
import Database from "better-sqlite3";
import { expect, it } from "vitest";

it("consumes Chinese search and citations through the built package exports", async () => {
	const database = new Database(":memory:");
	const store = await createSqliteWorkspaceStore({ db: database });
	const context: RuntimeContext = { user_id: "consumer", request_id: "exports" };
	try {
		await store.indexResource({
			workspace_id: "personal:consumer",
			user_id: context.user_id,
			resource: {
				canonical_key: "notes.md",
				absolute_path: "/notes.md",
				title: "Notes",
				body: "项目代码需要 review。",
				size_bytes: 32,
				resource_type: "note",
			},
		});
		const result = await searchWorkspaceContext(context, store, {
			workspace_id: "personal:consumer",
			query: "代码",
			strategy: "lexical",
		});
		const hit: WorkspaceSearchHit = result.hits[0]!;
		expect(await resolveWorkspaceCitation(context, store, { citation: hit.citation })).toMatchObject({
			status: "resolved",
			content: "项目代码需要 review。",
		});
	} finally {
		await store.close();
		database.close();
	}
});
