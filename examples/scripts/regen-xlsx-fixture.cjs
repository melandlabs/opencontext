/**
 * Regenerate the workspace-wiki xlsx fixture.
 *
 * Run with: `node examples/scripts/regen-xlsx-fixture.cjs`
 *
 * Writes `examples/fixtures/workspace-wiki/contract-terms.xlsx` with two
 * sheets that mirror the same cap-of-liability / indemnification theme
 * carried by the markdown / PDF / DOCX fixtures, so any of them can be
 * hit by the same lexical query ("limitation", "indemnification") and the
 * chunker / embedder sees structurally similar content.
 */

const path = require("node:path");
const XLSX = require("/Users/timi/codes/opencontext/node_modules/xlsx");

const outPath = path.resolve(__dirname, "..", "fixtures", "workspace-wiki", "contract-terms.xlsx");

const workbook = XLSX.utils.book_new();

// Sheet 1: Liability cap matrix.
const liability = [
	["Contract", "Party", "Cap (months of fees)", "Notes"],
	["Master Services Agreement", "Acme Corp", 12, "Standard 12-month cap, mirrors public law"],
	["Statement of Work #1", "Acme Corp", 12, "Inherits MSA cap"],
	["Vendor Agreement", "Globex Inc", 6, "Reduced cap for vendor services"],
	["NDA", "Initech", 0, "No liability cap (NDAs only)"],
];
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(liability), "Liability Caps");

// Sheet 2: Indemnification carve-outs.
const indemnity = [
	["Carve-out", "Applies to", "Trigger"],
	["Gross negligence", "All contracts", "Willful misconduct"],
	["IP infringement", "MSA / SOW", "Third-party patent claim"],
	["Confidentiality breach", "NDA only", "Material disclosure"],
	["Data breach", "MSA / SOW", "PII exposure > 100 records"],
];
XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(indemnity), "Indemnification");

XLSX.writeFile(workbook, outPath);
console.log(`wrote ${outPath}`);
