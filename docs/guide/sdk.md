# The 1:1 SDK layer

`sdk` exposes the whole Steamworks SDK to JavaScript under its own names. If Valve's
documentation says `SteamUserStats()->SetAchievement( "ACH_WIN" )`, you write
`sdk.SteamUserStats.SetAchievement('ACH_WIN')`. This guide explains how C++ maps to
JavaScript, so you can apply Valve's docs directly. The [generated reference](../sdk/README.md)
lists every interface, method, struct, callback, enum and constant.

```js
const steamworks = require('@kyeshmz/steamworks.js')
const client = steamworks.init(480)   // starts the callback loop
const { sdk } = client                // also: steamworks.sdk

if (sdk.SteamUserStats.SetAchievement('ACH_WIN_ONE_GAME')) {
    sdk.SteamUserStats.StoreStats()
}

const { result, pData } = sdk.SteamUserStats.GetStatInt32('NumGames')
if (result) console.log('games played:', pData)

const board = await sdk.SteamUserStats.FindLeaderboard('Feet Traveled')
if (board.m_bLeaderboardFound) console.log('handle', board.m_hSteamLeaderboard)

sdk.on('GameOverlayActivated_t', (event) => {
    console.log('overlay', event.m_bActive ? 'opened' : 'closed')
})
```

The [high-level API](high-level-api.md) (`client.achievement`, `client.matchmaking`, ...) is
still there and unchanged. Both can be used in the same process. Use the SDK layer when the
high-level API lacks a call, or when you want Valve's exact semantics.

## Names

| C++ | JavaScript |
|---|---|
| `SteamFriends()` accessor | `sdk.SteamFriends` |
| `SteamGameServerUGC()` (game server variant) | `sdk.SteamGameServerUGC` (same methods as `sdk.SteamUGC`) |
| `SteamNetworkingSockets()` | `sdk.SteamNetworkingSockets` (C++ declares it as `SteamNetworkingSockets_SteamAPI()`) |
| method `GetPersonaName()` | `GetPersonaName()` |
| overloaded `GetStat(const char*, int32*)` / `GetStat(const char*, float*)` | `GetStatInt32` / `GetStatFloat`: the `STEAM_FLAT_NAME` from the header |
| struct `SteamNetworkingIdentity` | class `sdk.SteamNetworkingIdentity` |
| field `m_ulSteamIDLobby` | property `m_ulSteamIDLobby` |
| struct method `SteamNetworkingIdentity::SetSteamID64` | `identity.SetSteamID64(id)` |
| `operator==`, `operator<`, `operator=` | `IsEqualTo`, `IsLessThan`, `Assign` (flat API names) |
| enum `EResult::k_EResultOK` | `sdk.EResult.k_EResultOK` |
| constant `k_uAPICallInvalid` | `sdk.k_uAPICallInvalid` |
| callback `LobbyChatMsg_t` | `sdk.on('LobbyChatMsg_t', handler)` |

Parameter names are the SDK's, including their Hungarian prefixes (`pchName`, `cubData`), so
Valve's parameter docs line up with the result objects described below.

## Values

| C++ type | JavaScript |
|---|---|
| `bool` | `boolean` |
| `int8` ... `uint32`, `int`, `float`, `double` | `number`; integers are range-checked |
| `int64`, `uint64`, `CSteamID`, `CGameID`, `PublishedFileId_t`, `SteamAPICall_t`, 64-bit handles | `bigint` (a safe-integer `number` is accepted as input) |
| enums | `number` (`sdk.EResult.k_EResultOK`); any 32-bit value is accepted, so flags can be OR-ed |
| `const char *` | `string` (UTF-8, must not contain NUL); returned strings may be `null` |
| `const void *` + size | `Uint8Array` / `Buffer` / `ArrayBuffer` |
| `const uint32 *` and other scalar arrays | the matching typed array (`Uint32Array`, `BigUint64Array`, ...) or a plain array |
| `const T &` / `const T *` for a struct `T` | an instance of `sdk.T` |
| `T` by value | an instance of `sdk.T` |
| `SteamParamStringArray_t *` | `string[]` (or `null`) |

Every argument is validated natively before Steam sees it. Errors include buffers smaller
than the size you pass, out-of-range integers, NUL bytes in strings and the wrong struct type.
A failed check throws `sdk.SteamSdkError`, and Steam is never called with bad pointers.

## Outputs

C++ returns extra values through pointers. JavaScript cannot do that, so those parameters are
removed from the call and returned in a result object. `result` holds the C++ return value, and
each output is keyed by its parameter name:

```cpp
bool GetAchievementAndUnlockTime( const char *pchName, bool *pbAchieved, uint32 *punUnlockTime );
```
```js
const { result, pbAchieved, punUnlockTime } = sdk.SteamUserStats.GetAchievementAndUnlockTime('ACH_WIN')
```

- **No outputs:** the method returns the plain value, e.g. `SetAchievement` returns `boolean`.
- **No return value:** a `void` method with outputs returns only the outputs.
- **Two exceptions to the naming:** the output named `result` in two `ISteamNetworkingUtils`
  methods is returned as `resultOut`.
- **In/out values:** pointers Steam both reads and writes, such as a capacity that Steam
  replaces with a count, stay in the argument list. Their final value is returned under the
  same name.
- **Out strings:** `char *` buffers, usually followed by a size parameter, become returned
  strings. You still pass the size, as in C++:

  ```js
  const { result, pchName } = sdk.SteamApps.GetCurrentBetaName(256)
  ```

  Passing a size of 0 sends NULL, which is the SDK's way of asking how large the buffer must be.
- **Out structs:** `FriendGameInfo_t *pFriendGameInfo` and similar are allocated for you and
  returned:

  ```js
  const { result, pFriendGameInfo } = sdk.SteamFriends.GetFriendGamePlayed(steamId)
  if (result) console.log(pFriendGameInfo.m_gameID)
  ```

## Buffers and arrays

Byte buffers and scalar arrays that Steam writes into keep their position in the argument
list, as in C++. You can pass your own typed array (it is filled in place), or pass `undefined`
to have one allocated with the size given by the size argument. Either way the buffer is
returned under its parameter name:

```js
// HAuthTicket GetAuthSessionTicket( void *pTicket, int cbMaxTicket, uint32 *pcbTicket,
//                                   const SteamNetworkingIdentity *pSteamNetworkingIdentity )
const { result: hTicket, pTicket, pcbTicket } = sdk.SteamUser.GetAuthSessionTicket(undefined, 1024, null)
const ticket = pTicket.subarray(0, pcbTicket)

// int GetConnectedControllers( InputHandle_t *handlesOut )   (STEAM_INPUT_MAX_COUNT entries)
const { result: count, handlesOut } = sdk.SteamInput.GetConnectedControllers()
const controllers = handlesOut.subarray(0, count)

// Reuse one buffer for every packet
const packet = Buffer.alloc(1200)
const r = sdk.SteamNetworking.ReadP2PPacket(packet, packet.length, 0)
```

Where the SDK accepts NULL (an optional identity, a buffer passed only to learn its size, an
optional array), pass `null`. The [reference](../sdk/README.md) notes this on each parameter.

Struct arrays work the same way. Inputs take an array of instances; outputs come back as an
array of instances, trimmed to the count Steam reports when it reports one:

```js
// bool GetResultItems( SteamInventoryResult_t resultHandle, SteamItemDetails_t *pOutItemsArray,
//                      uint32 *punOutItemsArraySize )
const sized = sdk.SteamInventory.GetResultItems(handle, 0)          // NULL array: learn the count
const { pOutItemsArray } = sdk.SteamInventory.GetResultItems(handle, sized.punOutItemsArraySize)
for (const item of pOutItemsArray) console.log(item.m_iDefinition, item.m_unQuantity)
```

Steam reads input buffers during the call only, so you can reuse them as soon as it returns.

## Structs

Every SDK struct is a class over a `Uint8Array` that holds the struct's bytes in this
platform's layout. Offsets come from the native addon, so packing differences between Windows
and Linux/macOS are handled for you.

```js
const identity = new sdk.SteamNetworkingIdentity()  // zeroed; runs the C++ constructor if there is one
identity.SetSteamID64(76561197960287930n)           // struct method, through the flat API
identity.m_eType                                    // field read from the bytes
const copy = new sdk.SteamNetworkingIdentity(Uint8Array.from(identity.buffer))
identity.IsEqualTo(copy)                            // true
```

- **Fields** are getters and setters. `char[N]` fields are strings (written NUL-terminated
  and truncated to fit). `uint8[N]` fields are `Uint8Array` views. Other arrays are copied to
  plain arrays. Nested structs are views over the same memory, so `cfg.m_val.m_int32 = 5`
  writes into `cfg`.
- **Unions** expose every member at the same offset, as in C. That's why inspecting a
  `SteamNetworkingIdentity` shows `m_steamID64`, `m_szGenericString`, `m_ip` and the rest
  all at once.
- **`toObject()`** returns a plain object, and `toJSON()` converts bigints to strings;
  `console.log` uses the former.
- **Pointer fields** (rare outside callbacks) read as their address, a `bigint`. JavaScript
  can't dereference them.
- **Passing structs:** pass an instance wherever the SDK takes `const T &`, `const T *` or
  `T`. A `Uint8Array` of the right size, or a plain object with field names (copied into a
  new struct), also works.

A few struct methods call into Steam internally, for example `SteamNetworkingIPAddr::ToString`
and `SteamNetworkingIdentity::ParseString`. These need `init()` first; the rest work without
Steam.

## Call results

Methods that return a `SteamAPICall_t` return a Promise of the call-result struct:

```js
// STEAM_CALL_RESULT( LobbyCreated_t ) SteamAPICall_t CreateLobby( ELobbyType eLobbyType, int cMaxMembers );
const created = await sdk.SteamMatchmaking.CreateLobby(sdk.ELobbyType.k_ELobbyTypePublic, 4)
if (created.m_eResult === sdk.EResult.k_EResultOK) console.log('lobby', created.m_ulSteamIDLobby)
```

The Promise rejects with `SteamSdkError` in three cases:

- the call returns `k_uAPICallInvalid` (Steam refused to start it),
- Steam reports an I/O failure (`error.ioFailure === true`, `error.handle` is the `SteamAPICall_t`),
- Steam is re-initialized or shut down first.

A failure the SDK reports inside the struct, such as `m_eResult` or `m_bLeaderboardFound`,
still resolves: check those fields as Valve's docs say.

`SteamHTTP.SendHTTPRequest` and `SendHTTPRequestAndStreamResponse` return their
`SteamAPICall_t` through the `pCallHandle` out parameter. Wait for those with
`awaitCallResult`, before the next callback pump (in practice, in the same synchronous block):

```js
const { result, pCallHandle } = sdk.SteamHTTP.SendHTTPRequest(request)
const completed = await sdk.awaitCallResult(pCallHandle, 'HTTPRequestCompleted_t')
```

## Callbacks

`sdk.on(name, handler)` subscribes to a broadcast callback by its struct name. It returns a
handle with `disconnect()`. `sdk.once(name)` resolves with the next occurrence.

```js
const sub = sdk.on('LobbyChatMsg_t', (msg, source) => {
    const buffer = Buffer.alloc(4096)
    const entry = sdk.SteamMatchmaking.GetLobbyChatEntry(msg.m_ulSteamIDLobby, msg.m_iChatID, buffer, buffer.length)
    console.log(entry.pSteamIDUser, buffer.subarray(0, entry.result).toString())
})
// later
sub.disconnect()
```

- **Dispatch:** `init()` starts a loop that runs Steam's callbacks about 30 times a second and
  then delivers them to your handlers on the main thread. Calling SDK methods from inside a
  handler is fine.
- **Copies:** each handler gets its own struct instance, copied from Steam's memory.
- **String fields:** pointer fields that hold strings, such as the URLs in the `HTML_*`
  callbacks, are copied while the callback is live. `HTML_NeedsPaint_t.pBGRA` comes through
  as the frame's pixels.
- **Source:** the second argument is `'client'` or `'gameServer'`, depending on which Steam
  pipe the callback came from.
- **Shared ids:** a few ids are shared by two structs in the SDK, for example 1112 is both
  `GlobalStatsReceived_t` and `PS3TrophiesInstalled_t`. Handlers for both are called.
- **Errors:** if a handler throws, the other handlers still run, and the first error is
  rethrown once dispatch finishes.

Callbacks are only copied for names that have at least one handler, so unused callbacks cost
nothing.

## Game servers

The `SteamGameServer*` accessors need the game server API:

```js
const steamworks = require('@kyeshmz/steamworks.js')
// SteamGameServer_Init( unIP, usGamePort, usQueryPort, eServerMode, pchVersionString )
steamworks.initGameServer(0, 27015, 27016, 2 /* eServerModeAuthentication */, '1.0.0.0')
const { sdk } = steamworks
sdk.SteamGameServer.SetProduct('my-game')
sdk.SteamGameServer.LogOnAnonymous()
sdk.on('SteamServersConnected_t', (_, source) => {
    if (source === 'gameServer') console.log('server id', sdk.SteamGameServer.GetSteamID())
})
// ...
steamworks.shutdownGameServer()
```

A dedicated server can call `initGameServer` without `init()`. A listen server can call both.
Call results from game-server interfaces resolve through the game server's pipe automatically.

## Server browser

`ISteamMatchmakingServers` reports results by calling methods on an object the game
implements. Pass a JavaScript object with the methods you need, named as in the C++
response interfaces. They are called from the callback pump.

```js
const filter = new sdk.MatchMakingKeyValuePair_t()
filter.m_szKey = 'gamedir'
filter.m_szValue = 'spacewar'

const hRequest = sdk.SteamMatchmakingServers.RequestInternetServerList(480, [filter], 1, {
    ServerResponded(hRequest, iServer) {
        const server = sdk.SteamMatchmakingServers.GetServerDetails(hRequest, iServer)
        console.log(server.GetName(), server.m_nPlayers, server.m_nPing)
    },
    RefreshComplete(hRequest, response) {
        sdk.SteamMatchmakingServers.ReleaseRequest(hRequest)
    },
})

sdk.SteamMatchmakingServers.ServerRules(ip, queryPort, {
    RulesResponded(pchRule, pchValue) { console.log(pchRule, '=', pchValue) },
    RulesRefreshComplete() {},
})
```

Release every list request with `ReleaseRequest`, as in C++. The response object stays
referenced until then. `HServerListRequest` values are opaque `bigint`s; the native side
checks them against the requests it created, so a released or made-up handle throws instead
of reaching Steam. A ping, player or rules query ends at its last response, or when you call
`CancelServerQuery`.

## What is not available

The [coverage page](../sdk/coverage.md) lists every method that is not generated, with the
reason. In short:

- **Hand-written methods.** A few methods are implemented by hand because their parameters
  need custom marshalling:
  - **`ReceiveMessages*`** (`SteamNetworkingMessages`, `SteamNetworkingSockets`) return
    `{ result, ppOutMessages }`. Each message is a `SteamNetworkingMessage_t` with a copy of
    its payload in `.data`. The native messages are released immediately, so there is nothing
    to `Release()`.
  - **`SteamNetworkingSockets.SendMessages(n, messages)`** takes objects such as
    `{ data, m_conn, m_nFlags, m_idxLane, m_nUserData }` and allocates the native messages
    itself.
  - **`SteamNetworkingUtils.SetConfigValue(...)`** takes the value as a number, bigint or
    string, according to `eDataType`.
  - **`SteamInput.EnableActionEventCallbacks(handler)`** takes a function, or `null` to turn it
    off, where C++ takes a function pointer. Steam calls a native function that queues each
    `SteamInputActionEvent_t`, and your handler receives it on the next callback pump.
- **Not available.** Methods that take native function pointers or C++ objects you would
  implement (custom signaling, the global networking callbacks), or that return raw native
  objects. Most have an equivalent through `sdk.on(...)`, and the
  reason text says which.
- **Not exposed.** `ISteamClient`, the pipe and user plumbing that `init()` handles. The
  `ISteamMatchmaking*Response` interfaces aren't exposed either: you implement them as plain
  objects (see [Server browser](#server-browser)).

Calling an unavailable method throws `SteamSdkError` with the reason.

## Safety model

The native side declares its own `extern "C"` signatures, derived from the SDK headers that
steamworks-sys's bindings were generated from. Enums cross the boundary as plain integers,
so an unknown value from a newer Steam client, or OR-ed flags you pass in, can't produce an
invalid value in Rust. Every pointer passed to Steam is one of these:

- memory owned by the native side for the duration of the call,
- a typed array or struct buffer checked against the size Steam will access,
- NULL where the SDK documents NULL as valid.

Results are copied out before the call returns.

What this cannot protect against is passing a handle Steam does not expect, such as a stale
`HSteamNetConnection` or a lobby ID you are not in. Steam validates those itself, as it does
in C++.
