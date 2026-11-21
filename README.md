[![Build Status](https://github.com/kyeshmz/steamworks.js/actions/workflows/publish.yml/badge.svg)](https://github.com/kyeshmz/steamworks.js/actions/workflows/publish.yml)
[![npm](https://img.shields.io/npm/v/@kyeshmz/steamworks.js.svg)](https://npmjs.com/package/@kyeshmz/steamworks.js)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Chat](https://img.shields.io/discord/663831597690257431?label=chat&logo=discord)](https://discord.gg/H6B7UE7fMY)

# Steamworks.js

This fork tracks [actionable upstream issues](https://github.com/kyeshmz/steamworks.js/issues/1). The `steamworks.js` package on npm is the upstream release.

The [fork and issue audit](docs/coverage/README.md) compares implementations and lists remaining work. See [the fork feature guide](docs/fork-features.md) for the APIs available here and their verification status.

A modern implementation of the Steamworks SDK for HTML/JS and NodeJS based applications.

This fork has two APIs:

- **High-level API:** `client.achievement`, `client.matchmaking`, `client.workshop` and the
  other namespaces from upstream, plus the features listed in the [fork feature guide](docs/fork-features.md).
- **1:1 SDK layer** (`client.sdk`): the whole Steamworks SDK under its C++ names, generated from
  Valve's `steam_api.json`.
  - **Coverage:** every interface, struct, callback, enum and constant. 941 of the 953 methods
    on exposed interfaces and structs are callable: 908 generated and 33 hand-written. The other
    46 flat methods belong to `ISteamClient` and the C++ response interfaces, which are not
    exposed; you implement the response interfaces as plain objects. The [coverage page](docs/sdk/coverage.md) gives the reason for each method that is
    not callable.
  - **Documentation:** one reference page per interface, with Valve's header comments.

Start with the [documentation index](docs/README.md).

## Why

I used [greenworks](https://github.com/greenheartgames/greenworks) for a long time and it's great, but I gave up for the following reasons.

* It's not being maintained anymore.
* It's not up to date.
* It's not context-aware.
* You have to build the binaries by yourself.
* Don't have typescript definitions.
* The API it's not trustful.
* The API implement callbacks instead of return flags or promises.
* I hate C++.

## API

```js
const steamworks = require('@kyeshmz/steamworks.js')

// You can pass an appId, or don't pass anything and use a steam_appid.txt file
const client = steamworks.init(480)

// Print Steam username
console.log(client.localplayer.getName())

// Tries to activate an achievement
if (client.achievement.activate('ACHIEVEMENT')) {
    // ...
}
```

See the [high-level API reference](docs/guide/high-level-api.md) and the [TypeScript declarations](client.d.ts).

The same things through the SDK layer, with Valve's names and semantics:

```js
const { sdk } = client

console.log(sdk.SteamFriends.GetPersonaName())

if (sdk.SteamUserStats.SetAchievement('ACHIEVEMENT')) {
    sdk.SteamUserStats.StoreStats()
}

// Outputs come back in a result object; call results are Promises.
const { result, pData } = sdk.SteamUserStats.GetStatInt32('NumGames')
const board = await sdk.SteamUserStats.FindLeaderboard('Feet Traveled')

sdk.on('GameOverlayActivated_t', (event) => console.log('overlay active:', event.m_bActive))
```

Read [the SDK layer guide](docs/guide/sdk.md) for how C++ types, out parameters, buffers,
structs, call results and callbacks map to JavaScript. Every method is in the
[generated reference](docs/sdk/README.md).

## Installation

To use steamworks.js you don't have to build anything, just install it from npm:

```sh
pnpm add @kyeshmz/steamworks.js
```

### Electron

Initialize Steam in the Electron main process. Expose only the operations the renderer needs through a sandboxed [preload](test/electron/preload.js) and [main-process handlers](test/electron/main.js). The example keeps context isolation enabled and Node integration disabled.

To make the steam overlay working, call the `electronEnableSteamOverlay` on the end of your `main.js` file:

```js
require('@kyeshmz/steamworks.js').electronEnableSteamOverlay()
```

For the production build, copy the relevant distro files from `sdk/redistributable_bin/{YOUR_DISTRO}` into the root of your build. If you are using electron-forge, look for [#75](https://github.com/ceifa/steamworks.js/issues/75).


## How to build

> You **only** need to build if you are going to change something on steamworks.js code, if you are looking to just consume the library or use it in your game, refer to the [installation section](#installation).

Make sure you have the latest [node.js](https://nodejs.org/en/), [Rust](https://www.rust-lang.org/tools/install) and [Clang](https://rust-lang.github.io/rust-bindgen/requirements.html). We also need [Steam](https://store.steampowered.com/about/) installed and running.

From the repository root, run `corepack enable`, `pnpm install --frozen-lockfile`, and `pnpm run build:debug` to build the library.

Run `pnpm run test:sdk` to check the SDK layer without Steam, and `node test/sdk-readonly.js 480` with a signed-in Steam client. The SDK layer's Rust, JavaScript, declarations and reference docs are generated: after changing the generator or updating steamworks-rs, run `pnpm run generate`. See [maintaining the SDK layer](docs/guide/maintaining.md).

CI builds for Linux x64, Windows x64, and both macOS architectures.

## Releases

Use Conventional Commits (`fix:`, `feat:`, or `feat!:`). After CI passes on `main`, Release Please opens or updates a PR with the version and [changelog](CHANGELOG.md). Merging the release PR creates a GitHub release and publishes the tested tarball to npm.

For the first publication, configure the repository secret `NPM_TOKEN` with publish access to `@kyeshmz/steamworks.js`. After the package exists, configure npm trusted publishing for `kyeshmz/steamworks.js`, workflow `publish.yml`, and remove the bootstrap token. A failed npm publication can be retried by dispatching the Publish workflow on the existing release tag.

### Testing Electron

After building, run `pnpm --dir test/electron start` to launch the [Electron example](./test/electron).

Click "activate overlay" to test the overlay.
