---
"@melandlabs/okf": patch
---

Fix `feedOkfServe` losing the `this` binding when calling `storeMessages` on the memory-store manager. Previously the helper destructured the method off the manager and invoked the bare function, which made `SQLiteRawMessageManager.storeMessages` throw `TypeError: Cannot read properties of undefined (reading 'init')` the first time any test exercised it. Now uses `.call(manager, …)` so the original manager stays the receiver.
