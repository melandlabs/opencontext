import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  // All packages in this monorepo run their tests in isolation; vitest
  // discovers each package's vitest.config.* automatically via globs.
  "packages/*",
  "packages/ai/*",
  "packages/integrations/*",
  "apps/*",
  "services/*",
]);