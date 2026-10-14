---
"@melandlabs/ai": patch
---

Fix `getWorkspaceInstruction` hardcoding a shell tool the model may not have.

The workspace prompt — injected on every conversation — told the model to "Use the `mcp__bash__Bash` tool" and listed `find` / `ls -lt` / `mkdir -p` recipes, unconditionally. That tool name is never registered by `@melandlabs/ai`; it only exists when a host wires up its own bash MCP server. A model that follows the prompt calls a tool that isn't in its tool list and dies mid-task with `No such tool available: mcp__bash__Bash`. The opencontext-hosted CLI providers (claude, codex, opencode, acp) were all affected, since `formatPlanForExecution` builds their execution prompt through this function.

`getWorkspaceInstruction` now takes an explicit `WorkspaceShellCapability` and renders only what the host actually registered:

- `getWorkspaceInstruction(workDir, sandbox?, timezone?, language?, shell?)` — the new parameter defaults to `{ kind: "none" }`, so an existing caller that passes nothing gets the honest "no shell" wording rather than a tool name that may not exist. Existing positional arguments are unchanged.
- `resolveCliShellCapability({ posixToolName, windowsToolName, platform? })` — helper for CLI providers whose shell tool changes name per platform.
- `formatPlanForExecution(plan, workDir, sandbox, aiSoulPrompt, language, timezone, shell?)` — forwards the capability through.

Rendered variants: POSIX recipes under the host's tool name; equivalent PowerShell recipes (`Get-ChildItem` / `Sort-Object` / `Where-Object Length -gt 1MB` / `Copy-Item`) under `dialect: "powershell"`; and for `kind: "none"` an instruction to use Glob with absolute paths plus Read, and an explicit prohibition on calling any shell tool. The workspace safety rules are preserved in every variant — the backup-before-destructive-operation heading, the in-workspace exemption, and the confirmation requirement all stay; without a shell the backup step degrades to "confirm with the user first and prefer a non-destructive approach". The hardcoded POSIX-only `no /tmp/` and `system paths /etc, /usr, /var` wording is now dialect-aware.

The claude provider passes `Bash` / `PowerShell` (the tool names the real Claude Code CLI ships), the codex provider passes `shell` (its native tool name). The opencode and acp providers declare no shell, since their tool sets are not determined by this package.
