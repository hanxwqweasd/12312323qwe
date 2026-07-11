# Nyx Server Bot Webhook Runtime Fix

This patch makes external Nyx bots usable from the app without waiting for a separate queue worker.

## What changed

- `/bots/:id/incoming` now forwards user messages to the bot webhook immediately when the bot has `webhook_url` configured.
- The webhook can return a JSON reply and the server returns that reply directly to the app.
- The sender payload now includes `id`, `username` and `nickname` when available.
- Built-in `/start`, `/help` and command menu fallback still work when webhook is missing or fails.
- Webhook timeout is controlled by `BOT_WEBHOOK_TIMEOUT_MS`, default `4500`.

## Expected webhook response

```json
{
  "ok": true,
  "reply": {
    "text": "Hello from bot",
    "reply_markup": {
      "inline_keyboard": []
    }
  }
}
```

The bot can also return:

```json
{ "text": "Hello" }
```

## Check

```bash
node scripts/check-server.js
```

