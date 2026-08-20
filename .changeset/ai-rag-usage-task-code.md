---
"@melandlabs/ai-rag": patch
---

Add the optional `usageTaskCode?: string` field to `EmbeddingProviderFactoryOptions` and `CloudEmbeddingProviderOptions`. When set, `CloudEmbeddingProvider.callEmbeddingAPI` forwards it as the `x-alloomi-usage-task` HTTP header so the upstream proxy can attribute credit consumption.

Also flatten `UniversalEmbeddings`'s constructor: the second parameter is now `Omit<EmbeddingProviderFactoryOptions, "userAuthToken">` (was previously `(provider, options)`). Existing callers using `new UniversalEmbeddings(authToken, { usageTaskCode })` (matching the pre-npm `@melandlabs/rag` API) now type-check and forward `usageTaskCode` end-to-end.