# Nyx Server Docker npm install fix

Fixed the server Docker build failure:

```text
npm ci can only install packages when your package.json and package-lock.json are in sync
Missing: @aws-sdk/client-s3, bullmq, pg, ioredis, pino, ... from lock file
```

## What changed

- Removed stale `package-lock.json` from the server package.
- Updated `Dockerfile` to copy only `package.json` and `.npmrc` before install.
- Replaced `npm ci --omit=dev` with `npm install --omit=dev --no-audit --no-fund --prefer-online`.
- Kept `.npmrc` pointed to `https://registry.npmjs.org/`.
- Added this report and README note.

## Why

The server dependencies were expanded for production, but the lock file still reflected the old smaller dependency set. `npm ci` is intentionally strict and refuses to install when the lock file is stale.

## Verification

- No internal OpenAI registry URLs remain.
- `.env` is not included.
- Server JS syntax check passed after the patch.
