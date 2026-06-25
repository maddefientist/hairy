VERDICT: FAIL
CRITICAL:
- packages/tools/src/corra/knowledge-queue.ts:120 — shared write and queue status update are not atomic. If `deps.sharedBackend.store()` succeeds at line 116 but `saveQueue()` fails here (disk full, permission error, interrupted rename), the item remains `pending` even though it was written to `claude-shared`; the next `/promote <id>` writes the same knowledge again, polluting the fleet brain.
- apps/hairy-agent/src/main.ts:1322 — owner gate trusts only `ctx.senderId`; `packages/channels/src/webhook.ts:44-49` lets any holder of the webhook secret supply an arbitrary `senderId`. A webhook caller can POST `{senderId: CORRA_OWNER_CHAT_ID, text: "/promote 1"}` and pass the owner check without being the human owner.
IMPORTANT:
- packages/tools/src/corra/knowledge-queue.ts:64 — `queueLock` is process-local only. Two running agent processes using the same `dataDir` can both load the same pending candidate, both pass the status check, and both store to `claude-shared` before either writes the promoted status.
- packages/tools/src/corra/knowledge-queue.ts:106 — dedup is effectively a no-op: a matching existing shared item is ignored and promotion still proceeds with no warning in the returned result. Exact/near duplicate shared knowledge can be re-added by owner approval or by the inconsistency/race paths above.
- packages/tools/src/corra/knowledge-queue.ts:116 — promoted content only stores title/body plus tags; it does not carry candidate id, source namespace/private queue provenance, approver, or approval timestamp. A bad shared write cannot be traced back to the specific queued candidate/human approval path.
SUGGESTION:
- packages/tools/src/corra/knowledge-queue.ts:124 — `/kedit` can modify already-promoted candidates in the local queue, making the queue record diverge from what was actually written to `claude-shared`.
