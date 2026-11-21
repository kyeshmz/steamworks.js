# Maintaining the SDK layer

The SDK layer is generated. Don't edit `src/sdk/generated.rs`, `lib/sdk/generated.js`,
`lib/sdk/index.d.ts` or `docs/sdk/` by hand. Change the generator or its overrides and run:

```sh
pnpm run generate                         # rewrite the generated files
node scripts/sdk/generate.mjs --check     # CI: fail if they are stale
node scripts/sdk/generate.mjs --stats     # classification summary and every non-generated method
node scripts/sdk/generate.mjs --stats --verbose   # every generated method's parameter kinds
```

The generator runs `cargo metadata` to find the steamworks-sys checkout Cargo resolved. That
way it reads the same `steam_api.json`, headers and bindgen output that the addon is compiled
and linked against. Pass `--sdk <steamworks-sys dir>` to use another checkout.

## How it fits together

| Piece | Role |
|---|---|
| `scripts/sdk/bindings.mjs` | Parses steamworks-sys's bindgen output (`src/{linux,windows,macos}_bindings.rs`): functions, typedefs, enum representations, structs and unions. |
| `scripts/sdk/extract-docs.mjs` | Pulls the comments out of the SDK headers, keyed by flat name, with `file:line` locations. |
| `scripts/sdk/model.mjs` | Joins `steam_api.json` (meaning: out parameters, counts, call results) with the bindings (types) and `overrides.mjs`, and classifies every parameter and return value. |
| `scripts/sdk/overrides.mjs` | What `steam_api.json` leaves out or gets wrong, one entry per method, each with a reason. |
| `scripts/sdk/emit-*.mjs` | Write the Rust, JavaScript tables, TypeScript declarations and Markdown reference. |
| `src/sdk/mod.rs` | Native runtime: argument decoding and validation, JS values, the callback and call-result queue, game server lifetime, the `sdk*` exports. |
| `src/sdk/manual.rs` | Methods whose parameters need hand-written marshalling (networking messages, `SetConfigValue`). |
| `src/sdk/extra.rs` | Structs steamworks-sys only forward-declares, transcribed from the headers with size assertions. The generator parses this file too. |
| `lib/sdk/runtime.js` | Turns the tables into accessor objects, struct classes, Promises and `on()`. |
| `vendor/steamworks` | steamworks-rs with a small patch that exposes raw callbacks and call results ([PATCHES.md](../../vendor/steamworks/PATCHES.md)). |

### How a call travels

`sdk.SteamUserStats.GetStatInt32('NumGames')`:

1. **Wrapper.** `runtime.js` builds the argument array in C parameter order.
   - It leaves `undefined` for the pure output `pData`.
   - Out structs and omitted out buffers are allocated here.
   - The array goes to `sdkCall(methodIndex, accessorIndex, args)`.
2. **Dispatch.** `sdk_call` in `mod.rs`:
   - checks that the accessor belongs to the method's interface,
   - checks that Steam (client or game server) is initialized,
   - gets the interface pointer from the accessor (`SteamAPI_SteamUserStats_v012()`),
   - calls the generated function.
3. **Generated function.** It decodes and range-checks each argument, allocates locals for
   outputs, and calls the `extern "C"` flat function. It then returns
   `[returnValue, ...outputs]` (or the bare value when there are no outputs).
4. **Result.** `runtime.js` maps that array onto `{ result, pData }`.

### Callbacks and call results

steamworks-rs drives the callback loop with `SteamAPI_ManualDispatch_*` (in `Client::run_callbacks`). The vendored patch adds two hooks:

- **Raw observer.** It sees every callback's id, pointer and size.
  - `mod.rs` copies only the ids that JavaScript subscribed to.
  - It also copies whatever the callback's pointer fields point to; the generated
    `callback_extras` lists those fields.
- **Raw call-result registry.** Generated methods that return a `SteamAPICall_t` register
  their handle in it. The payload bytes are queued when the call completes.

`index.js` calls `runCallbacks()` and then `sdk._pump()`, which drains the queue, resolves
Promises and calls handlers. Because only JavaScript runs handlers, no Rust lock is held while
your code runs.

## Classification rules

`model.mjs` decides each parameter's kind from its bindgen type, then refines it with the
JSON annotations (`out_string_count`, `out_array_count`, `array_count`, `out_buffer_count`,
`buffer_count`, `out_struct`, `callresult`) and the overrides:

| C type | Default |
|---|---|
| scalars, enums, `CSteamID`/`CGameID` by value | `scalar` |
| `const char *` | `cstr` |
| `char *` | `outString`, with its capacity from `out_string_count` or the next integer parameter |
| `void *` / `uint8 *` | `mem` (a byte buffer); its size from the buffer annotations or the next parameter |
| `T *` for a scalar `T` | `out`; or an array (`mem`) when annotated or `const`; `inout` when another parameter names it as its count |
| `T *` / `T &` for a struct | `struct` (out when non-const), or `structArray` when annotated with a count |
| struct by value | `structValue` |
| `SteamParamStringArray_t *` | `strArray` |
| `const char **` / `char **` | `cstrList` / `outCStrPtr` |
| function pointers, `ISteam*` objects, raw pointers | not available |

Add an entry to `methodOverrides` when the default is wrong. Typical reasons:

- a non-const pointer that Steam only reads,
- an array with no annotation,
- a parameter the SDK allows to be NULL,
- an annotation naming the wrong parameter.

Write the reason next to the entry. Check the result with `--stats --verbose`.

To hand-write a method:

1. List it in `manualMethods`.
2. Implement `pub unsafe fn <flat name>(env, iface, pipe, args)` in `src/sdk/manual.rs`.
3. Add its JavaScript wrapper to `manual` in `lib/sdk/runtime.js`.
4. Add its TypeScript signature to `MANUAL_TS` in `scripts/sdk/common.mjs`.

## Updating steamworks-rs or the Steamworks SDK

1. Update `vendor/steamworks` from the new steamworks-rs revision and re-apply the patch, as
   described in [PATCHES.md](../../vendor/steamworks/PATCHES.md). Point its `steamworks-sys`
   dependency at the same revision.
2. Run `pnpm run build:debug` so Cargo fetches it, then `pnpm run generate`.
3. Read the problems the generator prints, and compare `--stats` with the previous run. New
   methods with ambiguous pointers show up as `generated` with default kinds, so review
   `--stats --verbose` for the interfaces that changed.
4. Run the tests below. CI then builds on every platform and checks the packed tarball on
   Windows and both macOS architectures.

## Tests

| Command | Needs | Checks |
|---|---|---|
| `pnpm run test:sdk` (`node test/sdk-offline.js [package dir]`) | the built addon | Struct layouts on this platform, struct methods through the real flat API, argument validation, guards, and callback and call-result dispatch against a fake queue |
| `node test/sdk-readonly.js 480` | a signed-in Steam client | Read-only SDK calls, a call result and a callback against live Steam |
| `node test/package-smoke.js [package dir]` | the built addon | The high-level API's native argument checks |
| `pnpm --dir test/typescript run compile` | nothing | That a consumer type-checks against both APIs' declarations |
| `node test/steam-readonly.js 480` | a signed-in Steam client | High-level read-only calls |

Writes to Steam (stats, cloud, Workshop, inventory) and two-account networking need manual
tests with a test app.
