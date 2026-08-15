# OpenContext Tutorial Tests

This directory contains automated tests that verify all code examples in the tutorials work correctly.

## Test Files

| File | Purpose |
|------|---------|
| `test-tutorials.ts` | Tests all tutorial code examples (00-04) |
| `verify-tutorial-usecases.ts` | Comprehensive use case verification |
| `test-building-agents.ts` | Tests IAgent and agent-related examples (05) |
| `test-basic-memory.ts` | Basic memory API functionality test |
| `test-team-knowledge.ts` | Team knowledge system example |
| `test-team-knowledge-full.ts` | Complete team knowledge workflow |
| `TEST_RESULTS.md` | Latest test results summary |

## Running the Tests

From the `examples` directory:

```bash
cd /Users/timi/codes/opencontext/examples
pnpm test
```

## Test Coverage

All 6 tutorials are covered:

- ✅ **00-getting-started.md** - Installation, first API call, utilities
- ✅ **01-user-guide.md** - Four verbs, temporal memory, warnings
- ✅ **02-developer-guide.md** - Integration patterns, backend selection
- ✅ **03-advanced-usage.md** - Multi-source search, temporal queries
- ✅ **04-best-practices.md** - Idempotency, graceful degradation
- ✅ **05-building-agents.md** - IAgent, StandaloneAgent, custom agents

## Latest Test Results

See [TEST_RESULTS.md](./TEST_RESULTS.md) for detailed results.

**Status:** ✅ ALL TESTS PASSED

**Last Run:** 2026-08-15
