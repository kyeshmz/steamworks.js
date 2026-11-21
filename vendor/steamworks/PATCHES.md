# Vendored steamworks-rs

This directory is the `steamworks` crate from
[Noxime/steamworks-rs](https://github.com/Noxime/steamworks-rs) at
`fbb79635b06b4feea8261e5ca3e8ea3ef42facf9`, licensed MIT OR Apache-2.0 (see
`LICENSE-MIT` and `LICENSE-APACHE`). `steamworks-sys` is not vendored; it is
fetched from the same upstream revision so the bindings and the Steamworks SDK
redistributables stay identical.

## Why it is vendored

The generated 1:1 SDK layer (`src/sdk`) needs to see every Steam callback and
the payload of every `SteamAPICall_t` it starts. Upstream dispatches callbacks
with `SteamAPI_ManualDispatch_*` inside `Client::run_callbacks` and keeps
`register_call_result` crate-private, so a second consumer cannot read the
queue without starving the first. Only one handler can be registered per
callback id, and a second registration replaces the first.

## The patch

Only `src/lib.rs` and `src/server.rs` differ from upstream:

- `Callbacks` gains `raw_call_results` and `raw_observer`.
- `Client::set_raw_callback_observer` installs one observer that receives
  `(callback id, pointer)` for every callback, after any typed handler.
- `Client::register_raw_call_result` / `cancel_raw_call_result` deliver
  `(callback id, payload bytes, io failure)` for a `SteamAPICall_t`. Typed
  call results registered by the crate itself still take precedence.
- When `GetAPICallResult` fails for a raw call, the handler receives an empty
  payload and `io failure = true` instead of being dropped.

Nothing else changes, so the existing typed APIs behave as upstream.

## Updating

1. Copy `src/`, `LICENSE-*` and `README.md` from the new upstream revision.
2. Re-apply the patch above (search for `steamworks.js patch`).
3. Update the `rev` of `steamworks-sys` in this `Cargo.toml` and regenerate the
   SDK layer with `node scripts/sdk/generate.mjs`.
