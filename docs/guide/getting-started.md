# Getting started

## Requirements

- Node.js 14 or later, or Electron.
- A supported platform: Windows x64, Linux x64, macOS x64 or arm64. The package ships
  prebuilt binaries for all four, so you don't need Rust unless you change the library.
- The Steam client, installed, running and signed in, on the machine that runs your game.
  Steam API calls go through the client. Without it, `init()` throws.

```sh
pnpm add @kyeshmz/steamworks.js
```

## Initializing

```js
const steamworks = require('@kyeshmz/steamworks.js')

const client = steamworks.init(480)
```

`init(appId)` calls `SteamAPI_Init`. If it fails, it throws and the message says why.
Usually Steam isn't running, the App ID is unknown, or the account doesn't own the app.

- **App ID:** pass your App ID while developing. 480 is Spacewar, Valve's public test app,
  which every account can run and which has achievements, stats and leaderboards.
- **`steam_appid.txt`:** if you call `init()` without an argument, Steam reads the App ID
  from a `steam_appid.txt` file in the working directory. When the game is launched from
  Steam, neither is needed, and you should not ship `steam_appid.txt`.
- **Launching through Steam:** in release builds, call
  `steamworks.restartAppIfNecessary(appId)` before `init()`. If it returns `true`, Steam is
  relaunching the game through itself and you should exit.

`init()` also starts a timer that runs Steam's callbacks about 30 times a second
(`SteamAPI_RunCallbacks`) and delivers them to your handlers. Callback handlers and Promises
from both APIs rely on it. Keep the process alive; there is nothing else to pump.

The returned `client` holds the [high-level API](high-level-api.md) namespaces and
`client.sdk`, the [1:1 SDK layer](sdk.md). `steamworks.sdk` is the same object.

## Choosing an API

```js
// High-level: JavaScript-shaped results
client.achievement.activate('ACH_WIN_ONE_GAME')

// SDK layer: Valve's names and semantics
client.sdk.SteamUserStats.SetAchievement('ACH_WIN_ONE_GAME')
client.sdk.SteamUserStats.StoreStats()
```

Use the high-level API where it covers what you need. Use the SDK layer for anything it
doesn't, or when you want to follow Valve's documentation literally. They share one Steam
client, so you can mix them.

## Electron

Initialize Steam in the main process. Expose only what the renderer needs through a preload
script with context isolation, as the [Electron example](../../test/electron) does. For the
Steam overlay, call this at the end of `main.js`:

```js
require('@kyeshmz/steamworks.js').electronEnableSteamOverlay()
```

It turns on in-process GPU, turns off direct composition, and repaints windows every frame so
the overlay has something to draw on. Pass `true` to skip the per-frame repaint.

## Packaging

The native files live under `node_modules/@kyeshmz/steamworks.js/dist/<platform>/`: the
`.node` addon next to Valve's `steam_api64.dll`, `libsteam_api.so` or `libsteam_api.dylib`.

- **Keep them on disk.** Native modules can't load from inside an asar archive, so unpack
  `dist/` (for example `asarUnpack: ['**/node_modules/@kyeshmz/steamworks.js/dist/**']` in
  electron-builder).
- **Keep them together.** The addon finds the Steam library next to itself (on Linux through
  an `$ORIGIN` rpath), so keep each platform's folder intact.
- **Ship only the folders you need.** Leave out the platforms you don't target.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `init()` throws "Steam is not running" or `SteamAPI_IsSteamRunning() did not locate a running instance of Steam` | Start the Steam client and sign in. |
| `init()` throws about the App ID | Pass an App ID, add `steam_appid.txt`, or launch through Steam. |
| `init()` fails for your own App ID but works with 480 | The signed-in account does not own the app, or the app is not set up in Steamworks yet. |
| An `sdk` call throws `... needs init() first` | Call `init()` (or `initGameServer()` for `SteamGameServer*` accessors) first. |
| An `sdk` call throws `... is not available from JavaScript` | See [coverage](../sdk/coverage.md) for the reason and the alternative. |
| A Promise never settles | Something stopped the callback timer, or the process exited first. |
| The overlay does not appear in Electron | Call `electronEnableSteamOverlay()`. On Linux, overlay rendering in Electron is unreliable: see upstream issue [#195](https://github.com/ceifa/steamworks.js/issues/195). |
| Achievements or stats don't change | They must be configured and published in Steamworks, and changes need `StoreStats()`. `init()` already calls `RequestCurrentStats`; wait for `UserStatsReceived_t` before reading stats right after startup. |
