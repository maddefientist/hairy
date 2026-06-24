VERDICT: FAIL
CRITICAL:
- apps/hairy-agent/src/main.ts:851 / apps/hairy-agent/src/main.ts:1087 / packages/tools/src/corra/x-draft-queue.ts:84 — `corra_x_queue` is registered as a normal tool and, in unified mode, exposed to the model with no owner check inside `execute`; a non-owner prompt that induces a tool call `{action:"approve",id:"1"}` can post without `/approve` or owner gating.
- packages/tools/src/corra/x-draft-queue.ts:87 — approval state is saved before webhook success; if `fetch` fails, `CORRA_X_N8N_WEBHOOK` is empty, or n8n returns non-2xx, the draft is marked `approved`, disappears from pending list, and was not posted.
- packages/tools/src/corra/x-draft-queue.ts:85 — already-approved drafts are still approvable; owner retrying `/approve 1` after success, or after an ambiguous timeout, posts the same text again.
- packages/tools/src/corra/x-draft-queue.ts:64 / packages/tools/src/corra/x-draft-queue.ts:87-98 — no lock/atomic compare around load-save-post; two concurrent `/approve 1` calls can both read `pending`, both save approved, and both call the webhook.

IMPORTANT:
- packages/tools/src/corra/x-draft-queue.ts:45-47 — malformed/partially-written queue JSON is silently treated as `[]`; the next draft/edit/save overwrites the queue and loses all pending approvals.
- packages/tools/src/corra/x-draft-queue.ts:53 — `writeFile` is non-atomic; process crash or concurrent writers can leave truncated JSON, triggering the silent data loss path above.
- .chain/20260624-004529/progress.md:1 — ISSUE: progress.md missing; no `state_return/v1` block available to cross-check claims/verifications.

SUGGESTION:
- packages/tools/src/corra/x-draft-queue.ts:30 — queue file contents are cast, not validated, so corrupted records can reach approval/posting paths.

