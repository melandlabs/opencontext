---
"@melandlabs/workspace": minor
---

Bulk-walk hygiene and a real soft-delete lifecycle:

- `listOkfFolderResources` / `indexOkfFolder` no longer descend into dot-directories or dependency dirs (`node_modules`, `__pycache__`, `venv` via the new `DEFAULT_IGNORED_DIR_NAMES`); pass `ignoreDirNames` for extra skips. Previously a resource folder containing a clone or install tree indexed every `README.md` / `LICENSE.txt` inside it.
- Barrel exports `SUPPORTED_EXTENSIONS` and `resourceTypeForExtension` so live watchers can gate extensions and stamp resource types with exactly the vocabulary the bulk walk writes (no more mirrored copies drifting apart).
- New `SqliteWorkspaceStore.softDeleteResource({ workspace_id, canonical_key })` — idempotent single-resource soft delete for live unlink mirroring between bulk reconciles.
- **Behavior fix**: `listResources`, `searchLexical`, `searchSemantic`, and `expandNeighbors` now exclude soft-deleted resources (`metadata.deleted_at` marker). The marker previously hid nothing, so files removed from the source folder kept surfacing in search after a reconcile. `indexResource` clears the marker on re-index (both the unchanged and modified paths), so a file that comes back becomes visible again — even when its content hash did not change.
