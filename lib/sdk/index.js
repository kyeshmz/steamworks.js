'use strict'
// The 1:1 Steamworks SDK layer: `require('@kyeshmz/steamworks.js').sdk`.
// See docs/guide/sdk.md and the generated reference in docs/sdk/.

const runtime = require('./runtime')

const sdk = {}
function add(group, values) {
    for (const [name, value] of Object.entries(values)) {
        if (Object.prototype.hasOwnProperty.call(sdk, name)) {
            throw new Error(`steamworks.js sdk: ${group} export ${name} collides with another export`)
        }
        sdk[name] = value
    }
}

add('interface', runtime.interfaces)
add('struct', runtime.structs)
add('enum', runtime.enums)
add('constant', runtime.constants)
add('runtime', {
    sdkVersion: runtime.sdkVersion,
    SteamStruct: runtime.SteamStruct,
    SteamSdkError: runtime.SteamSdkError,
    on: runtime.on,
    once: runtime.once,
    awaitCallResult: runtime.awaitCallResult,
    state: runtime.state,
    callbackIds: runtime.callbackIds,
})

// Used by index.js; not part of the public API.
Object.defineProperties(sdk, {
    _attach: { value: runtime.attach },
    _pump: { value: runtime.pump },
    _reset: { value: runtime.reset },
})

module.exports = sdk
