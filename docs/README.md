# Documentation

## Using the library

| Page | What it covers |
|---|---|
| [Getting started](guide/getting-started.md) | Install, App IDs and `steam_appid.txt`, the callback loop, Electron, packaging, troubleshooting |
| [High-level API](guide/high-level-api.md) | `client.achievement`, `client.matchmaking`, `client.workshop` and the other namespaces, with the SDK call each one wraps |
| [SDK layer guide](guide/sdk.md) | `client.sdk`: how C++ names, types, out parameters, buffers, structs, call results and callbacks map to JavaScript |
| [SDK reference](sdk/README.md) | Generated: every interface and method, with Valve's header comments and links to Valve's docs |
| [Callbacks](sdk/callbacks.md), [structs](sdk/structs.md), [enums](sdk/enums.md), [constants](sdk/constants.md) | Generated: every type in the SDK |
| [SDK coverage](sdk/coverage.md) | Generated: which methods are hand-written, not yet implemented or not callable from JavaScript, and why |
| [Networking Messages](networking-messages.md) | The high-level `networking_messages` API |
| [Fork features](fork-features.md) | High-level APIs this fork adds over upstream and how they are verified |

## Working on the library

| Page | What it covers |
|---|---|
| [Maintaining the SDK layer](guide/maintaining.md) | The generator, overrides, hand-written methods, updating the SDK, tests |
| [Upstream audit](coverage/README.md) | Upstream issues, pull requests and forks, and what to adopt from them |
| [Vendored steamworks-rs](../vendor/steamworks/PATCHES.md) | Why steamworks-rs is vendored and the patch applied to it |

Valve's documentation is the authority on what each call does:
<https://partner.steamgames.com/doc/api>.
