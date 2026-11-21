# Fork features

Use `const client = require('@kyeshmz/steamworks.js').init(appId)` in the main process. The [declarations](../client.d.ts) list all public methods and parameter types.

| Area | What applications can do |
|---|---|
| Leaderboards | Find or create a board, upload scores and details, download ranked entries, and read board metadata. |
| Friends | Enumerate immediate friends, request persona information, and read small, medium, or large RGBA avatars. |
| Input | Find action origins and controller glyphs, change action-set layers, open the binding panel, and trigger vibration and haptics. |
| Lobbies | Filter by strings, numbers, slots or distance, read and set member data, and exchange chat buffers. |
| Networking | Use channel-based [Steam Networking Messages](networking-messages.md). Legacy P2P remains available. Connection-oriented Networking Sockets is a different API and is not implemented. |
| Achievements and stats | Fetch global unlock percentages, localized attributes and icons, and get or set float stats. |
| Cloud and Workshop | Read or write binary saves asynchronously, inspect cloud timestamps and persistence, and select the Workshop file type on creation. |
| Overlay and screenshots | Query overlay availability, subscribe to activation changes, place notifications, trigger captures and import JPEGs. |
| Apps and DLC | Read launch parameters, list DLC, request installation or removal, and check download progress. |
| Inventory | Load definition IDs and properties, and send a playtime heartbeat. Owned item balances, trading, purchases and signed proofs are not exposed. |
| Everything else | `client.sdk` exposes the whole SDK under its C++ names, including inventory results, trading, Networking Sockets, HTML surfaces, game servers and timeline. See the [SDK layer guide](guide/sdk.md) and its [coverage page](sdk/coverage.md). |

## What the checks prove

`test/package-smoke.js` loads the built addon and checks native argument validation without a Steam account. `test/sdk-offline.js` does the same for the SDK layer, and also checks struct layouts and callback dispatch. `test/typescript` compiles a consumer against the declarations. The release workflow runs package checks on Linux x64, Windows x64, and both Mac architectures.

Use `node test/steam-readonly.js 480` with a signed-in Steam client to check reads. `test/inventory-definitions.js` needs an App ID and a known item definition. Overlay rendering, physical input, two-account networking and writes to Steam need separate live tests.

## Contributions

Leaderboard and persona bindings draw on upstream PRs [#198](https://github.com/ceifa/steamworks.js/pull/198), [#208](https://github.com/ceifa/steamworks.js/pull/208), [#186](https://github.com/ceifa/steamworks.js/pull/186) and [#211](https://github.com/ceifa/steamworks.js/pull/211). Workshop file types, overlay events, cloud metadata and lobby chat draw on [#191](https://github.com/ceifa/steamworks.js/pull/191), [#205](https://github.com/ceifa/steamworks.js/pull/205), [#207](https://github.com/ceifa/steamworks.js/pull/207) and [#210](https://github.com/ceifa/steamworks.js/pull/210). The [audit](coverage/README.md) identifies additional contributors and compares alternative implementations.
