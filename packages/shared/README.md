# shared (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Reusable utilities, types, and constants extracted from the OpenContext web app.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `cn()` - Class name utility (clsx + tailwind-merge)
- `generateUUID()` - UUID v4 generator
- `sanitizeText()` - Text sanitization
- `normalizeTimestamp()` - Timestamp normalization
- `formatBytes()` - File size formatting
- `formatToLocalTime()` - Local time formatting
- `getCurrentYearMonth()` - Current year/month
- `getCurrentTimestamp()` - Unix timestamp
- `getMostRecentUserMessage()` - Get last user message
- `getTrailingMessageId()` - Get trailing message ID
- `getTextFromMessage()` - Extract text from chat message
- `AppError` - Application error class
- `ErrorCode`, `ErrorType`, `Surface` - Error type system
- `ChatMessage`, `MessageMetadata`, `Attachment` - Chat types
- `CustomUIDataTypes` - UI data type definitions
