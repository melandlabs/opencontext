# integrations-jira (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.

[Jira](https://www.atlassian.com/software/jira) integration for OpenContext.
Reads, creates, and updates Jira issues through Atlassian's REST API.

## Installation

```sh
pnpm add @melandlabs/opencontext
```

## Exports

- `JiraAdapter` — Channel adapter implementation
- `JiraClient` — Typed Jira REST client
- `JiraStoredCredentials`, `JiraIssue` — Credential / issue types
