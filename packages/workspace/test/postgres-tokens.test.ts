/**
 * Tests for the FTS5 → tsquery translation.
 *
 * The SQLite backend matches with FTS5 (`"wpricing" OR "h定价 h价方"`);
 * the Postgres backend has to build a `tsquery` expression for the same
 * token stream. These tests pin the mapping so a change in the tokenizer
 * can't silently desync the two backends.
 */
import { describe, expect, it } from "vitest";

import { buildTsQueryExpression, workspaceTsQueryFragments } from "../src/postgres/tokens";

describe("postgres tsquery translation", () => {
	it("maps a latin word to a single-token phrase", () => {
		expect(workspaceTsQueryFragments("pricing")).toEqual(["wpricing"]);
	});

	it("maps a Han word to its adjacent-bigram chain", () => {
		expect(workspaceTsQueryFragments("定价方案")).toEqual(["h定价 h价方 h方案"]);
	});

	it("maps a single Han character to one token", () => {
		expect(workspaceTsQueryFragments("定")).toEqual(["h定"]);
	});

	it("splits a multi-word latin query into alternatives", () => {
		expect(workspaceTsQueryFragments("pricing plan")).toEqual(["wpricing", "wplan"]);
	});

	it("keeps Han runs and latin words apart", () => {
		expect(workspaceTsQueryFragments("定价 pricing")).toEqual(["h定价", "wpricing"]);
	});

	it("renders one placeholder per fragment", () => {
		const { sql, params } = buildTsQueryExpression(["wpricing", "wplan"], 1);
		expect(sql).toBe(
			"phraseto_tsquery('simple'::regconfig, $1) || phraseto_tsquery('simple'::regconfig, $2)",
		);
		expect(params).toEqual(["wpricing", "wplan"]);
	});

	it("offsets the placeholders past the caller's own parameters", () => {
		const { sql, params } = buildTsQueryExpression(["wpricing"], 3);
		expect(sql).toBe("phraseto_tsquery('simple'::regconfig, $3)");
		expect(params).toEqual(["wpricing"]);
	});

	it("returns an empty expression for an empty fragment list", () => {
		expect(buildTsQueryExpression([])).toEqual({ sql: "", params: [] });
	});
});
