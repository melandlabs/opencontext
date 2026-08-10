# @opencontext/integrations

Unified package for opencontext integration packages.

## Packages

This umbrella package exports the following integration packages:

- `@opencontext/integrations/asana` - Asana task integration
- `@opencontext/integrations/calendar` - Google Calendar and Outlook Calendar adapters
- `@opencontext/integrations/channels` - Message platform adapters (Slack, Discord, Telegram, etc.)
- `@opencontext/integrations/hubspot` - HubSpot CRM integration
- `@opencontext/integrations/imessage` - macOS iMessage adapter

## Usage

```typescript
// Import from umbrella package
import { AsanaClient } from "@opencontext/integrations/asana";
import { GoogleCalendarAdapter } from "@opencontext/integrations/calendar";
import { MessagePlatformAdapter } from "@opencontext/integrations/channels";
import { HubspotClient } from "@opencontext/integrations/hubspot";
import { IMessageAdapter } from "@opencontext/integrations/imessage";

// Or import specific sub-paths
import type { Platform } from "@opencontext/integrations/channels/sources/types";
```

## Architecture

Each integration package is self-contained with its own `package.json` and `tsconfig.json`. The umbrella package (`@opencontext/integrations`) re-exports all packages through sub-path exports, allowing consumers to import from a single package while maintaining package separation.
