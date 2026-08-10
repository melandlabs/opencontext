# mcp (workspace)

> **Workspace package.** Internal monorepo build artifact; not published to npm.
> End users install [`@melandlabs/opencontext`](https://www.npmjs.com/package/@melandlabs/opencontext)
> (the facade) instead. Monorepo contributors depend on this package via
> the workspace protocol.


Stdio MCP server for using local OpenContext Desktop from MCP-capable agent
runtimes.

## Local Build

Build the MCP server from the OpenContext repository:

```bash
pnpm --filter @melandlabs/mcp build
```

Then point the runtime at the built stdio entrypoint:

```json
{
	"mcpServers": {
		"opencontext-local": {
			"command": "node",
			"args": ["/path/to/opencontext/packages/ai/mcp/dist/cli.js"]
		}
	}
}
```

CLI clients can add the local server with:

```bash
codex mcp add opencontext-local -- node "/path/to/opencontext/packages/ai/mcp/dist/cli.js"
claude mcp add --transport stdio --scope user opencontext-local -- node "/path/to/opencontext/packages/ai/mcp/dist/cli.js"
```

On Windows, use an escaped path in JSON, such as
`C:\\path\\to\\opencontext\\packages\\ai\\mcp\\dist\\cli.js`.

## User Flow

1. Add the MCP server config in the agent runtime.
2. Reload or restart the runtime's MCP servers.
3. Run `opencontext_setup` or `opencontext_status` first.
4. Follow the returned setup guidance if OpenContext Desktop is not ready.
5. Use OpenContext memory, RAG, knowledge base, connector, and Loop tools.

## Tools

- `opencontext_setup`, `opencontext_status`
- `opencontext_memory_search`
- `opencontext_rag_search`
- `opencontext_kb_list_documents`, `opencontext_kb_get_document`,
  `opencontext_kb_stats`
- `opencontext_connectors_list_accounts`, `opencontext_connectors_status`
- `opencontext_loop_state`, `opencontext_loop_list_decisions`
