const { platform, arch } = process

/** @typedef {typeof import('./client.d')} Client */
/** @type {Client} */
let nativeBinding = undefined

if (platform === 'win32' && arch === 'x64') {
    nativeBinding = require('./dist/win64/steamworksjs.win32-x64-msvc.node')
} else if (platform === 'linux' && arch === 'x64') {
    nativeBinding = require('./dist/linux64/steamworksjs.linux-x64-gnu.node')
} else if (platform === 'darwin' && arch === 'x64') {
    nativeBinding = require('./dist/osx/steamworksjs.darwin-x64.node')
} else if (platform === 'darwin' && arch === 'arm64') {
    nativeBinding = require('./dist/osx/steamworksjs.darwin-arm64.node')
} else {
    throw new Error(`Unsupported OS: ${platform}, architecture: ${arch}`)
}

/**
 * The 1:1 Steamworks SDK layer: every ISteam* interface under its C++ accessor
 * name (`sdk.SteamUserStats.SetAchievement(...)`), every struct, callback,
 * enum and constant. See docs/guide/sdk.md.
 * @type {typeof import('./lib/sdk')}
 */
const sdk = require('./lib/sdk')
sdk._attach(nativeBinding)

let runCallbacksInterval = undefined

function startCallbackLoop() {
    clearInterval(runCallbacksInterval)
    runCallbacksInterval = setInterval(() => {
        nativeBinding.runCallbacks()
        sdk._pump()
    }, 1000 / 30)
}

/**
 * Initialize the steam client or throw an error if it fails
 * @param {number} [appId] - App ID of the game to load, if undefined, will search for a steam_appid.txt file
 * @returns {Omit<Client, 'init' | 'runCallbacks' | 'restartAppIfNecessary'> & { sdk: typeof import('./lib/sdk') }}
*/
module.exports.init = (appId) => {
    const { init: internalInit, runCallbacks, restartAppIfNecessary, ...api } = nativeBinding

    // Pending call results belong to the previous client; reject them.
    sdk._reset('Steam was re-initialized')
    internalInit(appId)

    startCallbackLoop()

    for (const key of Object.keys(api)) if (key.startsWith('sdk')) delete api[key]
    return { ...api, sdk }
}

/**
 * Initialize the game server API (SteamGameServer_Init). Callbacks and call
 * results for the game server interfaces (sdk.SteamGameServer,
 * sdk.SteamGameServerUGC, ...) are pumped with the client's.
 * @param {number} unIP - IPv4 address to bind, host order (0 for any)
 * @param {number} usGamePort - game port
 * @param {number} usQueryPort - query port (0xFFFF to share the game port)
 * @param {number} eServerMode - EServerMode: 1 NoAuthentication, 2 Authentication, 3 AuthenticationAndSecure
 * @param {string} pchVersionString - server version, "x.x.x.x"
 * {@link https://partner.steamgames.com/doc/api/steam_gameserver#SteamGameServer_Init}
 */
module.exports.initGameServer = (unIP, usGamePort, usQueryPort, eServerMode, pchVersionString) => {
    nativeBinding.sdkInitGameServer(unIP, usGamePort, usQueryPort, eServerMode, pchVersionString)
    sdk._reset('the game server was re-initialized')
    startCallbackLoop()
}

/**
 * Shut down the game server API (SteamGameServer_Shutdown).
 * {@link https://partner.steamgames.com/doc/api/steam_gameserver#SteamGameServer_Shutdown}
 */
module.exports.shutdownGameServer = () => {
    nativeBinding.sdkShutdownGameServer()
    sdk._reset('the game server was shut down')
}

/**
 * @param {number} appId - App ID of the game to load
 * {@link https://partner.steamgames.com/doc/api/steam_api#SteamAPI_RestartAppIfNecessary}
 * @returns {boolean} 
 */
module.exports.restartAppIfNecessary = (appId) => nativeBinding.restartAppIfNecessary(appId);

/**
 * Enable the steam overlay on electron
 * @param {boolean} [disableEachFrameInvalidation] - Should attach a single pixel to be rendered each frame
*/
module.exports.electronEnableSteamOverlay = (disableEachFrameInvalidation) => {
    const electron = require('electron')
    if (!electron) {
        throw new Error('Electron module not found')
    }

    electron.app.commandLine.appendSwitch('in-process-gpu')
    electron.app.commandLine.appendSwitch('disable-direct-composition')

    if (!disableEachFrameInvalidation) {
        /** @param {electron.BrowserWindow} browserWindow */
        const attachFrameInvalidator = (browserWindow) => {
            browserWindow.steamworksRepaintInterval = setInterval(() => {
                if (browserWindow.isDestroyed()) {
                    clearInterval(browserWindow.steamworksRepaintInterval)
                } else if (!browserWindow.webContents.isPainting()) {
                    browserWindow.webContents.invalidate()
                }
            }, 1000 / 60)
        }

        electron.BrowserWindow.getAllWindows().forEach(attachFrameInvalidator)
        electron.app.on('browser-window-created', (_, bw) => attachFrameInvalidator(bw))
    }
}

const SteamCallback = nativeBinding.callback.SteamCallback
module.exports.SteamCallback = SteamCallback

/** The 1:1 Steamworks SDK layer (also returned by init() as `client.sdk`). */
module.exports.sdk = sdk
