# High-level API reference

`init()` returns a client object with one property per namespace on this page, plus
`client.sdk`. This page lists everything those namespaces export, what each function does,
and which Steamworks SDK calls it makes. Signatures are copied, sometimes shortened, from
[`client.d.ts`](../../client.d.ts) and [`callbacks.d.ts`](../../callbacks.d.ts). The
behaviour notes come from the Rust sources in [`src/api/`](../../src/api/) and the vendored
steamworks-rs crate in [`vendor/steamworks/`](../../vendor/steamworks/), which most functions
call into.

The **Wraps** columns link to the [generated SDK reference](../sdk/README.md). Each link is
the method you would call through the [1:1 SDK layer](sdk.md) to do the same thing yourself.
Each namespace names its main interface; links to methods of other interfaces carry the
interface name.

Namespaces, in the order of `client.d.ts`:
[`achievement`](#achievement) ·
[`apps`](#apps) ·
[`auth`](#auth) ·
[`callback`](#callback) ·
[`cloud`](#cloud) ·
[`friends`](#friends) ·
[`input`](#input) ·
[`inventory`](#inventory) ·
[`leaderboards`](#leaderboards) ·
[`localplayer`](#localplayer) ·
[`matchmaking`](#matchmaking) ·
[`networking`](#networking) ·
[`networking_messages`](#networking_messages) ·
[`overlay`](#overlay) ·
[`screenshots`](#screenshots) ·
[`stats`](#stats) ·
[`utils`](#utils) ·
[`workshop`](#workshop)

## Setup

[Getting started](getting-started.md) covers requirements, packaging and troubleshooting.
In short:

```js
const steamworks = require('@kyeshmz/steamworks.js')

// Pass your App ID, or omit it and provide steam_appid.txt
const client = steamworks.init(480)

console.log(client.localplayer.getName())
```

### `init(appId?)`

- Initializes the Steam API (`SteamAPI_InitFlat`) and returns the client. If that fails, it
  throws an `Error` with Steam's message, for example when the Steam client isn't running.
- With `appId`, it first sets the `SteamAppId` and `SteamGameId` environment variables of
  the process. Without it, the Steam API reads the App ID from `steam_appid.txt`, a file in
  the working directory that contains only the number. Use either one during development
  only. A game that Steam launches needs neither.
- It calls `ISteamUserStats::RequestCurrentStats` once. Stats and achievements become
  readable when Steam answers with `UserStatsReceived_t`. Until then the `stats` and
  `achievement` getters return `null` or `false`.
- Calling `init()` again drops the previous client before initializing. Pending SDK-layer
  call results are rejected with "Steam was re-initialized".
- It starts a `setInterval` of 1000/30 ms (about 30 Hz). Each tick runs Steam's callbacks
  (the native `runCallbacks`) and then pumps the SDK layer. Every callback handler and every
  `Promise` in both APIs is settled from this loop. The interval keeps Node running, and the
  package exports no way to stop it. End the process yourself when you're done
  (`process.exit()`, or `app.quit()` in Electron).

### `restartAppIfNecessary(appId)`

Calls `SteamAPI_RestartAppIfNecessary`. Call it before `init()` in release builds. If it
returns `true`, Steam didn't start the game and is now relaunching it, so exit right away.
It returns `false` when the game can keep running. Per Valve's documentation, that includes
when `steam_appid.txt` is present.

### Electron

Call `init()` in the main process. The [Electron example](../../test/electron) keeps
`contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`. It gives the
renderer only what it needs, through a preload script and `ipcMain.handle`:

```js
// main.js
const client = steamworks.init(480)
ipcMain.handle('steam:player-name', () => client.localplayer.getName())

// preload.js
contextBridge.exposeInMainWorld('steam', {
    playerName: () => ipcRenderer.invoke('steam:player-name'),
})
```

You can also `require` the package directly in a renderer, which is the setup upstream
steamworks.js documented. The window then needs `nodeIntegration: true` and
`contextIsolation: false`, which gives the page full Node access. The example avoids this.

`electronEnableSteamOverlay(disableEachFrameInvalidation?)` adds the Chromium switches
`in-process-gpu` and `disable-direct-composition`. Unless you pass `true`, it also
invalidates every `BrowserWindow`, existing and future, every 1000/60 ms while the window
isn't painting, so the overlay has frames to draw on. Call it at the top level of the main
script, before the app is ready. The example calls it at the end of `main.js`.

### Conventions

- **Examples** assume a `client` from `init()`. Those that use `await` must run inside an
  `async` function, because the package is CommonJS.
- **64-bit values are `bigint`**: Steam IDs, lobby IDs, Workshop item IDs, input handles
  and byte counts. Pass a `bigint` literal (`…n`) or `BigInt(value)`. Passing a `number`
  where the declarations say `bigint` throws. Functions that validate IDs say so below. The
  others use the low 64 bits of the `bigint` you pass.
- **Enums** are `const enum`s in the declarations and plain objects at runtime, on their
  namespace, for example `client.leaderboards.LeaderboardSortMethod.Descending`. Most hold
  numbers. `input.InputType` holds strings. Some TypeScript setups can't inline `const enum`s
  from declaration files, for example with `isolatedModules`. In those, read the values from
  the runtime objects.
- **Sync and async.** A function that returns a `Promise` starts a Steam call result or
  waits for a callback, and it settles from the callback loop. Some time out, as noted per
  function. The others wait as long as Steam takes.
- **Errors.** Invalid arguments throw, or reject, with an `Error` message. Many getters
  return `null` or `false` instead of throwing when Steam has no data.
- **Panics.** A Rust panic inside a synchronous call isn't converted to a JavaScript
  exception, so it aborts the process. Only `friends.getAvatar` and `friends.getPersona`
  catch panics. The namespace functions assume `init()` has succeeded, and calling one
  before that is one way to cause a panic. In `async` functions, napi-rs catches the panic
  and rejects the promise, usually with "Panic in async function". The notes below say where
  ordinary input can cause a panic.

## High-level API or SDK layer?

Use the high-level API for common tasks. It takes and returns JavaScript-shaped values
(`bigint` IDs, `Buffer`s, plain objects, Promises), validates many arguments, and combines
several SDK calls where that's the usual pattern. For example, `achievement.activate` also
stores the stats, and `leaderboards.uploadLeaderboardScore` finds or creates the board before
uploading.

Use the [SDK layer](sdk.md) (`client.sdk`, also `require('@kyeshmz/steamworks.js').sdk`)
when:

- you need a method the high-level API lacks, such as
  [`ISteamUserStats::IndicateAchievementProgress`](../sdk/interfaces/ISteamUserStats.md#indicateachievementprogress),
  [`ISteamUser::BeginAuthSession`](../sdk/interfaces/ISteamUser.md#beginauthsession), owned
  inventory items, or game servers;
- you want exact SDK semantics, such as raw return values, `EResult` codes, out parameters,
  or callbacks the high-level API doesn't expose;
- you want to apply Valve's documentation literally, method by method.

Both share one Steam client and one callback loop, so you can mix them in the same process.
The SDK layer sees every callback even when a high-level handler is registered for it.

```js
const client = require('@kyeshmz/steamworks.js').init(480)

client.achievement.activate('ACH_WIN_ONE_GAME')                                       // high-level
client.sdk.SteamUserStats.IndicateAchievementProgress('ACH_WIN_100_GAMES', 10, 100)  // SDK layer
```

## Top-level exports

The package entry point (`index.js`) exports `init`, `restartAppIfNecessary`,
`electronEnableSteamOverlay`, `SteamCallback`, `initGameServer`, `shutdownGameServer` and
`sdk`. The top level of `client.d.ts` declares the native `init`, `restartAppIfNecessary`,
`runCallbacks` and the `PlayerSteamId` type.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `init` | `init(appId?: number): Client & { sdk }` | Initializes Steam, starts the callback loop and returns the namespaces plus `sdk`. See [Setup](#initappid). The native `init` in `client.d.ts` returns `void`; the package's wrapper returns the client. | `SteamAPI_InitFlat`, [`ISteamUserStats::RequestCurrentStats`](../sdk/interfaces/ISteamUserStats.md#requestcurrentstats) |
| `restartAppIfNecessary` | `restartAppIfNecessary(appId: number): boolean` | `true` means Steam is relaunching the game, so exit. Doesn't need `init()`. | [`SteamAPI_RestartAppIfNecessary`](https://partner.steamgames.com/doc/api/steam_api#SteamAPI_RestartAppIfNecessary) |
| `runCallbacks` | `runCallbacks(): void` | Declared in `client.d.ts` but not exported by the package, and removed from the object `init()` returns. The `init()` loop calls it. It runs pending client callbacks, then game server callbacks if `initGameServer()` was called. | `SteamAPI_ManualDispatch_RunFrame`, `SteamAPI_ManualDispatch_GetNextCallback` |
| `PlayerSteamId` | `{ steamId64: bigint; steamId32: string; accountId: number }` | How the high-level API returns a Steam ID. `steamId32` is the text form `STEAM_0:X:Y` built from the account ID. `accountId` is the 32-bit account ID, which `workshop.getUserItems` takes. | Pure Rust conversion from a `CSteamID` |
| `electronEnableSteamOverlay` | `electronEnableSteamOverlay(disableEachFrameInvalidation?: boolean): void` | Electron only. See [Electron](#electron). | Pure JS |
| `SteamCallback` | `const enum` | The same object as `client.callback.SteamCallback`, so you can use it without a client. | — |
| `initGameServer` | `initGameServer(unIP, usGamePort, usQueryPort, eServerMode, pchVersionString): void` | Initializes the game server API for the SDK layer's `SteamGameServer*` accessors and restarts the callback loop. See [Game servers](sdk.md#game-servers). | [`SteamGameServer_Init`](https://partner.steamgames.com/doc/api/steam_gameserver#SteamGameServer_Init) |
| `shutdownGameServer` | `shutdownGameServer(): void` | Shuts the game server API down and rejects its pending SDK call results. | [`SteamGameServer_Shutdown`](https://partner.steamgames.com/doc/api/steam_gameserver#SteamGameServer_Shutdown) |
| `sdk` | object | The 1:1 SDK layer, the same object as `client.sdk`. See [the SDK guide](sdk.md). | — |

## `achievement`

Unlocks, clears and reads achievements through `ISteamUserStats`. It needs a signed-in Steam
client and an App ID whose achievements are configured and published in Steamworks. App 480
(Spacewar) has `ACH_WIN_ONE_GAME` and others. Reads work once Steam has delivered the user's
stats, which `init()` requests. Every function returns `false` or `null`, without calling
Steam, for a name that contains NUL.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `activate` | `activate(achievement: string): boolean` | Unlocks the achievement, then calls `StoreStats` so Steam saves it. Returns `true` only if both calls succeed. Returns `false` for an unknown name or if stats aren't loaded yet. | [`SetAchievement`](../sdk/interfaces/ISteamUserStats.md#setachievement), [`StoreStats`](../sdk/interfaces/ISteamUserStats.md#storestats) |
| `isActivated` | `isActivated(achievement: string): boolean` | `true` if unlocked. A failed call also returns `false`, so an unknown name looks the same as a locked achievement. | [`GetAchievement`](../sdk/interfaces/ISteamUserStats.md#getachievement) |
| `clear` | `clear(achievement: string): boolean` | Locks the achievement again, then calls `StoreStats`. Returns `true` only if both calls succeed. | [`ClearAchievement`](../sdk/interfaces/ISteamUserStats.md#clearachievement), [`StoreStats`](../sdk/interfaces/ISteamUserStats.md#storestats) |
| `names` | `names(): string[]` | API names of all achievements, in Steam's index order. `[]` if Steam reports none. | [`GetNumAchievements`](../sdk/interfaces/ISteamUserStats.md#getnumachievements), [`GetAchievementName`](../sdk/interfaces/ISteamUserStats.md#getachievementname) |
| `getDisplayAttribute` | `getDisplayAttribute(achievement: string, key: string): string \| null` | Localized text for `key`, which must be `"name"`, `"desc"` or `"hidden"`. For `"hidden"`, the value is `"0"` or `"1"`. Any other key returns `null` without calling Steam. Also returns `null` when Steam returns an empty string. | [`GetAchievementDisplayAttribute`](../sdk/interfaces/ISteamUserStats.md#getachievementdisplayattribute) |
| `getIcon` | `getIcon(achievement: string): Buffer \| null` | The icon as 64×64 RGBA pixels (16384 bytes). `null` if the image isn't 64×64, or if Steam hasn't fetched the icon yet. In that case Steam posts `UserAchievementIconFetched_t`; call again later. | [`GetAchievementIcon`](../sdk/interfaces/ISteamUserStats.md#getachievementicon), [`ISteamUtils::GetImageSize`](../sdk/interfaces/ISteamUtils.md#getimagesize), [`ISteamUtils::GetImageRGBA`](../sdk/interfaces/ISteamUtils.md#getimagergba) |
| `requestGlobalPercentages` | `requestGlobalPercentages(): Promise<void>` | Fetches the global unlock percentages for all achievements. Resolves when Steam answers. Rejects on an I/O failure or after 30 seconds. It doesn't check the call's `m_eResult`, so it can resolve without data, and `getAchievedPercent` then returns `null`. | [`RequestGlobalAchievementPercentages`](../sdk/interfaces/ISteamUserStats.md#requestglobalachievementpercentages) |
| `getAchievedPercent` | `getAchievedPercent(achievement: string): number \| null` | Percentage of players (0–100) who unlocked the achievement, from the data `requestGlobalPercentages` fetched. `null` if Steam has no data. | [`GetAchievementAchievedPercent`](../sdk/interfaces/ISteamUserStats.md#getachievementachievedpercent) |

Achievements and [stats](#stats) together:

```js
const client = require('@kyeshmz/steamworks.js').init(480)

// activate() unlocks and calls StoreStats itself
if (client.achievement.activate('ACH_WIN_ONE_GAME')) console.log('unlocked')

// Stat setters only change the local copy until store() uploads them
const games = client.stats.getInt('NumGames')
if (games !== null) {
    client.stats.setInt('NumGames', games + 1)
    client.stats.store()
}

// Global percentages need a separate request
await client.achievement.requestGlobalPercentages()
console.log(client.achievement.getAchievedPercent('ACH_WIN_ONE_GAME'))
```

Right after `init()`, the user's stats may still be loading, and `getInt` returns `null`.
Retry later, or wait for `UserStatsReceived_t` with `sdk.on`.

## `apps`

Ownership, DLC, install, language and launch information from `ISteamApps`. It needs a
signed-in Steam client. The DLC functions need DLC configured for the app. `listDlc`,
`installDlc`, `uninstallDlc`, `getDlcDownloadProgress` and `launchQueryParam` throw "Steam
apps interface unavailable" if Steam doesn't provide the interface.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `listDlc` | `listDlc(): DlcInfo[]` | One entry per DLC index. Entries Steam fails to read are skipped. Names longer than 1023 bytes are cut. | [`GetDLCCount`](../sdk/interfaces/ISteamApps.md#getdlccount), [`BGetDLCDataByIndex`](../sdk/interfaces/ISteamApps.md#bgetdlcdatabyindex) |
| `installDlc` | `installDlc(appId: number): void` | Starts downloading an owned DLC in the background. | [`InstallDLC`](../sdk/interfaces/ISteamApps.md#installdlc) |
| `uninstallDlc` | `uninstallDlc(appId: number): void` | Uninstalls a DLC. | [`UninstallDLC`](../sdk/interfaces/ISteamApps.md#uninstalldlc) |
| `getDlcDownloadProgress` | `getDlcDownloadProgress(appId: number): DlcDownloadProgress \| null` | Bytes downloaded and total. `null` when the DLC isn't downloading. | [`GetDlcDownloadProgress`](../sdk/interfaces/ISteamApps.md#getdlcdownloadprogress) |
| `launchQueryParam` | `launchQueryParam(key: string): string` | Value of a query parameter from the `steam://run` URL that launched the game. `''` if it's missing. Throws if `key` contains NUL. | [`GetLaunchQueryParam`](../sdk/interfaces/ISteamApps.md#getlaunchqueryparam) |
| `launchCommandLine` | `launchCommandLine(): string` | Command line passed through a `steam://run` URL. `''` if there is none. At most 255 bytes are read. | [`GetLaunchCommandLine`](../sdk/interfaces/ISteamApps.md#getlaunchcommandline) |
| `isSubscribedApp` | `isSubscribedApp(appId: number): boolean` | Whether the user owns that app. | [`BIsSubscribedApp`](../sdk/interfaces/ISteamApps.md#bissubscribedapp) |
| `isAppInstalled` | `isAppInstalled(appId: number): boolean` | Whether that app is installed. | [`BIsAppInstalled`](../sdk/interfaces/ISteamApps.md#bisappinstalled) |
| `isDlcInstalled` | `isDlcInstalled(appId: number): boolean` | Whether that DLC is owned and installed. | [`BIsDlcInstalled`](../sdk/interfaces/ISteamApps.md#bisdlcinstalled) |
| `isSubscribedFromFreeWeekend` | `isSubscribedFromFreeWeekend(): boolean` | Whether the license comes from a free weekend. | [`BIsSubscribedFromFreeWeekend`](../sdk/interfaces/ISteamApps.md#bissubscribedfromfreeweekend) |
| `isVacBanned` | `isVacBanned(): boolean` | Whether the user has a VAC ban for this app. | [`BIsVACBanned`](../sdk/interfaces/ISteamApps.md#bisvacbanned) |
| `isCybercafe` | `isCybercafe(): boolean` | Whether this is a cybercafe license. | [`BIsCybercafe`](../sdk/interfaces/ISteamApps.md#biscybercafe) |
| `isLowViolence` | `isLowViolence(): boolean` | Whether the license is for a low-violence version. | [`BIsLowViolence`](../sdk/interfaces/ISteamApps.md#bislowviolence) |
| `isSubscribed` | `isSubscribed(): boolean` | Whether the user owns the current app. | [`BIsSubscribed`](../sdk/interfaces/ISteamApps.md#bissubscribed) |
| `appBuildId` | `appBuildId(): number` | Build ID of the installed build of the current app. | [`GetAppBuildId`](../sdk/interfaces/ISteamApps.md#getappbuildid) |
| `appInstallDir` | `appInstallDir(appId: number): string` | Install folder of an app. According to steamworks-rs, it also returns the default location when the app isn't installed. | [`GetAppInstallDir`](../sdk/interfaces/ISteamApps.md#getappinstalldir) |
| `appOwner` | `appOwner(): PlayerSteamId` | Original owner of the app. It differs from the current user when the app is borrowed. | [`GetAppOwner`](../sdk/interfaces/ISteamApps.md#getappowner) |
| `availableGameLanguages` | `availableGameLanguages(): string[]` | Languages the app supports, split from Steam's comma-separated list. | [`GetAvailableGameLanguages`](../sdk/interfaces/ISteamApps.md#getavailablegamelanguages) |
| `currentGameLanguage` | `currentGameLanguage(): string` | Language the user chose for this game, such as `'english'`. | [`GetCurrentGameLanguage`](../sdk/interfaces/ISteamApps.md#getcurrentgamelanguage) |
| `currentBetaName` | `currentBetaName(): string \| null` | Name of the beta branch. `null` on the default branch. | [`GetCurrentBetaName`](../sdk/interfaces/ISteamApps.md#getcurrentbetaname) |

| Type | Definition | Notes |
|---|---|---|
| `DlcInfo` | `{ appId: number; available: boolean; name: string }` | Returned by `listDlc`. |
| `DlcDownloadProgress` | `{ bytesDownloaded: bigint; bytesTotal: bigint }` | Returned by `getDlcDownloadProgress`. |

## `auth`

Session tickets and Web API tickets from `ISteamUser`. They need a signed-in Steam client.
Validating a ticket isn't in the high-level API. A server
validates it with the Web API (`ISteamUserAuth/AuthenticateUserTicket`), or a peer uses
[`ISteamUser::BeginAuthSession`](../sdk/interfaces/ISteamUser.md#beginauthsession) through
the SDK layer.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `getSessionTicketWithSteamId` | `getSessionTicketWithSteamId(steamId64: bigint, timeoutSeconds = 10): Promise<Ticket>` | Creates a session ticket for the peer or game server with that Steam ID, then waits for Steam's `GetAuthSessionTicketResponse_t` for it. If Steam reports an error, or `timeoutSeconds` pass first, it cancels the ticket and rejects. The timeout message is "Steam didn't validated the ticket in time.". The Steam ID isn't validated. | [`GetAuthSessionTicket`](../sdk/interfaces/ISteamUser.md#getauthsessionticket), [`CancelAuthTicket`](../sdk/interfaces/ISteamUser.md#cancelauthticket) on failure |
| `getSessionTicketWithIp` | `getSessionTicketWithIp(ip: string, timeoutSeconds = 10): Promise<Ticket>` | Same, with an IP identity. The string is parsed as a socket address, so it needs a port: `'192.168.0.5:27015'` or `'[::1]:27015'`. A bare address rejects with a parse error. | [`GetAuthSessionTicket`](../sdk/interfaces/ISteamUser.md#getauthsessionticket), [`CancelAuthTicket`](../sdk/interfaces/ISteamUser.md#cancelauthticket) on failure |
| `getAuthTicketForWebApi` | `getAuthTicketForWebApi(identity: string, timeoutSeconds = 10): Promise<Ticket>` | Requests a ticket for a Web API backend. `identity` is the service name the backend passes to `AuthenticateUserTicket`. It waits for `GetTicketForWebApiResponse_t`, which carries the ticket bytes. Errors and timeouts work as above. | [`GetAuthTicketForWebApi`](../sdk/interfaces/ISteamUser.md#getauthticketforwebapi), [`CancelAuthTicket`](../sdk/interfaces/ISteamUser.md#cancelauthticket) on failure |
| `Ticket` | `class Ticket` | Holds the ticket bytes and Steam's ticket handle. Nothing cancels it automatically. | — |
| `Ticket.cancel` | `cancel(): void` | Invalidates the ticket. Call it when the session ends. | [`CancelAuthTicket`](../sdk/interfaces/ISteamUser.md#cancelauthticket) |
| `Ticket.getBytes` | `getBytes(): Buffer` | A copy of the ticket bytes. Pure Rust. | — |

Request one ticket of each kind at a time. Each request listens for Steam's response with a
steamworks-rs callback handler, and steamworks-rs keeps only one handler per callback type:
`GetAuthSessionTicketResponse_t` for the two session-ticket functions and
`GetTicketForWebApiResponse_t` for the Web API one. If you start a second request of the same
kind before the first resolves, the second replaces the first one's listener. The first then
times out and cancels its ticket.

```js
const ticket = await client.auth.getAuthTicketForWebApi('my-backend')

// Send this to your server, which calls ISteamUserAuth/AuthenticateUserTicket
// with ticket=<hex> and identity=my-backend
const hex = ticket.getBytes().toString('hex')

// When the session is over
ticket.cancel()
```

## `callback`

Subscribes to a fixed set of Steam callbacks. Handlers run on the JavaScript thread, after the
callback loop dispatches the event. To reach callbacks that aren't in this list, use
[`sdk.on`](sdk.md#callbacks).

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `SteamCallback` | `const enum SteamCallback` | Selects the callback. Values and payloads are in the table below. | — |
| `register` | `register<C>(steamCallback: C, handler: (value: CallbackReturns[C]) => void): Handle` | Registers `handler` for that callback type and returns a handle. | steamworks-rs `Client::register_callback`. Steam posts the struct listed below; there is no SDK method. |
| `Handle` | `class Handle` | Returned by `register`. | — |
| `Handle.disconnect` | `disconnect(): void` | Removes the handler for that callback type. Calling it twice is harmless. | — |

There is **one handler per callback type**. If you call `register` twice with the same
`SteamCallback`, the second handler replaces the first. Calling `disconnect()` on either
handle removes whichever handler is current. To have several listeners, register once and
fan out in your own code, or use `sdk.on`.

steamworks-rs builds the payload from Steam's struct, and serde serializes it into a plain
object with snake_case keys. Integers larger than 2^53 − 1 arrive as `bigint`. Smaller
integers arrive as `number`. So Steam IDs and lobby IDs are `bigint` in practice. Enum
fields arrive as their variant names (strings).

| Value | Steam struct | Payload |
|---|---|---|
| `PersonaStateChange` (0) | [`PersonaStateChange_t`](../sdk/callbacks.md#personastatechange_t) | `{ steam_id, flags: { bits } }`. `bits` is the `EPersonaChange` bitmask. |
| `SteamServersConnected` (1) | [`SteamServersConnected_t`](../sdk/callbacks.md#steamserversconnected_t) | Declared as `{}`, but the value is `null`, because the Rust struct has no fields. |
| `SteamServersDisconnected` (2) | [`SteamServersDisconnected_t`](../sdk/callbacks.md#steamserversdisconnected_t) | `{ reason }`. `reason` is declared as `number`, but it arrives as a steamworks-rs `SteamError` variant name such as `'NoConnection'`. |
| `SteamServerConnectFailure` (3) | [`SteamServerConnectFailure_t`](../sdk/callbacks.md#steamserverconnectfailure_t) | `{ reason, still_retrying }`. `reason` is a string, as above. |
| `LobbyDataUpdate` (4) | [`LobbyDataUpdate_t`](../sdk/callbacks.md#lobbydataupdate_t) | `{ lobby, member, success }` |
| `LobbyChatUpdate` (5) | [`LobbyChatUpdate_t`](../sdk/callbacks.md#lobbychatupdate_t) | `{ lobby, user_changed, making_change, member_state_change }`. `member_state_change` is declared as the numeric `ChatMemberStateChange` enum, but it arrives as a string: `'Entered'`, `'Left'`, `'Disconnected'`, `'Kicked'` or `'Banned'`. |
| `P2PSessionRequest` (6) | [`P2PSessionRequest_t`](../sdk/callbacks.md#p2psessionrequest_t) | `{ remote }`. Accept with `networking.acceptP2PSession(remote)`. |
| `P2PSessionConnectFail` (7) | [`P2PSessionConnectFail_t`](../sdk/callbacks.md#p2psessionconnectfail_t) | `{ remote, error }`. `error` is the `EP2PSessionError` number. |
| `GameLobbyJoinRequested` (8) | [`GameLobbyJoinRequested_t`](../sdk/callbacks.md#gamelobbyjoinrequested_t) | `{ lobby_steam_id, friend_steam_id }`. Join with `matchmaking.joinLobby(lobby_steam_id)`. |
| `MicroTxnAuthorizationResponse` (9) | [`MicroTxnAuthorizationResponse_t`](../sdk/callbacks.md#microtxnauthorizationresponse_t) | `{ app_id, order_id, authorized }`. `order_id` is a `number` or a `bigint`, depending on its size. |
| `GameOverlayActivated` (10) | [`GameOverlayActivated_t`](../sdk/callbacks.md#gameoverlayactivated_t) | `{ active }` |
| `LobbyChatMsg` (11) | [`LobbyChatMsg_t`](../sdk/callbacks.md#lobbychatmsg_t) | `{ lobby, user, chat_entry_type, chat_id }`. Read the message with `Lobby.getChatEntry(chat_id)`. `chat_entry_type` is a string such as `'ChatMsg'`. |

```js
const { init, SteamCallback } = require('@kyeshmz/steamworks.js')
const client = init(480)

const overlay = client.callback.register(SteamCallback.GameOverlayActivated, ({ active }) => {
    if (active) pauseGame()
})

// Accept lobby invites from the friends list or the overlay
client.callback.register(SteamCallback.GameLobbyJoinRequested, async ({ lobby_steam_id }) => {
    const lobby = await client.matchmaking.joinLobby(lobby_steam_id)
    console.log('joined', lobby.id)
})

// Later
overlay.disconnect()
```

## `cloud`

Steam Cloud files through `ISteamRemoteStorage`. Steam Cloud must be enabled for the app in
Steamworks, with a byte quota and file count, and for the user's account. File names are
relative to the app's Cloud storage.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `isEnabledForAccount` | `isEnabledForAccount(): boolean` | The user's account-wide Cloud setting. | [`IsCloudEnabledForAccount`](../sdk/interfaces/ISteamRemoteStorage.md#iscloudenabledforaccount) |
| `isEnabledForApp` | `isEnabledForApp(): boolean` | The user's Cloud setting for this game. | [`IsCloudEnabledForApp`](../sdk/interfaces/ISteamRemoteStorage.md#iscloudenabledforapp) |
| `setEnabledForApp` | `setEnabledForApp(enabled: boolean): void` | Changes the user's Cloud setting for this game. | [`SetCloudEnabledForApp`](../sdk/interfaces/ISteamRemoteStorage.md#setcloudenabledforapp) |
| `readFile` | `readFile(name: string): string` | Reads the whole file as UTF-8. A missing file reads as `''`. Throws "Failed to read file: …" on a read error or invalid UTF-8. It blocks the JavaScript thread: each chunk is a `FileReadAsync` call, and the code spins until Steam completes it. | [`GetFileSize`](../sdk/interfaces/ISteamRemoteStorage.md#getfilesize), [`FileReadAsync`](../sdk/interfaces/ISteamRemoteStorage.md#filereadasync), [`FileReadAsyncComplete`](../sdk/interfaces/ISteamRemoteStorage.md#filereadasynccomplete), [`ISteamUtils::IsAPICallCompleted`](../sdk/interfaces/ISteamUtils.md#isapicallcompleted), [`ISteamUtils::GetAPICallResult`](../sdk/interfaces/ISteamUtils.md#getapicallresult) |
| `writeFile` | `writeFile(name: string, content: string): boolean` | Writes `content` as UTF-8, replacing the file. Returns `true` if Steam accepted the data. The result of closing the stream, which commits the file, isn't checked. | [`FileWriteStreamOpen`](../sdk/interfaces/ISteamRemoteStorage.md#filewritestreamopen), [`FileWriteStreamWriteChunk`](../sdk/interfaces/ISteamRemoteStorage.md#filewritestreamwritechunk), [`FileWriteStreamClose`](../sdk/interfaces/ISteamRemoteStorage.md#filewritestreamclose) |
| `deleteFile` | `deleteFile(name: string): boolean` | Deletes the file locally and from the Cloud. `true` if a file was deleted. | [`FileDelete`](../sdk/interfaces/ISteamRemoteStorage.md#filedelete) |
| `fileExists` | `fileExists(name: string): boolean` | Whether the file exists. | [`FileExists`](../sdk/interfaces/ISteamRemoteStorage.md#fileexists) |
| `isFilePersisted` | `isFilePersisted(name: string): boolean` | Whether the file is stored in the Cloud. | [`FilePersisted`](../sdk/interfaces/ISteamRemoteStorage.md#filepersisted) |
| `fileTimestamp` | `fileTimestamp(name: string): number` | Last-modified time, in Unix seconds. | [`GetFileTimestamp`](../sdk/interfaces/ISteamRemoteStorage.md#getfiletimestamp) |
| `readFileBytes` | `readFileBytes(name: string): Promise<Buffer>` | Reads the whole file on a worker thread. Rejects if `name` is empty or contains NUL, if the file doesn't exist, or on a read error. | [`FileExists`](../sdk/interfaces/ISteamRemoteStorage.md#fileexists), [`GetFileSize`](../sdk/interfaces/ISteamRemoteStorage.md#getfilesize), [`FileReadAsync`](../sdk/interfaces/ISteamRemoteStorage.md#filereadasync), [`FileReadAsyncComplete`](../sdk/interfaces/ISteamRemoteStorage.md#filereadasynccomplete) |
| `writeFileBytes` | `writeFileBytes(name: string, data: Buffer): Promise<void>` | Copies `data`, then writes it on a worker thread, replacing the file. Rejects for an empty name, a name containing NUL, or a failed write. | [`FileWriteStreamOpen`](../sdk/interfaces/ISteamRemoteStorage.md#filewritestreamopen), [`FileWriteStreamWriteChunk`](../sdk/interfaces/ISteamRemoteStorage.md#filewritestreamwritechunk), [`FileWriteStreamClose`](../sdk/interfaces/ISteamRemoteStorage.md#filewritestreamclose) |
| `listFiles` | `listFiles(): FileInfo[]` | All of the app's Cloud files, with sizes. | [`GetFileCount`](../sdk/interfaces/ISteamRemoteStorage.md#getfilecount), [`GetFileNameAndSize`](../sdk/interfaces/ISteamRemoteStorage.md#getfilenameandsize) |
| `FileInfo` | `class FileInfo` | One entry from `listFiles`. | — |
| `FileInfo.name` | `name: string` | File name. | — |
| `FileInfo.size` | `size: bigint` | Size in bytes. | — |

The synchronous file functions (`readFile`, `writeFile`, `deleteFile`, `fileExists`,
`isFilePersisted`, `fileTimestamp`) don't check names for NUL. A name containing `\0`
panics and aborts the process. For names you don't control, use `readFileBytes` and
`writeFileBytes`, which reject instead.

## `friends`

The friends list, persona names, states and avatars, through `ISteamFriends`. It needs a
signed-in Steam client. If Steam has no data on a user yet, call `requestUserInformation`
first, then wait for `SteamCallback.PersonaStateChange`. Every function that takes a Steam ID
throws "Expected a nonzero unsigned 64-bit Steam ID" for zero, negative or oversized values.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `getFriends` | `getFriends(): bigint[]` | Steam IDs of immediate friends (`k_EFriendFlagImmediate`), without pending invitations. | [`GetFriendCount`](../sdk/interfaces/ISteamFriends.md#getfriendcount), [`GetFriendByIndex`](../sdk/interfaces/ISteamFriends.md#getfriendbyindex) |
| `getPersonaName` | `getPersonaName(steamId64: bigint): string` | The user's persona name. | [`GetFriendPersonaName`](../sdk/interfaces/ISteamFriends.md#getfriendpersonaname) |
| `getAvatar` | `getAvatar(steamId64: bigint, size: AvatarSize): Buffer \| null` | RGBA pixels: 32×32 (`Small`), 64×64 (`Medium`) or 184×184 (`Large`). `null` when Steam has no image loaded. steamworks-rs asserts the image size, and this function catches that panic, so an unexpected size throws instead of crashing. | [`GetSmallFriendAvatar`](../sdk/interfaces/ISteamFriends.md#getsmallfriendavatar), [`GetMediumFriendAvatar`](../sdk/interfaces/ISteamFriends.md#getmediumfriendavatar), [`GetLargeFriendAvatar`](../sdk/interfaces/ISteamFriends.md#getlargefriendavatar), [`ISteamUtils::GetImageSize`](../sdk/interfaces/ISteamUtils.md#getimagesize), [`ISteamUtils::GetImageRGBA`](../sdk/interfaces/ISteamUtils.md#getimagergba) |
| `getPersona` | `getPersona(steamId64: bigint): Persona` | Name, state and medium avatar in one call. `state` is one of `online`, `offline`, `busy`, `away`, `snooze`, `lookingToTrade` or `lookingToPlay`. Throws if Steam reports a state steamworks-rs doesn't map, such as Invisible, or a medium avatar that isn't 64×64. The panic is caught. | [`GetFriendPersonaName`](../sdk/interfaces/ISteamFriends.md#getfriendpersonaname), [`GetFriendPersonaState`](../sdk/interfaces/ISteamFriends.md#getfriendpersonastate), [`GetMediumFriendAvatar`](../sdk/interfaces/ISteamFriends.md#getmediumfriendavatar), [`ISteamUtils::GetImageSize`](../sdk/interfaces/ISteamUtils.md#getimagesize), [`ISteamUtils::GetImageRGBA`](../sdk/interfaces/ISteamUtils.md#getimagergba) |
| `requestUserInformation` | `requestUserInformation(steamId64: bigint, nameOnly = true): boolean` | Asks Steam to fetch the user's name, and the avatar too when `nameOnly` is `false`. Returns `true` if Steam started a request, which a `PersonaStateChange` callback follows. Returns `false` if the data is already cached. | [`RequestUserInformation`](../sdk/interfaces/ISteamFriends.md#requestuserinformation) |

| Type | Definition | Notes |
|---|---|---|
| `Persona` | `{ name: string; state: string; mediumAvatar?: Buffer }` | `mediumAvatar` is 64×64 RGBA, absent when Steam has no image. |
| `AvatarSize` | `Small = 0, Medium = 1, Large = 2` | |

## `input`

Steam Input through `ISteamInput`. It needs a connected controller and an action manifest,
either the configuration set up for the app in Steamworks or a manifest file passed to
`setInputActionManifestFilePath`. Call `client.input.init()` (this namespace's `init`, not the
top-level one) before anything else, and `shutdown()` when you're done.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `init` | `init(): void` | Initializes Steam Input with `bExplicitlyCallRunFrame = false`. The result is ignored. | [`Init`](../sdk/interfaces/ISteamInput.md#init) |
| `getControllers` | `getControllers(): Controller[]` | Connected controllers, up to 16. | [`GetConnectedControllers`](../sdk/interfaces/ISteamInput.md#getconnectedcontrollers) |
| `getActionSet` | `getActionSet(actionSetName: string): bigint` | Handle of an action set in the manifest. | [`GetActionSetHandle`](../sdk/interfaces/ISteamInput.md#getactionsethandle) |
| `getDigitalAction` | `getDigitalAction(actionName: string): bigint` | Handle of a digital action (a button). | [`GetDigitalActionHandle`](../sdk/interfaces/ISteamInput.md#getdigitalactionhandle) |
| `getAnalogAction` | `getAnalogAction(actionName: string): bigint` | Handle of an analog action (a stick or trigger). | [`GetAnalogActionHandle`](../sdk/interfaces/ISteamInput.md#getanalogactionhandle) |
| `getGlyphForActionOrigin` | `getGlyphForActionOrigin(origin: number): string` | Path to Steam's legacy glyph image for an `EInputActionOrigin`. `''` if Steam returns none. Throws "Unknown Steam Input action origin" unless `origin` is an integer from 0 to 405. The other glyph functions and `getStringForActionOrigin` check `origin` the same way. | [`GetGlyphForActionOrigin_Legacy`](../sdk/interfaces/ISteamInput.md#getglyphforactionorigin_legacy) |
| `getGlyphPngForActionOrigin` | `getGlyphPngForActionOrigin(origin: number, size: GlyphSize, flags = 0): string` | Path to a PNG glyph at that size. `flags` is the `ESteamInputGlyphStyle` bitmask. | [`GetGlyphPNGForActionOrigin`](../sdk/interfaces/ISteamInput.md#getglyphpngforactionorigin) |
| `getGlyphSvgForActionOrigin` | `getGlyphSvgForActionOrigin(origin: number, flags = 0): string` | Path to an SVG glyph. | [`GetGlyphSVGForActionOrigin`](../sdk/interfaces/ISteamInput.md#getglyphsvgforactionorigin) |
| `getStringForActionOrigin` | `getStringForActionOrigin(origin: number): string` | Localized name of the origin, for button prompts. | [`GetStringForActionOrigin`](../sdk/interfaces/ISteamInput.md#getstringforactionorigin) |
| `setInputActionManifestFilePath` | `setInputActionManifestFilePath(path: string): boolean` | Loads an action manifest from an absolute path, for games that ship their configuration in the depot. Throws if `path` contains NUL. | [`SetInputActionManifestFilePath`](../sdk/interfaces/ISteamInput.md#setinputactionmanifestfilepath) |
| `runFrame` | `runFrame(): void` | Synchronizes controller state with Steam. | [`RunFrame`](../sdk/interfaces/ISteamInput.md#runframe) |
| `shutdown` | `shutdown(): void` | Shuts Steam Input down. | [`Shutdown`](../sdk/interfaces/ISteamInput.md#shutdown) |
| `Controller` | `class Controller` | One connected controller, from `getControllers()`. | — |
| `Controller.activateActionSet` | `activateActionSet(actionSetHandle: bigint): void` | Switches the controller to an action set. | [`ActivateActionSet`](../sdk/interfaces/ISteamInput.md#activateactionset) |
| `Controller.isDigitalActionPressed` | `isDigitalActionPressed(actionHandle: bigint): boolean` | `bState` of the digital action. | [`GetDigitalActionData`](../sdk/interfaces/ISteamInput.md#getdigitalactiondata) |
| `Controller.getAnalogActionVector` | `getAnalogActionVector(actionHandle: bigint): AnalogActionVector` | `x` and `y` of the analog action. | [`GetAnalogActionData`](../sdk/interfaces/ISteamInput.md#getanalogactiondata) |
| `Controller.getType` | `getType(): InputType` | Controller type, as a string. | [`GetInputTypeForHandle`](../sdk/interfaces/ISteamInput.md#getinputtypeforhandle) |
| `Controller.getHandle` | `getHandle(): bigint` | The controller's `InputHandle_t`. Pure Rust. | — |
| `Controller.getDigitalActionOrigins` | `getDigitalActionOrigins(actionSet: bigint, action: bigint): number[]` | Up to 8 origins bound to a digital action in an action set, as raw `EInputActionOrigin` numbers, including values newer than this binding knows. Throws for a negative handle or one wider than 64 bits. | [`GetDigitalActionOrigins`](../sdk/interfaces/ISteamInput.md#getdigitalactionorigins) |
| `Controller.getAnalogActionOrigins` | `getAnalogActionOrigins(actionSet: bigint, action: bigint): number[]` | Same, for an analog action. | [`GetAnalogActionOrigins`](../sdk/interfaces/ISteamInput.md#getanalogactionorigins) |
| `Controller.showBindingPanel` | `showBindingPanel(): boolean` | Opens the Steam Input binding screen for this controller. `false` if Steam couldn't open it. | [`ShowBindingPanel`](../sdk/interfaces/ISteamInput.md#showbindingpanel) |
| `Controller.getCurrentActionSet` | `getCurrentActionSet(): bigint` | Handle of the active action set. | [`GetCurrentActionSet`](../sdk/interfaces/ISteamInput.md#getcurrentactionset) |
| `Controller.activateActionSetLayer` | `activateActionSetLayer(layer: bigint): void` | Adds an action set layer. Throws for an invalid handle, as the origin functions do. | [`ActivateActionSetLayer`](../sdk/interfaces/ISteamInput.md#activateactionsetlayer) |
| `Controller.deactivateActionSetLayer` | `deactivateActionSetLayer(layer: bigint): void` | Removes an action set layer. | [`DeactivateActionSetLayer`](../sdk/interfaces/ISteamInput.md#deactivateactionsetlayer) |
| `Controller.deactivateAllActionSetLayers` | `deactivateAllActionSetLayers(): void` | Removes all layers. | [`DeactivateAllActionSetLayers`](../sdk/interfaces/ISteamInput.md#deactivateallactionsetlayers) |
| `Controller.getActiveActionSetLayers` | `getActiveActionSetLayers(): bigint[]` | Up to 16 active layer handles. | [`GetActiveActionSetLayers`](../sdk/interfaces/ISteamInput.md#getactiveactionsetlayers) |
| `Controller.triggerVibration` | `triggerVibration(leftSpeed: number, rightSpeed: number): void` | Rumble motor speeds, from 0 (stop) to 65535. | [`TriggerVibration`](../sdk/interfaces/ISteamInput.md#triggervibration) |
| `Controller.triggerSimpleHapticEvent` | `triggerSimpleHapticEvent(location: HapticLocation, intensity: number, gainDb: number, otherIntensity: number, otherGainDb: number): void` | Haptic pulse on Steam Deck or Steam Controller. The intensities are unsigned 8-bit; the gains are signed 8-bit, in dB. | [`TriggerSimpleHapticEvent`](../sdk/interfaces/ISteamInput.md#triggersimplehapticevent) |

| Type | Definition | Notes |
|---|---|---|
| `GlyphSize` | `Small = 0, Medium = 1, Large = 2` | Mapped to `ESteamInputGlyphSize`. |
| `HapticLocation` | `Left = 0, Right = 1, Both = 2` | Mapped to `EControllerHapticLocation`. |
| `InputType` | `'Unknown'`, `'SteamController'`, `'XBox360Controller'`, `'XBoxOneController'`, `'GenericGamepad'`, `'PS4Controller'`, `'AppleMFiController'`, `'AndroidController'`, `'SwitchJoyConPair'`, `'SwitchJoyConSingle'`, `'SwitchProController'`, `'MobileTouch'`, `'PS3Controller'`, `'PS5Controller'`, `'SteamDeckController'` | String enum, from `ESteamInputType`. |
| `AnalogActionVector` | `{ x: number; y: number }` | |

`activateActionSet`, `isDigitalActionPressed` and `getAnalogActionVector` don't validate
handles. They use the low 64 bits of the `bigint`. `init()` passes
`bExplicitlyCallRunFrame = false`, which Valve documents as letting `SteamAPI_RunCallbacks`
update input state. This package dispatches callbacks manually instead. If the state looks
stale, call `runFrame()` once per frame before reading actions.

```js
const path = require('node:path')
const { input } = client

input.init()
// Only if you ship the manifest instead of configuring it in Steamworks
input.setInputActionManifestFilePath(path.resolve('steam_input_manifest.vdf'))

const gameControls = input.getActionSet('GameControls')
const jump = input.getDigitalAction('Jump')
const move = input.getAnalogAction('Move')

setInterval(() => {
    input.runFrame()
    for (const controller of input.getControllers()) {
        controller.activateActionSet(gameControls)
        if (controller.isDigitalActionPressed(jump)) console.log('jump')
        const { x, y } = controller.getAnalogActionVector(move)

        // Button prompt for whatever is bound to Jump
        const [origin] = controller.getDigitalActionOrigins(gameControls, jump)
        if (origin !== undefined) {
            const png = input.getGlyphPngForActionOrigin(origin, input.GlyphSize.Medium)
            const label = input.getStringForActionOrigin(origin)
        }
    }
}, 16)
```

## `inventory`

Item definitions through `ISteamInventory`. It needs an App ID with Steam Inventory item
definitions. Every function throws "Steam inventory is unavailable" if Steam doesn't provide
the interface. Owned items, trading and purchases aren't in the high-level API. Use
[`ISteamInventory`](../sdk/interfaces/ISteamInventory.md) through the SDK layer for those.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `loadItemDefinitions` | `loadItemDefinitions(): boolean` | Asks Steam to refresh the item definitions. `true` means the request was made, not that the definitions are ready. Steam posts [`SteamInventoryDefinitionUpdate_t`](../sdk/callbacks.md#steaminventorydefinitionupdate_t) when they are. | [`LoadItemDefinitions`](../sdk/interfaces/ISteamInventory.md#loaditemdefinitions) |
| `getItemDefinitionIds` | `getItemDefinitionIds(): number[] \| null` | Cached definition IDs. `null` if Steam can't return them. It calls Steam twice: once for the count, once for the data. | [`GetItemDefinitionIDs`](../sdk/interfaces/ISteamInventory.md#getitemdefinitionids) |
| `getItemDefinitionProperty` | `getItemDefinitionProperty(definition: number, name?: string): string \| null` | Value of a definition's property, such as `name`. Without `name`, it returns a comma-separated list of the definition's property names. `null` for a missing property. Throws if `name` contains NUL. It calls Steam twice, like `getItemDefinitionIds`. | [`GetItemDefinitionProperty`](../sdk/interfaces/ISteamInventory.md#getitemdefinitionproperty) |
| `sendItemDropHeartbeat` | `sendItemDropHeartbeat(): void` | Reports play time for playtime-based item drops. It doesn't grant an item. | [`SendItemDropHeartbeat`](../sdk/interfaces/ISteamInventory.md#senditemdropheartbeat) |

## `leaderboards`

Leaderboards through `ISteamUserStats`, addressed by name. They need a signed-in Steam client
and an App ID with leaderboards. `findOrCreateLeaderboard` and `uploadLeaderboardScore` create
a board that doesn't exist yet. Every function is async, and each call looks the board up
by name again, because handles aren't cached. So every call takes at least one round trip to
Steam. Names must be 1–128 UTF-8 bytes without NUL, or the promise rejects. Each round trip
times out after 30 seconds ("Steam leaderboard callback timed out") and rejects on an I/O
failure.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `findLeaderboard` | `findLeaderboard(name: string): Promise<boolean>` | `true` if the board exists, `false` if it doesn't. | [`FindLeaderboard`](../sdk/interfaces/ISteamUserStats.md#findleaderboard) |
| `findOrCreateLeaderboard` | `findOrCreateLeaderboard(name: string, sortMethod: LeaderboardSortMethod, displayType: LeaderboardDisplayType): Promise<boolean>` | Finds the board, or creates it with that sort method and display type. An existing board keeps its own settings. | [`FindOrCreateLeaderboard`](../sdk/interfaces/ISteamUserStats.md#findorcreateleaderboard) |
| `uploadLeaderboardScore` | `uploadLeaderboardScore(name, sortMethod, displayType, method: UploadScoreMethod, score: number, details?: number[]): Promise<LeaderboardScoreUploaded>` | Finds or creates the board, then uploads `score` (a 32-bit integer) with up to 64 `details` integers. `KeepBest` keeps the user's best score. `ForceUpdate` replaces it. Rejects with "Steam rejected leaderboard score upload" if Steam reports failure. More than 64 `details` rejects before any Steam call. | [`FindOrCreateLeaderboard`](../sdk/interfaces/ISteamUserStats.md#findorcreateleaderboard), [`UploadLeaderboardScore`](../sdk/interfaces/ISteamUserStats.md#uploadleaderboardscore) |
| `downloadLeaderboardEntries` | `downloadLeaderboardEntries(name, request: LeaderboardDataRequest, rangeStart: number, rangeEnd: number, maxDetails = 64): Promise<LeaderboardEntry[]>` | Downloads entries. `Global`: ranks `rangeStart` to `rangeEnd`, starting at 1. `GlobalAroundUser`: offsets around the current user, such as `-4` to `5`. `Friends`: all friends' entries, ignoring the range. Each entry's `details` is cut to `maxDetails` (0–64). Rejects with "Leaderboard not found" for a missing board. It also rejects for an invalid range: a start after the end, or a `Global` start below 1. | [`FindLeaderboard`](../sdk/interfaces/ISteamUserStats.md#findleaderboard), [`DownloadLeaderboardEntries`](../sdk/interfaces/ISteamUserStats.md#downloadleaderboardentries), [`GetDownloadedLeaderboardEntry`](../sdk/interfaces/ISteamUserStats.md#getdownloadedleaderboardentry) |
| `getLeaderboardEntryCount` | `getLeaderboardEntryCount(name: string): Promise<number>` | Total number of entries. Rejects with "Leaderboard not found" for a missing board. | [`FindLeaderboard`](../sdk/interfaces/ISteamUserStats.md#findleaderboard), [`GetLeaderboardEntryCount`](../sdk/interfaces/ISteamUserStats.md#getleaderboardentrycount) |
| `getLeaderboardInfo` | `getLeaderboardInfo(name: string): Promise<LeaderboardInfo>` | Name, entry count, sort method and display type. `sortMethod` and `displayType` are absent if Steam returns none. Rejects with "Leaderboard not found" for a missing board. | [`FindLeaderboard`](../sdk/interfaces/ISteamUserStats.md#findleaderboard), [`GetLeaderboardName`](../sdk/interfaces/ISteamUserStats.md#getleaderboardname), [`GetLeaderboardEntryCount`](../sdk/interfaces/ISteamUserStats.md#getleaderboardentrycount), [`GetLeaderboardSortMethod`](../sdk/interfaces/ISteamUserStats.md#getleaderboardsortmethod), [`GetLeaderboardDisplayType`](../sdk/interfaces/ISteamUserStats.md#getleaderboarddisplaytype) |

| Type | Definition | Notes |
|---|---|---|
| `LeaderboardSortMethod` | `Ascending = 0, Descending = 1` | `Ascending`: the lowest score ranks first, as for times. |
| `LeaderboardDisplayType` | `Numeric = 0, TimeSeconds = 1, TimeMilliSeconds = 2` | How Steam displays the score. |
| `LeaderboardDataRequest` | `Global = 0, GlobalAroundUser = 1, Friends = 2` | |
| `UploadScoreMethod` | `KeepBest = 0, ForceUpdate = 1` | |
| `LeaderboardEntry` | `{ steamId: bigint; globalRank: number; score: number; details: number[] }` | `globalRank` starts at 1. |
| `LeaderboardScoreUploaded` | `{ score: number; scoreChanged: boolean; globalRankNew: number; globalRankPrevious: number }` | `scoreChanged` is `false` when `KeepBest` kept a better earlier score. |
| `LeaderboardInfo` | `{ name: string; entryCount: number; sortMethod?: LeaderboardSortMethod; displayType?: LeaderboardDisplayType }` | |

```js
const lb = client.leaderboards
const board = 'Feet Traveled'

const result = await lb.uploadLeaderboardScore(
    board,
    lb.LeaderboardSortMethod.Descending,
    lb.LeaderboardDisplayType.Numeric,
    lb.UploadScoreMethod.KeepBest,
    1234,
)
console.log(result.scoreChanged, result.globalRankNew)

const top10 = await lb.downloadLeaderboardEntries(board, lb.LeaderboardDataRequest.Global, 1, 10)
const nearMe = await lb.downloadLeaderboardEntries(board, lb.LeaderboardDataRequest.GlobalAroundUser, -4, 5)
for (const entry of top10) {
    console.log(entry.globalRank, client.friends.getPersonaName(entry.steamId), entry.score)
}
```

## `localplayer`

The signed-in user. It needs a signed-in Steam client. The functions use several interfaces,
so every link names its interface.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `getSteamId` | `getSteamId(): PlayerSteamId` | The user's Steam ID. | [`ISteamUser::GetSteamID`](../sdk/interfaces/ISteamUser.md#getsteamid) |
| `getName` | `getName(): string` | The user's persona name. | [`ISteamFriends::GetPersonaName`](../sdk/interfaces/ISteamFriends.md#getpersonaname) |
| `getLevel` | `getLevel(): number` | The user's Steam level. | [`ISteamUser::GetPlayerSteamLevel`](../sdk/interfaces/ISteamUser.md#getplayersteamlevel) |
| `isLoggedOn` | `isLoggedOn(): boolean` | Whether the client is connected to the Steam servers. | [`ISteamUser::BLoggedOn`](../sdk/interfaces/ISteamUser.md#bloggedon) |
| `clearRichPresence` | `clearRichPresence(): void` | Removes all rich presence keys. | [`ISteamFriends::ClearRichPresence`](../sdk/interfaces/ISteamFriends.md#clearrichpresence) |
| `getIpCountry` | `getIpCountry(): string` | Two-letter ISO 3166-1 country code of the client's IP address. | [`ISteamUtils::GetIPCountry`](../sdk/interfaces/ISteamUtils.md#getipcountry) |
| `setRichPresence` | `setRichPresence(key: string, value?: string): void` | Sets a rich presence key. Without `value`, it sends an empty string, which removes the key. Steam's boolean result is discarded. A key or value containing NUL panics and aborts the process. | [`ISteamFriends::SetRichPresence`](../sdk/interfaces/ISteamFriends.md#setrichpresence) |

## `matchmaking`

Lobbies through `ISteamMatchmaking`. They need a signed-in Steam client, and testing joins
needs a second account. Lobby IDs are `bigint`. Results are `Lobby` objects. A `Lobby` that
`getLobbies()` returns is a search result you haven't joined yet; call `join()` on it.
`createLobby` and `joinLobby` have no timeout.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `createLobby` | `createLobby(lobbyType: LobbyType, maxMembers: number): Promise<Lobby>` | Creates a lobby, which you then own and are in. Rejects with Steam's error. `maxMembers` above 250 rejects, because steamworks-rs asserts Steam's limit. | [`CreateLobby`](../sdk/interfaces/ISteamMatchmaking.md#createlobby) |
| `joinLobby` | `joinLobby(lobbyId: bigint): Promise<Lobby>` | Joins a lobby. Rejects with "Failed to join lobby" unless Steam answers with `k_EChatRoomEnterResponseSuccess`. The ID isn't validated. | [`JoinLobby`](../sdk/interfaces/ISteamMatchmaking.md#joinlobby) |
| `getLobbies` | `getLobbies(filter?: LobbyListFilter): Promise<Lobby[]>` | Searches for lobbies: it applies the filter, then requests the list. Searches run one at a time, and concurrent calls wait their turn, because a new request would cancel a pending one. Rejects after 30 seconds. It rejects before touching Steam if a filter key is empty, longer than 255 bytes or contains NUL, if a value contains NUL, or if `count` is negative. | [`AddRequestLobbyListStringFilter`](../sdk/interfaces/ISteamMatchmaking.md#addrequestlobbyliststringfilter), [`AddRequestLobbyListNumericalFilter`](../sdk/interfaces/ISteamMatchmaking.md#addrequestlobbylistnumericalfilter), [`AddRequestLobbyListNearValueFilter`](../sdk/interfaces/ISteamMatchmaking.md#addrequestlobbylistnearvaluefilter), [`AddRequestLobbyListFilterSlotsAvailable`](../sdk/interfaces/ISteamMatchmaking.md#addrequestlobbylistfilterslotsavailable), [`AddRequestLobbyListDistanceFilter`](../sdk/interfaces/ISteamMatchmaking.md#addrequestlobbylistdistancefilter), [`AddRequestLobbyListResultCountFilter`](../sdk/interfaces/ISteamMatchmaking.md#addrequestlobbylistresultcountfilter), [`RequestLobbyList`](../sdk/interfaces/ISteamMatchmaking.md#requestlobbylist), [`GetLobbyByIndex`](../sdk/interfaces/ISteamMatchmaking.md#getlobbybyindex) |
| `Lobby` | `class Lobby` | A lobby, by ID. It holds no other state; every method asks Steam. | — |
| `Lobby.id` | `id: bigint` | The lobby's Steam ID. | — |
| `Lobby.join` | `join(): Promise<Lobby>` | Same as `joinLobby(lobby.id)`. | [`JoinLobby`](../sdk/interfaces/ISteamMatchmaking.md#joinlobby) |
| `Lobby.leave` | `leave(): void` | Leaves the lobby. | [`LeaveLobby`](../sdk/interfaces/ISteamMatchmaking.md#leavelobby) |
| `Lobby.openInviteDialog` | `openInviteDialog(): void` | Opens the overlay's invite dialog for this lobby. | [`ISteamFriends::ActivateGameOverlayInviteDialog`](../sdk/interfaces/ISteamFriends.md#activategameoverlayinvitedialog) |
| `Lobby.sendChatMessage` | `sendChatMessage(message: Buffer): void` | Sends 1–4096 bytes to every member, including you (as a `LobbyChatMsg` callback). Throws for a length outside that range, or if Steam refuses. | [`SendLobbyChatMsg`](../sdk/interfaces/ISteamMatchmaking.md#sendlobbychatmsg) |
| `Lobby.getChatEntry` | `getChatEntry(chatId: number): Buffer` | Bytes of the chat entry that a `LobbyChatMsg` callback's `chat_id` names. An empty Buffer if it's missing. The sender and entry type aren't returned; they're in the callback. | [`GetLobbyChatEntry`](../sdk/interfaces/ISteamMatchmaking.md#getlobbychatentry) |
| `Lobby.getMemberCount` | `getMemberCount(): bigint` | Number of members. | [`GetNumLobbyMembers`](../sdk/interfaces/ISteamMatchmaking.md#getnumlobbymembers) |
| `Lobby.getMemberLimit` | `getMemberLimit(): bigint \| null` | Maximum number of members. `null` when Steam returns 0, meaning it has no data. | [`GetLobbyMemberLimit`](../sdk/interfaces/ISteamMatchmaking.md#getlobbymemberlimit) |
| `Lobby.getMembers` | `getMembers(): PlayerSteamId[]` | The members, in Steam's order. | [`GetNumLobbyMembers`](../sdk/interfaces/ISteamMatchmaking.md#getnumlobbymembers), [`GetLobbyMemberByIndex`](../sdk/interfaces/ISteamMatchmaking.md#getlobbymemberbyindex) |
| `Lobby.getOwner` | `getOwner(): PlayerSteamId` | The current owner. | [`GetLobbyOwner`](../sdk/interfaces/ISteamMatchmaking.md#getlobbyowner) |
| `Lobby.setMemberData` | `setMemberData(key: string, value: string): void` | Sets a key in your own member data for this lobby. It doesn't change the lobby's data. Throws for a key that's empty or longer than 255 bytes, or a NUL in key or value. | [`SetLobbyMemberData`](../sdk/interfaces/ISteamMatchmaking.md#setlobbymemberdata) |
| `Lobby.getMemberData` | `getMemberData(steamId64: bigint, key: string): string \| null` | A member's value for `key`. `null` when it's missing or empty, which Steam doesn't distinguish. Throws for an invalid key, or a `steamId64` that isn't an unsigned 64-bit value. | [`GetLobbyMemberData`](../sdk/interfaces/ISteamMatchmaking.md#getlobbymemberdata) |
| `Lobby.setJoinable` | `setJoinable(joinable: boolean): boolean` | Allows or blocks joining. `false` if you aren't the owner. | [`SetLobbyJoinable`](../sdk/interfaces/ISteamMatchmaking.md#setlobbyjoinable) |
| `Lobby.getData` | `getData(key: string): string \| null` | The lobby's metadata value for `key`. `null` when it's empty or missing. A key containing NUL, or a value that isn't valid UTF-8, panics and aborts the process. | [`GetLobbyData`](../sdk/interfaces/ISteamMatchmaking.md#getlobbydata) |
| `Lobby.setData` | `setData(key: string, value: string): boolean` | Sets lobby metadata. Steam's result; per Valve, only the owner can set it. A NUL in key or value aborts the process. | [`SetLobbyData`](../sdk/interfaces/ISteamMatchmaking.md#setlobbydata) |
| `Lobby.deleteData` | `deleteData(key: string): boolean` | Removes a metadata key. | [`DeleteLobbyData`](../sdk/interfaces/ISteamMatchmaking.md#deletelobbydata) |
| `Lobby.getFullData` | `getFullData(): Record<string, string>` | All metadata keys and values. Invalid UTF-8 is replaced, not fatal. | [`GetLobbyDataCount`](../sdk/interfaces/ISteamMatchmaking.md#getlobbydatacount), [`GetLobbyDataByIndex`](../sdk/interfaces/ISteamMatchmaking.md#getlobbydatabyindex) |
| `Lobby.mergeFullData` | `mergeFullData(data: Record<string, string>): boolean` | Calls `SetLobbyData` once per entry; this isn't an atomic batch. It stops at the first entry Steam rejects and returns `false`, so later entries aren't set. | [`SetLobbyData`](../sdk/interfaces/ISteamMatchmaking.md#setlobbydata) |

| Type | Definition | Notes |
|---|---|---|
| `LobbyType` | `Private = 0, FriendsOnly = 1, Public = 2, Invisible = 3` | Mapped to `ELobbyType`. |
| `LobbyComparison` | `Equal = 0, NotEqual = 1, GreaterThan = 2, GreaterThanOrEqual = 3, LessThan = 4, LessThanOrEqual = 5` | Mapped to `ELobbyComparison` by name. `GreaterThanOrEqual` becomes `k_ELobbyComparisonEqualToOrGreaterThan`. |
| `LobbyDistance` | `Close = 0, Default = 1, Far = 2, Worldwide = 3` | Mapped to `ELobbyDistanceFilter`. |
| `LobbyStringFilter` | `{ key: string; value: string; comparison?: LobbyComparison }` | `comparison` defaults to `Equal`. |
| `LobbyNumberFilter` | `{ key: string; value: number; comparison: LobbyComparison }` | `value` is a 32-bit integer. |
| `LobbyNearFilter` | `{ key: string; value: number }` | Sorts results by closeness to `value`. Earlier filters take priority. |
| `LobbyListFilter` | `{ stringFilters?; numberFilters?; nearValueFilters?; slotsAvailable?: number; distance?: LobbyDistance; count?: number }` | `slotsAvailable` is the minimum number of open slots. `count` is the maximum number of results. |

```js
const { init, SteamCallback } = require('@kyeshmz/steamworks.js')
const client = init(480)
const mm = client.matchmaking

// Host
const lobby = await mm.createLobby(mm.LobbyType.Public, 4)
lobby.setData('mode', 'coop')

// Another player
const found = await mm.getLobbies({
    stringFilters: [{ key: 'mode', value: 'coop' }],
    slotsAvailable: 1,
    distance: mm.LobbyDistance.Worldwide,
    count: 20,
})
const joined = await found[0]?.join()

// Chat, for any member
client.callback.register(SteamCallback.LobbyChatMsg, ({ lobby: id, user, chat_id }) => {
    if (joined && id === joined.id) {
        console.log(user, joined.getChatEntry(chat_id).toString())
    }
})
joined?.sendChatMessage(Buffer.from('hello'))
```

## `networking`

Legacy peer-to-peer packets through `ISteamNetworking`, which Valve has deprecated. Prefer
[`networking_messages`](#networking_messages). Both peers need the same App ID, and testing
needs two Steam accounts. Every call uses channel 0. Steam IDs aren't validated.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `sendP2PPacket` | `sendP2PPacket(steamId64: bigint, sendType: SendType, data: Buffer): boolean` | Sends a packet. `false` if Steam refuses it. | [`SendP2PPacket`](../sdk/interfaces/ISteamNetworking.md#sendp2ppacket) |
| `isP2PPacketAvailable` | `isP2PPacketAvailable(): number` | Size, in bytes, of the next waiting packet. `0` if there is none. | [`IsP2PPacketAvailable`](../sdk/interfaces/ISteamNetworking.md#isp2ppacketavailable) |
| `readP2PPacket` | `readP2PPacket(size: number): P2PPacket` | Reads the next packet into a new Buffer of `size` bytes (0–1048576). Pass the value from `isP2PPacketAvailable()`. `packet.size` is the number of bytes Steam wrote. `packet.data` always has length `size`. Throws "No packet available" if nothing is waiting. | [`ReadP2PPacket`](../sdk/interfaces/ISteamNetworking.md#readp2ppacket) |
| `acceptP2PSession` | `acceptP2PSession(steamId64: bigint): void` | Accepts a session, usually in answer to a `P2PSessionRequest` callback. | [`AcceptP2PSessionWithUser`](../sdk/interfaces/ISteamNetworking.md#acceptp2psessionwithuser) |
| `closeP2PSession` | `closeP2PSession(steamId64: bigint): void` | Closes the session with that user. | [`CloseP2PSessionWithUser`](../sdk/interfaces/ISteamNetworking.md#closep2psessionwithuser) |

| Type | Definition | Notes |
|---|---|---|
| `P2PPacket` | `{ data: Buffer; size: number; steamId: PlayerSteamId }` | `steamId` is the sender. |
| `SendType` | `Unreliable = 0, UnreliableNoDelay = 1, Reliable = 2, ReliableWithBuffering = 3` | Mapped to `EP2PSend`. According to the declarations, `Unreliable` packets can't exceed 1200 bytes, and `Reliable` ones 1 MB. |

## `networking_messages`

Channel-based peer messages through `ISteamNetworkingMessages`.
[Peer messages](../networking-messages.md) has a full walkthrough. Both peers need the same
App ID, and testing needs two Steam accounts. A peer ID must be an individual-account
SteamID64 `bigint`. Anything else throws "Expected a user SteamID64". These functions check
argument types strictly.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `sendMessageToUser` | `sendMessageToUser(steamId64: bigint, data: Buffer, channel = 0, sendType = MessageSendType.ReliableNoNagle): void` | Queues up to 512 KiB on `channel` (0–2147483647). It always adds `k_nSteamNetworkingSend_AutoRestartBrokenSession`. Sending implicitly accepts a session from that peer. Throws if Steam returns an error. Success means queued, not delivered. | [`SendMessageToUser`](../sdk/interfaces/ISteamNetworkingMessages.md#sendmessagetouser) |
| `receiveMessagesOnChannel` | `receiveMessagesOnChannel(channel = 0, maxMessages = 10): Message[]` | Returns up to `maxMessages` (1–32) waiting messages, or `[]`. Each `data` is a copy, and the Steam messages are released. There's no receive event, so poll. | [`ReceiveMessagesOnChannel`](../sdk/interfaces/ISteamNetworkingMessages.md#receivemessagesonchannel) |
| `setSessionRequestHandler` | `setSessionRequestHandler(handler?: (request: SessionRequest) => void): void` | Calls `handler` when a peer asks to open a session. It doesn't accept the session; call `acceptSessionWithUser` for that. There's one handler per client: a new call replaces the old handler, and a call without a handler clears it. The handler doesn't keep Node alive. | Callback [`SteamNetworkingMessagesSessionRequest_t`](../sdk/callbacks.md#steamnetworkingmessagessessionrequest_t) |
| `acceptSessionWithUser` | `acceptSessionWithUser(steamId64: bigint): boolean` | Accepts a pending request without sending anything. Returns Steam's result. | [`AcceptSessionWithUser`](../sdk/interfaces/ISteamNetworkingMessages.md#acceptsessionwithuser) |
| `closeSessionWithUser` | `closeSessionWithUser(steamId64: bigint): boolean` | Closes the session on all channels. The peer can still request a new one. Returns Steam's result. | [`CloseSessionWithUser`](../sdk/interfaces/ISteamNetworkingMessages.md#closesessionwithuser) |
| `setSessionFailedHandler` | `setSessionFailedHandler(handler?: (failure: SessionFailure) => void): void` | Calls `handler` when a session fails. It follows the same replace and clear rules as `setSessionRequestHandler`. | Callback [`SteamNetworkingMessagesSessionFailed_t`](../sdk/callbacks.md#steamnetworkingmessagessessionfailed_t) |

| Type | Definition | Notes |
|---|---|---|
| `Message` | `{ data: Buffer; steamId?: PlayerSteamId }` | `steamId` is absent for non-Steam identities. |
| `MessageSendType` | `ReliableNoNagle = 0, Reliable = 1, Unreliable = 2, UnreliableNoDelay = 3` | Mapped to the `k_nSteamNetworkingSend_*` flags. |
| `SessionFailure` | `{ steamId?: PlayerSteamId }` | Steam may not know the peer's identity. |
| `SessionRequest` | `{ steamId?: PlayerSteamId }` | Ignore requests without a `steamId` or from unexpected peers. |

```js
const net = client.networking_messages
const me = client.localplayer.getSteamId().steamId64
// For example, the other member of a two-player lobby
const peer = lobby.getMembers().find((member) => member.steamId64 !== me).steamId64
const channel = 1

net.setSessionRequestHandler(({ steamId }) => {
    if (steamId?.steamId64 === peer) net.acceptSessionWithUser(peer)
})
net.setSessionFailedHandler(({ steamId }) => console.error('session failed', steamId?.steamId64))

net.sendMessageToUser(peer, Buffer.from('hello'), channel)

const poll = setInterval(() => {
    for (const { data, steamId } of net.receiveMessagesOnChannel(channel)) {
        if (steamId?.steamId64 === peer) console.log(data.toString())
    }
}, 30)

// When done
clearInterval(poll)
net.setSessionRequestHandler()
net.setSessionFailedHandler()
net.closeSessionWithUser(peer)
```

## `overlay`

Opens the Steam overlay, mostly through `ISteamFriends`. The overlay must be enabled for the
game (`utils.isOverlayEnabled()`), and in Electron you also need
`electronEnableSteamOverlay()`. To react when the overlay opens or closes, register
`SteamCallback.GameOverlayActivated`. These calls return right away and don't report whether
anything opened.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `setNotificationPosition` | `setNotificationPosition(position: NotificationPosition): void` | Sets the corner where Steam shows notification pop-ups. | [`ISteamUtils::SetOverlayNotificationPosition`](../sdk/interfaces/ISteamUtils.md#setoverlaynotificationposition) |
| `activateDialog` | `activateDialog(dialog: Dialog): void` | Opens the overlay on a dialog. The enum is sent as a lowercase string: `friends`, `community`, `players`, `settings`, `officialgamegroup`, `stats` or `achievements`. | [`ActivateGameOverlay`](../sdk/interfaces/ISteamFriends.md#activategameoverlay) |
| `activateDialogToUser` | `activateDialogToUser(dialog: Dialog, steamId64: bigint): void` | Opens a dialog about a user, using the same `Dialog` strings. Of those, only `stats` and `achievements` appear in Valve's list for this call (`steamid`, `chat`, `jointrade`, `stats`, `achievements`, `friendadd`, …). For the others, call `ActivateGameOverlayToUser` through the SDK layer. The Steam ID isn't validated. | [`ActivateGameOverlayToUser`](../sdk/interfaces/ISteamFriends.md#activategameoverlaytouser) |
| `activateInviteDialog` | `activateInviteDialog(lobbyId: bigint): void` | Opens the invite dialog for a lobby. | [`ActivateGameOverlayInviteDialog`](../sdk/interfaces/ISteamFriends.md#activategameoverlayinvitedialog) |
| `activateToWebPage` | `activateToWebPage(url: string): void` | Opens the overlay's web browser in default mode. A `url` containing NUL panics and aborts the process. | [`ActivateGameOverlayToWebPage`](../sdk/interfaces/ISteamFriends.md#activategameoverlaytowebpage) |
| `activateToStore` | `activateToStore(appId: number, flag: StoreFlag): void` | Opens an app's store page, and can add the app to the cart. | [`ActivateGameOverlayToStore`](../sdk/interfaces/ISteamFriends.md#activategameoverlaytostore) |

| Type | Definition | Notes |
|---|---|---|
| `NotificationPosition` | `TopLeft = 0, TopRight = 1, BottomLeft = 2, BottomRight = 3` | Mapped to `ENotificationPosition`. |
| `Dialog` | `Friends = 0, Community = 1, Players = 2, Settings = 3, OfficialGameGroup = 4, Stats = 5, Achievements = 6` | Sent as the strings listed above. |
| `StoreFlag` | `None = 0, AddToCart = 1, AddToCartAndShow = 2` | Mapped to `EOverlayToStoreFlag`. |

## `screenshots`

Screenshots through `ISteamScreenshots`. `triggerScreenshot` needs the Steam overlay.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `triggerScreenshot` | `triggerScreenshot(): void` | Asks the Steam overlay to take a screenshot. | [`TriggerScreenshot`](../sdk/interfaces/ISteamScreenshots.md#triggerscreenshot) |
| `addScreenshotToLibrary` | `addScreenshotToLibrary(filename: string, thumbnailFilename: null, width: number, height: number): number` | Adds an existing JPEG to the user's screenshot library and returns its `ScreenshotHandle`. The path is resolved to an absolute path, so the file must exist. `thumbnailFilename` must be `null`; Steam generates the thumbnail. It throws for any other thumbnail value, for dimensions that aren't positive, for a missing file, or if Steam rejects the file. Steam posts [`ScreenshotReady_t`](../sdk/callbacks.md#screenshotready_t) once it has written the screenshot. | [`AddScreenshotToLibrary`](../sdk/interfaces/ISteamScreenshots.md#addscreenshottolibrary) |

## `stats`

User stats through `ISteamUserStats`. They need stats configured and published for the App
ID. App 480 has `NumGames`, `NumWins` and others. Setters change values locally; call
`store()` to upload them. Getters return `null`, and setters `false`, for an unknown stat, the
wrong type, a name containing NUL, or before Steam has delivered the user's stats. There's an
example under [`achievement`](#achievement).

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `getInt` | `getInt(name: string): number \| null` | Value of an INT stat. | [`GetStatInt32`](../sdk/interfaces/ISteamUserStats.md#getstatint32) |
| `setInt` | `setInt(name: string, value: number): boolean` | Sets an INT stat. `value` is a 32-bit integer. | [`SetStatInt32`](../sdk/interfaces/ISteamUserStats.md#setstatint32) |
| `getFloat` | `getFloat(name: string): number \| null` | Value of a FLOAT stat, widened from a 32-bit float, so `0.1` reads back as `0.10000000149011612`. | [`GetStatFloat`](../sdk/interfaces/ISteamUserStats.md#getstatfloat) |
| `setFloat` | `setFloat(name: string, value: number): boolean` | Converts `value` to a 32-bit float first. If the result isn't finite (NaN, ±Infinity, or outside the 32-bit float range), it returns `false` without calling Steam. | [`SetStatFloat`](../sdk/interfaces/ISteamUserStats.md#setstatfloat) |
| `store` | `store(): boolean` | Uploads changed stats and achievements. Steam then posts `UserStatsStored_t`, and `UserAchievementStored_t` for unlocks. | [`StoreStats`](../sdk/interfaces/ISteamUserStats.md#storestats) |
| `resetAll` | `resetAll(achievementsToo: boolean): boolean` | Resets all of the user's stats, and their achievements too if `achievementsToo` is `true`. Meant for testing. | [`ResetAllStats`](../sdk/interfaces/ISteamUserStats.md#resetallstats) |

Average-rate stats (`UpdateAvgRateStat`), other users' stats and global stats aren't in the
high-level API. Use [`ISteamUserStats`](../sdk/interfaces/ISteamUserStats.md) through the
SDK layer for those.

## `utils`

Miscellaneous `ISteamUtils` queries, plus the text input of Big Picture mode and Steam Deck.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `isOverlayEnabled` | `isOverlayEnabled(): boolean` | Whether the Steam overlay is enabled for this process. | [`IsOverlayEnabled`](../sdk/interfaces/ISteamUtils.md#isoverlayenabled) |
| `uiLanguage` | `uiLanguage(): string` | Language of the Steam client UI, such as `'english'`. For the game's language, use `apps.currentGameLanguage()`. | [`GetSteamUILanguage`](../sdk/interfaces/ISteamUtils.md#getsteamuilanguage) |
| `getAppId` | `getAppId(): number` | The App ID this process runs as. | [`GetAppID`](../sdk/interfaces/ISteamUtils.md#getappid) |
| `getServerRealTime` | `getServerRealTime(): number` | Steam server time, in Unix seconds. | [`GetServerRealTime`](../sdk/interfaces/ISteamUtils.md#getserverrealtime) |
| `isSteamRunningOnSteamDeck` | `isSteamRunningOnSteamDeck(): boolean` | Whether Steam is running on a Steam Deck. | [`IsSteamRunningOnSteamDeck`](../sdk/interfaces/ISteamUtils.md#issteamrunningonsteamdeck) |
| `showGamepadTextInput` | `showGamepadTextInput(inputMode, inputLineMode, description: string, maxCharacters: number, existingText?: string): Promise<string \| null>` | Opens the gamepad keyboard dialog. When the user closes it, it resolves with the submitted text, or with `null` if they cancelled. It also resolves `null` right away if Steam can't show the dialog. There's no timeout. Open one dialog at a time: a second call replaces the first one's listener, and the first promise rejects. | [`ShowGamepadTextInput`](../sdk/interfaces/ISteamUtils.md#showgamepadtextinput), [`GetEnteredGamepadTextInput`](../sdk/interfaces/ISteamUtils.md#getenteredgamepadtextinput), callback [`GamepadTextInputDismissed_t`](../sdk/callbacks.md#gamepadtextinputdismissed_t) |
| `showFloatingGamepadTextInput` | `showFloatingGamepadTextInput(keyboardMode, x: number, y: number, width: number, height: number): Promise<boolean>` | Opens the floating on-screen keyboard over the game. Steam positions it to avoid the text field you describe, in pixels from the window origin. The typed text arrives as ordinary key events. It resolves `false` right away if Steam can't show the keyboard. Otherwise it resolves `true` only once the keyboard is dismissed. Open one keyboard at a time, as with `showGamepadTextInput`. | [`ShowFloatingGamepadTextInput`](../sdk/interfaces/ISteamUtils.md#showfloatinggamepadtextinput), callback [`FloatingGamepadTextInputDismissed_t`](../sdk/callbacks.md#floatinggamepadtextinputdismissed_t) |

| Type | Definition | Notes |
|---|---|---|
| `GamepadTextInputMode` | `Normal = 0, Password = 1` | Mapped to `EGamepadTextInputMode`. |
| `GamepadTextInputLineMode` | `SingleLine = 0, MultipleLines = 1` | Mapped to `EGamepadTextInputLineMode`. |
| `FloatingGamepadTextInputMode` | `SingleLine = 0, MultipleLines = 1, Email = 2, Numeric = 3` | Mapped to `EFloatingGamepadTextInputMode`. |

## `workshop`

Steam Workshop items through `ISteamUGC`. It needs an App ID with the Workshop enabled, and
uploads need a user who has accepted the Workshop legal agreement (see
`needsToAcceptAgreement`). Item IDs are `bigint` and aren't validated. `appId` arguments
default to the running App ID (`utils.getAppId()`). The async functions have no timeout. On
failure they reject with the text of Steam's `EResult`, as steamworks-rs maps it.

| Name | Signature | Behaviour | Wraps |
|---|---|---|---|
| `createItem` | `createItem(appId?: number, fileType = FileType.Community): Promise<UgcResult>` | Creates an empty item that the user owns. Fill it in with `updateItem`. | [`CreateItem`](../sdk/interfaces/ISteamUGC.md#createitem) |
| `updateItem` | `updateItem(itemId: bigint, updateDetails: UgcUpdate, appId?: number): Promise<UgcResult>` | Starts an update, applies each field that's set, and submits it with `changeNote`. `previewPath` and `contentPath` (a folder) are resolved to absolute paths, so they must exist. A missing path, or any field Steam rejects, makes steamworks-rs panic. The promise then rejects with a generic panic message, not a descriptive error. `tags` replaces the item's tags; admin tags aren't allowed. | [`StartItemUpdate`](../sdk/interfaces/ISteamUGC.md#startitemupdate), [`SetItemTitle`](../sdk/interfaces/ISteamUGC.md#setitemtitle), [`SetItemDescription`](../sdk/interfaces/ISteamUGC.md#setitemdescription), [`SetItemPreview`](../sdk/interfaces/ISteamUGC.md#setitempreview), [`SetItemTags`](../sdk/interfaces/ISteamUGC.md#setitemtags), [`SetItemContent`](../sdk/interfaces/ISteamUGC.md#setitemcontent), [`SetItemVisibility`](../sdk/interfaces/ISteamUGC.md#setitemvisibility), [`SubmitItemUpdate`](../sdk/interfaces/ISteamUGC.md#submititemupdate) |
| `updateItemWithCallback` | `updateItemWithCallback(itemId: bigint, updateDetails: UgcUpdate, appId: number \| undefined, successCallback: (data: UgcResult) => void, errorCallback: (err: any) => void, progressCallback?: (data: UpdateProgress) => void, progressCallbackIntervalMs = 1000): void` | The same update, reported through callbacks. `errorCallback` receives an `Error`. With a `progressCallback`, a background thread checks the upload every `progressCallbackIntervalMs` milliseconds and calls it until the status is `Invalid` or `CommittingChanges`. This function is synchronous, so the path and field problems that make `updateItem` reject abort the process here. Check your paths first. | Same as `updateItem`, plus [`GetItemUpdateProgress`](../sdk/interfaces/ISteamUGC.md#getitemupdateprogress) |
| `subscribe` | `subscribe(itemId: bigint): Promise<void>` | Subscribes the user. Steam then downloads and installs the item. | [`SubscribeItem`](../sdk/interfaces/ISteamUGC.md#subscribeitem) |
| `unsubscribe` | `unsubscribe(itemId: bigint): Promise<void>` | Unsubscribes the user. Steam removes the item after the game quits. | [`UnsubscribeItem`](../sdk/interfaces/ISteamUGC.md#unsubscribeitem) |
| `state` | `state(itemId: bigint): number` | The `EItemState` bitmask: 1 Subscribed, 2 LegacyItem, 4 Installed, 8 NeedsUpdate, 16 Downloading, 32 DownloadPending. Other bits, such as 64 (DisabledLocally), are dropped. | [`GetItemState`](../sdk/interfaces/ISteamUGC.md#getitemstate) |
| `installInfo` | `installInfo(itemId: bigint): InstallInfo \| null` | Install folder, size on disk in bytes, and timestamp in Unix seconds. `null` if the item isn't installed. | [`GetItemInstallInfo`](../sdk/interfaces/ISteamUGC.md#getiteminstallinfo) |
| `downloadInfo` | `downloadInfo(itemId: bigint): DownloadInfo \| null` | Bytes downloaded and total. `null` if Steam has no download information. | [`GetItemDownloadInfo`](../sdk/interfaces/ISteamUGC.md#getitemdownloadinfo) |
| `download` | `download(itemId: bigint, highPriority: boolean): boolean` | Starts a download or an update. With `highPriority`, Steam pauses its other downloads. `false` if the request failed. | [`DownloadItem`](../sdk/interfaces/ISteamUGC.md#downloaditem) |
| `getSubscribedItems` | `getSubscribedItems(): bigint[]` | IDs of all items the user subscribes to. | [`GetNumSubscribedItems`](../sdk/interfaces/ISteamUGC.md#getnumsubscribeditems), [`GetSubscribedItems`](../sdk/interfaces/ISteamUGC.md#getsubscribeditems) |
| `deleteItem` | `deleteItem(itemId: bigint): Promise<void>` | Permanently deletes an item the user owns. Resolves when Steam reports `k_EResultOK` in `DeleteItemResult_t`, and rejects with the `EResult` otherwise. | [`DeleteItem`](../sdk/interfaces/ISteamUGC.md#deleteitem) |
| `getItem` | `getItem(item: bigint, queryConfig?: WorkshopItemQueryConfig): Promise<WorkshopItem \| null>` | Details of one item. `null` if Steam returned no result for it, for example because it doesn't exist. | [`CreateQueryUGCDetailsRequest`](../sdk/interfaces/ISteamUGC.md#createqueryugcdetailsrequest), the query-config setters below, [`SendQueryUGCRequest`](../sdk/interfaces/ISteamUGC.md#sendqueryugcrequest), [`GetQueryUGCResult`](../sdk/interfaces/ISteamUGC.md#getqueryugcresult), [`GetQueryUGCPreviewURL`](../sdk/interfaces/ISteamUGC.md#getqueryugcpreviewurl), [`GetQueryUGCStatistic`](../sdk/interfaces/ISteamUGC.md#getqueryugcstatistic), [`ReleaseQueryUGCRequest`](../sdk/interfaces/ISteamUGC.md#releasequeryugcrequest) |
| `getItems` | `getItems(items: bigint[], queryConfig?: WorkshopItemQueryConfig): Promise<WorkshopItemsResult>` | Details of several items. `items` has `null` wherever Steam had no result. Pass at least one ID. It rejects if Steam can't create the query. | Same as `getItem` |
| `getAllItems` | `getAllItems(page: number, queryType: UGCQueryType, itemType: UGCType, creatorAppId: number, consumerAppId: number, queryConfig?): Promise<WorkshopPaginatedResult>` | One page of a ranked query over all items. Per Valve's docs, pages start at 1. | [`CreateQueryAllUGCRequestPage`](../sdk/interfaces/ISteamUGC.md#createqueryallugcrequestpage), then as `getItem` |
| `getUserItems` | `getUserItems(page: number, accountId: number, listType: UserListType, itemType: UGCType, sortOrder: UserListOrder, appIds: AppIDs, queryConfig?): Promise<WorkshopPaginatedResult>` | One page of a user's list: published, subscribed, favorited, and so on. `accountId` is the 32-bit account ID (`PlayerSteamId.accountId`). A missing `appIds` entry is sent as 0. | [`CreateQueryUserUGCRequest`](../sdk/interfaces/ISteamUGC.md#createqueryuserugcrequest), then as `getItem` |

| Type | Definition | Notes |
|---|---|---|
| `UgcResult` | `{ itemId: bigint; needsToAcceptAgreement: boolean }` | When `needsToAcceptAgreement` is `true`, send the user to the item's page so they can accept the agreement. |
| `UgcItemVisibility` | `Public = 0, FriendsOnly = 1, Private = 2, Unlisted = 3` | Mapped to `ERemoteStoragePublishedFileVisibility`. |
| `UgcUpdate` | `{ title?; description?; changeNote?; previewPath?; contentPath?; tags?: string[]; visibility?: UgcItemVisibility }` | Fields you leave out aren't changed. |
| `InstallInfo` | `{ folder: string; sizeOnDisk: bigint; timestamp: number }` | |
| `DownloadInfo` | `{ current: bigint; total: bigint }` | Bytes. |
| `UpdateStatus` | `Invalid = 0, PreparingConfig = 1, PreparingContent = 2, UploadingContent = 3, UploadingPreviewFile = 4, CommittingChanges = 5` | Mapped from `EItemUpdateStatus`. |
| `UpdateProgress` | `{ status: UpdateStatus; progress: bigint; total: bigint }` | `progress` and `total` are bytes. |
| `FileType` | `Community = 0`, `Microtransaction`, `Collection`, `Art`, `Video`, `Screenshot`, `Game`, `Software`, `Concept`, `WebGuide`, `IntegratedGuide`, `Merch`, `ControllerBinding`, `SteamworksAccessInvite`, `SteamVideo`, `GameManagedItem = 15` | Mapped to `EWorkshopFileType`. `Community` is an ordinary item. |
| `UGCQueryType` | `RankedByVote = 0` … `RankedByLastUpdatedDate = 19`, in `EUGCQuery` order | Mapped to `EUGCQuery`. |
| `UGCType` | `Items = 0` … `GameManagedItems = 12`, `All = 13` | Mapped to `EUGCMatchingUGCType`. |
| `UserListType` | `Published = 0, VotedOn = 1, VotedUp = 2, VotedDown = 3, Favorited = 4, Subscribed = 5, UsedOrPlayed = 6, Followed = 7` | Mapped to `EUserUGCList` by name. It leaves out the deprecated `WillVoteLater`, so the numbers differ from Steam's. |
| `UserListOrder` | `CreationOrderAsc = 0, CreationOrderDesc = 1, TitleAsc = 2, LastUpdatedDesc = 3, SubscriptionDateDesc = 4, VoteScoreDesc = 5, ForModeration = 6` | Mapped to `EUserUGCListSortOrder`. |
| `WorkshopItemStatistic` | `{ numSubscriptions?, numFavorites?, numFollowers?, numUniqueSubscriptions?, numUniqueFavorites?, numUniqueFollowers?, numUniqueWebsiteViews?, reportScore?, numSecondsPlayed?, numPlaytimeSessions?, numComments?, numSecondsPlayedDuringTimePeriod?, numPlaytimeSessionsDuringTimePeriod? }` | All `bigint`. Each one is absent when `GetQueryUGCStatistic` returns no value. |
| `WorkshopItem` | `{ publishedFileId; creatorAppId?; consumerAppId?; title; description; owner: PlayerSteamId; timeCreated; timeUpdated; timeAddedToUserList; visibility; banned; acceptedForUse; tags: string[]; tagsTruncated; url; numUpvotes; numDownvotes; numChildren; previewUrl?; statistics }` | Times are Unix seconds. `creatorAppId` and `consumerAppId` are absent when they're 0. `tags` is Steam's comma-separated list split on commas, so an item without tags has `['']`. Per Valve, `description` is cut to 255 bytes unless you set `includeLongDescription`. |
| `WorkshopPaginatedResult` | `{ items: (WorkshopItem \| null)[]; returnedResults: number; totalResults: number; wasCached: boolean }` | `totalResults` counts all matches, not only this page. |
| `WorkshopItemsResult` | `{ items: (WorkshopItem \| null)[]; wasCached: boolean }` | |
| `WorkshopItemQueryConfig` | See the next table. | Every field is optional. Unset fields keep Steam's defaults. |
| `AppIDs` | `{ creator?: number; consumer?: number }` | For `getUserItems`. |

The `WorkshopItemQueryConfig` fields and the calls they make:

| Field | Calls | Notes |
|---|---|---|
| `cachedResponseMaxAge` | [`SetAllowCachedResponse`](../sdk/interfaces/ISteamUGC.md#setallowcachedresponse) | Seconds. |
| `includeMetadata` | [`SetReturnMetadata`](../sdk/interfaces/ISteamUGC.md#setreturnmetadata) | `WorkshopItem` doesn't expose the metadata, so this has no visible effect. |
| `includeLongDescription` | [`SetReturnLongDescription`](../sdk/interfaces/ISteamUGC.md#setreturnlongdescription) | |
| `includeAdditionalPreviews` | [`SetReturnAdditionalPreviews`](../sdk/interfaces/ISteamUGC.md#setreturnadditionalpreviews) | `WorkshopItem` doesn't expose additional previews either. |
| `onlyIds` | [`SetReturnOnlyIDs`](../sdk/interfaces/ISteamUGC.md#setreturnonlyids) | |
| `onlyTotal` | [`SetReturnTotalOnly`](../sdk/interfaces/ISteamUGC.md#setreturntotalonly) | |
| `language` | [`SetLanguage`](../sdk/interfaces/ISteamUGC.md#setlanguage) | An API language name such as `'english'`. |
| `matchAnyTag` | [`SetMatchAnyTag`](../sdk/interfaces/ISteamUGC.md#setmatchanytag) | |
| `requiredTags` | [`AddRequiredTag`](../sdk/interfaces/ISteamUGC.md#addrequiredtag), once per tag | |
| `excludedTags` | [`AddExcludedTag`](../sdk/interfaces/ISteamUGC.md#addexcludedtag), once per tag | |
| `searchText` | [`SetSearchText`](../sdk/interfaces/ISteamUGC.md#setsearchtext) | |
| `rankedByTrendDays` | [`SetRankedByTrendDays`](../sdk/interfaces/ISteamUGC.md#setrankedbytrenddays) | For `RankedByTrend` queries. |

Create, update and query:

```js
const path = require('node:path')
const ws = client.workshop

// Create an item for the running App ID
const { itemId, needsToAcceptAgreement } = await ws.createItem()

// Fill it in. The paths must exist; a missing one rejects with a panic message.
await ws.updateItem(itemId, {
    title: 'My map',
    description: 'A small test map',
    contentPath: path.resolve('build/workshop/my-map'),   // a folder
    previewPath: path.resolve('build/workshop/my-map.png'),
    tags: ['Maps'],
    visibility: ws.UgcItemVisibility.Private,
    changeNote: 'First upload',
})

if (needsToAcceptAgreement) {
    client.overlay.activateToWebPage(`steam://url/CommunityFilePage/${itemId}`)
}

// The same update with progress reports every 500 ms
ws.updateItemWithCallback(
    itemId,
    { changeNote: 'Second upload', contentPath: path.resolve('build/workshop/my-map') },
    undefined,
    (result) => console.log('done', result.itemId),
    (error) => console.error(error),
    ({ status, progress, total }) => console.log(status, `${progress}/${total}`),
    500,
)

// Query
const appId = client.utils.getAppId()
const page = await ws.getAllItems(1, ws.UGCQueryType.RankedByVote, ws.UGCType.Items, appId, appId, {
    searchText: 'castle',
    includeLongDescription: true,
})
for (const item of page.items) {
    if (item) console.log(item.publishedFileId, item.title, item.statistics.numSubscriptions)
}

// The current user's own uploads
const mine = await ws.getUserItems(
    1,
    client.localplayer.getSteamId().accountId,
    ws.UserListType.Published,
    ws.UGCType.Items,
    ws.UserListOrder.LastUpdatedDesc,
    { creator: appId, consumer: appId },
)
console.log(mine.totalResults)
```
