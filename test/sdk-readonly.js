// Read-only checks of the 1:1 SDK layer against a running, signed-in Steam client:
//   node test/sdk-readonly.js 480
// Nothing here writes to Steam: no stats, achievements, cloud files or uploads.
// Use an App ID the signed-in account can run (480 is Valve's Spacewar test app).
const assert = require('node:assert/strict')
const path = require('node:path')

const appId = Number(process.argv[2] || 480)
const steamworks = require(path.join(__dirname, '..'))
const client = steamworks.init(appId)
const { sdk } = client

function step(name, value) {
    console.log(`ok  ${name}`, value === undefined ? '' : value)
}

async function main() {
    assert.deepEqual(sdk.state(), { client: true, gameServer: false })
    assert.equal(sdk.SteamUtils.GetAppID(), appId)
    step('SteamUtils.GetAppID', appId)

    const steamId = sdk.SteamUser.GetSteamID()
    assert.equal(typeof steamId, 'bigint')
    assert.ok(steamId > 0n)
    assert.equal(sdk.SteamUser.BLoggedOn(), true)
    step('SteamUser.GetSteamID', steamId)

    const name = sdk.SteamFriends.GetPersonaName()
    assert.equal(typeof name, 'string')
    step('SteamFriends.GetPersonaName', name)
    assert.equal(name, client.localplayer.getName(), 'SDK and high-level API agree')

    const friends = sdk.SteamFriends.GetFriendCount(sdk.EFriendFlags.k_EFriendFlagImmediate)
    assert.ok(Number.isInteger(friends) && friends >= 0)
    step('SteamFriends.GetFriendCount', friends)

    step('SteamApps.GetCurrentGameLanguage', sdk.SteamApps.GetCurrentGameLanguage())
    step('SteamUtils.GetSteamUILanguage', sdk.SteamUtils.GetSteamUILanguage())
    const beta = sdk.SteamApps.GetCurrentBetaName(256)
    assert.equal(typeof beta.result, 'boolean')
    step('SteamApps.GetCurrentBetaName', beta)

    const dir = sdk.SteamApps.GetAppInstallDir(appId, 1024)
    step('SteamApps.GetAppInstallDir', dir)

    const identity = new sdk.SteamNetworkingIdentity()
    identity.SetSteamID64(steamId)
    const text = identity.ToString(128) // SteamNetworkingIdentity::k_cchMaxString
    assert.match(text.buf, /^steamid:\d+$/)
    step('SteamNetworkingIdentity.ToString', text.buf)

    const now = sdk.SteamNetworkingUtils.GetLocalTimestamp()
    assert.equal(typeof now, 'bigint')
    step('SteamNetworkingUtils.GetLocalTimestamp', now)

    // A call result: resolves through the callback pump that init() started.
    const players = await withTimeout(sdk.SteamUserStats.GetNumberOfCurrentPlayers(), 'GetNumberOfCurrentPlayers')
    assert.ok(players instanceof sdk.NumberOfCurrentPlayers_t)
    step('SteamUserStats.GetNumberOfCurrentPlayers', players.toObject())

    if (appId === 480) {
        const board = await withTimeout(sdk.SteamUserStats.FindLeaderboard('Feet Traveled'), 'FindLeaderboard')
        assert.equal(board.m_bLeaderboardFound, 1)
        assert.equal(sdk.SteamUserStats.GetLeaderboardName(board.m_hSteamLeaderboard), 'Feet Traveled')
        step('SteamUserStats.FindLeaderboard', board.m_hSteamLeaderboard)
    }

    // A broadcast callback: requesting our own persona triggers PersonaStateChange_t.
    const persona = sdk.once('PersonaStateChange_t')
    sdk.SteamFriends.RequestUserInformation(steamId, true)
    const change = await withTimeout(persona, 'PersonaStateChange_t', 10000).catch(() => null)
    step('callback PersonaStateChange_t', change ? change.toObject() : '(not posted: information was already cached)')

    console.log('sdk read-only checks passed')
    process.exit(0)
}

function withTimeout(promise, label, ms = 15000) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
    ])
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
