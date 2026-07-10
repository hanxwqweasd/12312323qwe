# Nyx Server App Support Final Patch

This server patch aligns backend endpoints with the latest Nyx mobile client.

## Added backend support

- Support desk endpoints under `/support`:
  - create ticket
  - list own/admin tickets
  - read ticket thread
  - add messages
  - admin status/priority update
- Moderation endpoints under `/moderation`:
  - create report
  - block/unblock user
  - list blocklist
  - hide content
- NyxDev admin endpoints under `/admin`:
  - search users
  - search channels
  - search bots
  - support tickets
  - moderation reports
  - error reports
  - system broadcasts
- Saved content endpoints under `/saved-items`:
  - notes, links, messages, files, photos, videos, voice/audio, stickers, stories
- Wallet/NYX Coin endpoints:
  - `/premium/wallet`
  - `/premium/coins/purchase`
  - `/premium/coins/ad-reward`
- Account deletion endpoint:
  - `/users/me/delete`
- Public profile now includes business profile fields when configured.
- Channel/group styling fields:
  - accent color
  - welcome text
  - theme JSON
- Support bot can only be created/modified as official support bot by `NyxDev`.

## Stability fixes

- Removed remaining external brand mentions from server code/report files.
- Kept SQLite safe-index logic for old volumes.
- Kept Docker npm install fix without stale package-lock.
- Added backend tables and indexes for moderation/support/wallet/saved content.

## Check

- `node scripts/check-server.js` passed: 54 JS files.

## GitHub note

The connected GitHub integration still cannot write to `hanxwqweasd/12312323qwe` and returns:

`Resource not accessible by integration`

Use the included push kit script to push from your local machine with a fresh GitHub token.
