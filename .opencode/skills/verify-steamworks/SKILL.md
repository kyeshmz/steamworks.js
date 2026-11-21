---
name: verify-steamworks
description: Verify the steamworks.js Node addon, native exports and consumer declarations after binding changes.
---

## Launch
At the repository root run `corepack pnpm install --frozen-lockfile` then `corepack pnpm run build:debug`. This generates declarations and the host addon under `dist`. Builds in one checkout share those files.

## Doctor
Use `node -p "process.platform + '/' + process.arch"` and `node -e "require('.')"` to check the host and loader. Loading the addon does not initialize Steam.

## Drive
Run `corepack pnpm --dir test/typescript run compile`, `node test/package-smoke.js` and `node test/sdk-offline.js`. After changing `scripts/sdk/` or the vendored steamworks-rs, also run `node scripts/sdk/generate.mjs --check`. Use [the feature map](features/README.md) to choose runtime checks.

## Evidence and cleanup
Keep the command output in `.git/verify-steamworks.log`. The Node and TypeScript processes exit themselves. Keep the build output for the next check. A load check is not proof of operations on live Steam accounts.
