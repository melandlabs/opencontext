# integrations (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

Unified package for opencontext integration packages.

## Packages

This umbrella package exports the following integration packages:

- `integrations/asana` - Asana task integration
- `integrations/calendar` - Google Calendar and Outlook Calendar adapters
- `integrations/channels` - Message platform adapters (Slack, Discord, Telegram, etc.)
- `integrations/hubspot` - HubSpot CRM integration
- `integrations/imessage` - macOS iMessage adapter

## Usage

```typescript
// Import from umbrella package
import { AsanaClient } from "integrations/asana";
import { GoogleCalendarAdapter } from "integrations/calendar";
import { MessagePlatformAdapter } from "integrations/channels";
import { HubspotClient } from "integrations/hubspot";
import { IMessageAdapter } from "integrations/imessage";

// Or import specific sub-paths
import type { Platform } from "integrations/channels/sources/types";
```

## Architecture

Each integration package is self-contained with its own `package.json` and `tsconfig.json`. The umbrella package (`integrations`) re-exports all packages through sub-path exports, allowing consumers to import from a single package while maintaining package separation.
