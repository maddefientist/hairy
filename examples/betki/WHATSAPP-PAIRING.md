# Betki WhatsApp Pairing Handover (Context Reset)

## Goal
Get Betki fully paired and usable on WhatsApp with number `17787650561` and keep service autonomous/reliable.

---

## Current State (as of this handover)

### Platform / Service
- VM: `hiveagent`
- Runtime root: `/root/betki`
- Service: `betki.service` (systemd, enabled)
- Health endpoint: `http://127.0.0.1:9091/health`
- Provider: Ollama (`kimi-k2.5:cloud`)
- Channel: WhatsApp only

### Build / Quality
All local + remote checks passed before pairing troubleshooting:
- `pnpm build` ✅
- `pnpm test` ✅
- `pnpm check` ✅

### Betki Isolation
- Hive write namespace currently scoped to Betki private namespace.
- Read namespaces currently restricted to Betki private namespace.
- No cross-agent writes enabled.

---

## Problem Summary
Pairing is failing repeatedly.

### Observed behavior
1. Pairing code is generated (example codes observed: `597A4T2A`, `CA92BE5A`).
2. Immediately after code generation, connection closes with:
   - `code: 401`
   - `loggedOut: true`
3. Phone flow reports **"couldn't link device"**.
4. QR in terminal is hard to use due rendering/truncation in user workflow.

### Key log signature
From `journalctl -u betki`:
- `"pairingCode":"<CODE>"`
- then very quickly
- `"code":401,"loggedOut":true,"msg":"whatsapp connection closed"`

---

## What was already attempted

1. **Fresh session reset**
   - Stopped service
   - Cleared `/root/betki/data/whatsapp-session`
   - Restarted service
2. **Pairing-code mode added** (code patch)
   - Added `WHATSAPP_PAIR_PHONE` support
   - Adapter calls `sock.requestPairingCode(phone)`
3. **Repeated fresh code generation**
   - Codes generated successfully
   - Link still fails on phone
4. **Service/process cleanup**
   - Resolved stale process/port issues encountered earlier (`9091` conflict)

---

## Most likely causes

1. **Pairing-code request timing issue** in adapter lifecycle (request sent before/around unstable connection phase).
2. **WhatsApp account/device constraints** on phone side (multi-device/linking state, app version, linked-device limits, account policy).
3. **Session invalidation race**: code generated, auth context invalidated immediately.

---

## Files touched for this area

### Core pairing-related code
- `packages/channels/src/whatsapp.ts`
  - Added pairing code mode (`pairPhone`)
  - Requests pairing code via `requestPairingCode`
  - Logs pairing code

### Config wiring
- `apps/hairy-agent/src/config.ts`
  - Added `WHATSAPP_PAIR_PHONE` parsing
- `apps/hairy-agent/src/main.ts`
  - Passes `pairPhone` into WhatsApp adapter

---

## Next Session Recommended Plan (fastest path)

### Option A (recommended): make QR robust + avoid pairing-code race
1. Disable pairing-code mode temporarily:
   - Remove/blank `WHATSAPP_PAIR_PHONE` in `/root/betki/.env`
2. Add QR artifact output in adapter:
   - Write latest QR PNG to `/root/betki/data/whatsapp-session/latest-qr.png`
   - (optionally) keep terminal QR too
3. Restart service and scan PNG on phone.

### Option B: keep pairing-code mode, but stabilize timing
1. Move `requestPairingCode()` call to a safer state transition (after connection update indicates ready for pairing, not immediate post socket create).
2. Add retry/backoff for pairing code request.
3. Keep single active socket attempt during pairing (avoid restarts while user enters code).

---

## Immediate commands to resume troubleshooting

```bash
# 1) Check service + health
ssh hiveagent 'systemctl is-active betki.service && curl -s http://127.0.0.1:9091/health'

# 2) Watch logs
ssh hiveagent 'journalctl -u betki -f -o cat'

# 3) Full session reset (safe)
ssh hiveagent '
  systemctl stop betki.service;
  pkill -f "/root/betki/apps/hairy-agent/dist/main.js" || true;
  rm -rf /root/betki/data/whatsapp-session;
  mkdir -p /root/betki/data/whatsapp-session;
  systemctl start betki.service
'
```

---

## Success criteria
1. Health shows WhatsApp connected:
   - `"channels":[{"type":"whatsapp","connected":true}]`
2. User and partner can send WhatsApp messages and receive Betki responses.
3. Optional lock-down afterward:
   - set `WHATSAPP_ALLOWED_JIDS=<jid1>,<jid2>`

---

## Non-goals (already acceptable)
- Namespace model is acceptable as a single Betki unit.
- No need to split writes by individual sender right now.

---

## Important context for the next agent
- This is **not** a general Hairy issue; it's currently a **WhatsApp pairing reliability issue** under Betki deployment.
- Do not re-open architecture/design debates.
- Focus only on pairing stability and immediate usability.
