# Nyx Server Message Delivery Fix

## Fixed

- Added `POST /messages/send` for desktop/web REST fallback.
- The route stores already encrypted `ciphertext` and `nonce` exactly like the Socket.IO `message:send` flow.
- The server still never receives plaintext.
- After saving the message, the server emits `message:new` to the recipient room `user:<id>` so online mobile clients receive the message.
- If the recipient is online, the message is marked as delivered.

## Why this was needed

The desktop client could fail if Socket.IO was not connected yet. Previously it could show a local fake message even when the server did not save it. The new desktop build only shows a sent message after server confirmation.
