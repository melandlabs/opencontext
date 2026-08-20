---
"@melandlabs/shared": minor
---

Add `workspaceArtifactManifestSchema`, `messageWorkspaceSchema`, and the `workspace` field on `messageMetadataSchema` so consumers can attach a per-message workspace manifest (session or execution scope) without a separate side-channel. Exports the inferred `WorkspaceArtifactManifest` and `MessageWorkspace` types.