# Channels

Channels implement `ChannelAdapter` from `packages/channels/src/types.ts`.

## Included adapters
- CLI (`createCliAdapter`)
- Telegram (`createTelegramAdapter`, supports bot + MTProto modes)
- WhatsApp (`createWhatsAppAdapter`)
- Webhook (`createWebhookAdapter`)

## Adapter lifecycle
1. `connect()`
2. `onMessage(handler)`
3. `sendMessage(channelId, response)`
4. `disconnect()`

Each adapter should translate external events into `HairyMessage` and keep reconnection logic local to the adapter.
