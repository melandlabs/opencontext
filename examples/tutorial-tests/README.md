# OpenContext Tutorial Tests

This directory contains automated tests that verify all code examples in the tutorials work correctly.

## Test Files

| File | Purpose |
|------|---------|
| `test-tutorials.ts` | Tests all tutorial code examples (00-04) |
| `verify-tutorial-usecases.ts` | Comprehensive use case verification |
| `test-tutorial-extended.ts` | Extended coverage (temporal queries, encryption, SSRF, etc.) |
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

All 5 tutorials are covered:

- ✅ **00-getting-started.md** - Installation, first API call, utilities
- ✅ **01-user-guide.md** - Four verbs, temporal memory, IAgent, memory-aware agents, agent patterns
- ✅ **02-developer-guide.md** - Integration patterns, backend selection, service patterns
- ✅ **03-advanced-usage.md** - Multi-source search, temporal queries, platform integrations, Loop engine, encryption, SSRF protection, web search
- ✅ **04-best-practices.md** - Idempotency, graceful degradation, batch writes, metadata patterns, structured user IDs, warning handling

### Extended Test Coverage

The `test-tutorial-extended.ts` file adds coverage for:
- **01-user-guide.md**: MemoryAwareAgent pattern
- **03-advanced-usage.md**: Temporal queries with `asOf`, INTEGRATION_IDS, Loop preferences, cron validation, TokenEncryption, URL validation (SSRF), `needsRealTimeInfo`
- **04-best-practices.md**: Batch writes, rich metadata, structured user IDs (`platform|type|id`), messageId stability, warning handling patterns

## Latest Test Results

See [TEST_RESULTS.md](./TEST_RESULTS.md) for detailed results.

**Status:** ✅ ALL TESTS PASSED

**Last Run:** 2026-08-15
