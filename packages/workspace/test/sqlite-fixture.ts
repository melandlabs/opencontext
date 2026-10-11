import Database from "better-sqlite3";
import { SqliteWorkspaceStore } from "../src/sqlite";

/** Own native connections explicitly so Windows can remove the fixture directory. */
export function createWorkspaceStoreFixture() {
	const databases: Database.Database[] = [];
	return {
		makeStore(dbPath: string) {
			const db = new Database(dbPath);
			databases.push(db);
			return new SqliteWorkspaceStore({ db });
		},
		closeAll() {
			for (const db of databases.splice(0)) if (db.open) db.close();
		},
	};
}
