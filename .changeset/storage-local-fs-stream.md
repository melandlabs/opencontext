---
"@melandlabs/storage": minor
---

`uploadToLocalFs` now also accepts a stream — any async iterable of bytes,
such as a Node `Readable` — besides `ArrayBuffer` and `Buffer`. Chunks are
written to disk as they arrive, so a large upload is never held in memory as a
whole (a 512 MiB stream adds about 40 MiB of RSS, against the full file size
for a `Buffer`). If the stream fails — even before the file has been opened,
for example because a client disconnected — the call rejects with the
stream's own error instead of an unhandled `'error'` event, and the partially
written file is removed, so a failed upload stores nothing.
