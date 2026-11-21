// Checks the 1:1 SDK layer without a Steam client:
//   node test/sdk-offline.js [package root]
// Struct methods that do not need Steam run against the real libsteam_api;
// callback and call-result dispatch run against a fake native event queue.
// Struct layouts come from the native addon, so running this on each
// platform checks that platform's packing.
const assert = require('node:assert/strict')
const path = require('node:path')

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const steamworks = require(root)
const { sdk } = steamworks
const tables = require(path.join(root, 'lib', 'sdk', 'generated'))
const runtime = require(path.join(root, 'lib', 'sdk', 'runtime'))
const nativePath = {
    'linux-x64': 'linux64/steamworksjs.linux-x64-gnu.node',
    'win32-x64': 'win64/steamworksjs.win32-x64-msvc.node',
    'darwin-arm64': 'osx/steamworksjs.darwin-arm64.node',
    'darwin-x64': 'osx/steamworksjs.darwin-x64.node',
}[`${process.platform}-${process.arch}`]

let passed = 0
function test(name, fn) {
    try {
        fn()
        passed++
    } catch (e) {
        console.error(`FAIL ${name}`)
        throw e
    }
}
async function testAsync(name, fn) {
    try {
        await fn()
        passed++
    } catch (e) {
        console.error(`FAIL ${name}`)
        throw e
    }
}

const FIELD_SIZE = { bool: 1, i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, i64: 8, u64: 8, f32: 4, f64: 8, isize: 8, usize: 8, pointer: 8, cstr: 8 }

test('every struct field lies inside its struct', () => {
    for (const [name, spec] of Object.entries(tables.records)) {
        const cls = sdk[name]
        assert.ok(cls, `${name} is exported`)
        const size = cls.size
        assert.ok(size > 0, `${name} has a size`)
        const layout = cls.$layout
        spec.fields.forEach(([field, kind, arg], i) => {
            const off = layout.offsets[i]
            let len = FIELD_SIZE[kind]
            if (kind === 'string' || kind === 'bytes') len = arg
            if (kind === 'array') len = FIELD_SIZE[arg[0]] * arg[1]
            if (kind === 'struct') len = sdk[arg].size
            if (kind === 'structArray') len = sdk[arg[0]].size * arg[1]
            if (len === undefined) return
            assert.ok(off + len <= size, `${name}.${field} [${off}, ${off + len}) exceeds ${size}`)
        })
        // reading every field must not throw
        const inst = new cls()
        for (const [field, kind] of spec.fields) if (kind !== 'opaque') void inst[field]
    }
})

test('known struct sizes match the C layout', () => {
    assert.equal(sdk.SteamNetworkingIdentity.size, 136)
    assert.equal(sdk.SteamNetworkingIPAddr.size, 18)
    assert.equal(sdk.SteamIPAddress_t.size, 20)
    assert.equal(sdk.ScePadTriggerEffectParam.size, 120)
    assert.equal(sdk.SteamNetworkingFakeIPResult_t.size, 160)
    assert.equal(sdk.SteamServersConnected_t.size, 1) // empty C++ struct
})

test('SteamNetworkingIdentity round-trips through the flat API', () => {
    const id = new sdk.SteamNetworkingIdentity()
    assert.equal(id.IsInvalid(), true)
    id.SetSteamID64(76561197960287930n)
    assert.equal(id.GetSteamID64(), 76561197960287930n)
    assert.equal(id.m_eType, sdk.ESteamNetworkingIdentityType.k_ESteamNetworkingIdentityType_SteamID)
    assert.equal(id.m_steamID64, 76561197960287930n)
    const same = new sdk.SteamNetworkingIdentity()
    same.SetSteamID(76561197960287930n)
    assert.equal(id.IsEqualTo(same), true)
    assert.equal(same.SetGenericString('hello'), true)
    assert.equal(same.GetGenericString(), 'hello')
    assert.equal(id.IsEqualTo(same), false)
    assert.equal(same.SetGenericBytes(Buffer.from([1, 2, 3]), 3), true)
    const bytes = same.GetGenericBytes()
    assert.equal(bytes.cbLen, 3)
    assert.deepEqual([...bytes.result], [1, 2, 3])
    same.SetIPv4Addr(0x0a000002, 1234)
    assert.equal(same.GetIPv4(), 0x0a000002)
    const addr = same.GetIPAddr()
    assert.ok(addr instanceof sdk.SteamNetworkingIPAddr)
    assert.equal(addr.m_port, 1234)
})

test('SteamNetworkingIPAddr and servernetadr_t', () => {
    const ip = new sdk.SteamNetworkingIPAddr()
    ip.SetIPv4(0x7f000001, 27015)
    assert.equal(ip.IsIPv4(), true)
    assert.equal(ip.IsLocalHost(), true)
    assert.equal(ip.GetIPv4(), 0x7f000001)
    assert.equal(ip.m_port, 27015)
    ip.SetIPv6([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 5)
    assert.equal(ip.IsLocalHost(), true)
    const other = new sdk.SteamNetworkingIPAddr()
    other.SetIPv6LocalHost(5)
    assert.equal(ip.IsEqualTo(other), true)

    const a = new sdk.servernetadr_t()
    a.Init(0x0a000001, 27016, 27015)
    assert.equal(a.GetConnectionAddressString(), '10.0.0.1:27015')
    assert.equal(a.GetQueryAddressString(), '10.0.0.1:27016')
    const b = new sdk.servernetadr_t()
    b.Assign(a)
    assert.equal(b.GetConnectionPort(), 27015)
})

test('C++ constructors run for new structs', () => {
    const item = new sdk.gameserveritem_t()
    assert.equal(item.GetName(), '0.0.0.0:0')
    item.SetName('My server')
    assert.equal(item.GetName(), 'My server')
    assert.equal(item.m_szServerName, 'My server')
})

test('nested struct views share memory', () => {
    const cfg = new sdk.SteamNetworkingConfigValue_t()
    cfg.SetInt32(sdk.ESteamNetworkingConfigValue.k_ESteamNetworkingConfig_TimeoutConnected, 5000)
    assert.equal(cfg.m_eDataType, sdk.ESteamNetworkingConfigDataType.k_ESteamNetworkingConfig_Int32)
    assert.equal(cfg.m_val.m_int32, 5000)
    cfg.m_val.m_int32 = 42
    assert.equal(cfg.m_val.m_int32, 42)
    cfg.SetInt64(sdk.ESteamNetworkingConfigValue.k_ESteamNetworkingConfig_TimeoutConnected, 1n << 40n)
    assert.equal(cfg.m_val.m_int64, 1n << 40n)
})

test('char array fields are UTF-8 and NUL-terminated', () => {
    const kv = new sdk.MatchMakingKeyValuePair_t()
    kv.m_szKey = 'gamedir'
    assert.equal(kv.m_szKey, 'gamedir')
    kv.m_szKey = 'x'.repeat(400)
    assert.equal(kv.m_szKey.length, 255)
    kv.m_szValue = 'café'
    assert.equal(kv.m_szValue, 'café')
})

function throwsSdk(fn, pattern) {
    assert.throws(fn, (e) => {
        assert.ok(e instanceof sdk.SteamSdkError, `expected SteamSdkError, got ${e?.constructor?.name}: ${e?.message}`)
        assert.match(e.message, pattern)
        return true
    })
}

test('calls that need Steam fail cleanly before init()', () => {
    throwsSdk(() => sdk.SteamUserStats.GetStatInt32('x'), /SteamUserStats\.GetStatInt32: SteamUserStats\(\) needs init\(\) first/)
    throwsSdk(() => sdk.SteamGameServer.GetSteamID(), /needs initGameServer\(\) first/)
    throwsSdk(() => new sdk.SteamNetworkingIPAddr().ToString(48, true), /needs Steam/)
    assert.deepEqual(sdk.state(), { client: false, gameServer: false })
})

test('unavailable methods explain why', () => {
    throwsSdk(() => sdk.SteamMatchmakingServers.RequestLANServerList(480), /not available from JavaScript: Server browser/)
    throwsSdk(() => sdk.SteamInput.EnableActionEventCallbacks(), /function pointer/)
    throwsSdk(() => sdk.SteamNetworkingUtils.AllocateMessage(16), /SendMessages allocates messages/)
})

test('arguments are validated before Steam sees them', () => {
    const id = new sdk.SteamNetworkingIdentity()
    const ip = new sdk.SteamNetworkingIPAddr()
    throwsSdk(() => id.SetGenericBytes(Buffer.from([1, 2, 3]), 10), /data holds 3 bytes but the call needs 10/)
    throwsSdk(() => id.SetSteamID64('abc'), /steamID must be a number or bigint/)
    throwsSdk(() => id.SetSteamID64(1n << 64n), /does not fit in 64 bits/)
    throwsSdk(() => id.SetSteamID64(2 ** 60), /use a bigint above 2\^53/)
    throwsSdk(() => ip.SetIPv4(-1, 0), /nIP must be between 0 and 4294967295/)
    throwsSdk(() => ip.SetIPv4(1.5, 0), /must be an integer/)
    throwsSdk(() => ip.SetIPv4(1, 70000), /nPort must be between 0 and 65535/)
    throwsSdk(() => ip.SetIPv6([1, 2, 3], 0), /ipv6 holds 3 bytes but the call needs 16/)
    throwsSdk(() => id.SetGenericString('a\0b'), /must not contain NUL/)
    assert.throws(() => id.IsEqualTo(ip), /expected SteamNetworkingIdentity, got SteamNetworkingIPAddr/)
})

test('enums, constants and tables', () => {
    assert.equal(sdk.EResult.k_EResultOK, 1)
    assert.equal(sdk.EResult[1], 'k_EResultOK')
    assert.equal(sdk.k_UGCHandleInvalid, 0xffffffffffffffffn)
    assert.equal(sdk.k_uAppIdInvalid, 0)
    assert.equal(sdk.k_nSteamNetworkingSend_Reliable, 8)
    assert.equal(sdk.callbackIds.LobbyCreated_t, 513)
    for (const [accessor, iface] of tables.accessors) {
        assert.ok(tables.interfaces[iface], `${accessor} -> ${iface}`)
        for (const [, method] of tables.interfaces[iface]) {
            assert.equal(typeof sdk[accessor][method], 'function', `${accessor}.${method}`)
        }
    }
    assert.equal(typeof sdk.SteamGameServerUGC.CreateQueryAllUGCRequestPage, 'function')
})

// ---------------------------------------------------------------------------
// dispatch against a fake native queue

async function dispatchTests() {
    const real = require(path.join(root, 'dist', nativePath))
    let queue = []
    const subscribed = new Map()
    let nextHandle = 1000n
    const fake = {
        sdkLayouts: () => real.sdkLayouts(),
        sdkState: () => [true, false],
        sdkSubscribe: (id, on) => subscribed.set(id, on),
        sdkWatchCallResult: () => {},
        sdkTakeEvents: () => {
            const events = queue
            queue = []
            return events
        },
        // Pretend every call result method returns a fresh handle.
        sdkCall: () => nextHandle++,
    }
    runtime.attach(fake)
    try {
        const bytesOf = (cls, fill) => {
            const inst = new cls()
            fill(inst)
            return Buffer.from(inst.buffer)
        }

        await testAsync('call results resolve with the struct', async () => {
            const promise = sdk.SteamUserStats.FindLeaderboard('Feet Traveled')
            const handle = nextHandle - 1n
            queue.push([1, 0, sdk.callbackIds.LeaderboardFindResult_t, handle, false, bytesOf(sdk.LeaderboardFindResult_t, (r) => {
                r.m_hSteamLeaderboard = 77n
                r.m_bLeaderboardFound = 1
            }), null])
            runtime.pump()
            const result = await promise
            assert.ok(result instanceof sdk.LeaderboardFindResult_t)
            assert.equal(result.m_hSteamLeaderboard, 77n)
            assert.equal(result.m_bLeaderboardFound, 1)
        })

        await testAsync('call results reject on I/O failure and id mismatch', async () => {
            const failing = sdk.SteamUserStats.FindLeaderboard('x')
            queue.push([1, 0, sdk.callbackIds.LeaderboardFindResult_t, nextHandle - 1n, true, Buffer.alloc(0), null])
            const mismatched = sdk.SteamUserStats.FindLeaderboard('y')
            queue.push([1, 0, 9999, nextHandle - 1n, false, Buffer.alloc(4), null])
            runtime.pump()
            await assert.rejects(failing, (e) => e instanceof sdk.SteamSdkError && e.ioFailure === true)
            await assert.rejects(mismatched, /expected LeaderboardFindResult_t/)
        })

        await testAsync('k_uAPICallInvalid rejects immediately', async () => {
            const saved = fake.sdkCall
            fake.sdkCall = () => 0n
            const p = sdk.SteamUserStats.FindLeaderboard('z')
            fake.sdkCall = saved
            await assert.rejects(p, /k_uAPICallInvalid/)
        })

        test('callbacks reach subscribed handlers until disconnected', () => {
            const seen = []
            const handle = sdk.on('GameOverlayActivated_t', (event, source) => seen.push([event.m_bActive, source]))
            assert.equal(subscribed.get(sdk.callbackIds.GameOverlayActivated_t), true)
            const data = bytesOf(sdk.GameOverlayActivated_t, (e) => { e.m_bActive = 1 })
            queue.push([0, 0, sdk.callbackIds.GameOverlayActivated_t, null, false, data, []])
            queue.push([0, 1, sdk.callbackIds.GameOverlayActivated_t, null, false, data, []])
            runtime.pump()
            handle.disconnect()
            assert.equal(subscribed.get(sdk.callbackIds.GameOverlayActivated_t), false)
            queue.push([0, 0, sdk.callbackIds.GameOverlayActivated_t, null, false, data, []])
            runtime.pump()
            assert.deepEqual(seen, [[1, 'client'], [1, 'gameServer']])
        })

        test('shared callback ids reach every struct with that id', () => {
            const seen = []
            const a = sdk.on('GlobalStatsReceived_t', () => seen.push('GlobalStatsReceived_t'))
            const b = sdk.on('PS3TrophiesInstalled_t', () => seen.push('PS3TrophiesInstalled_t'))
            queue.push([0, 0, 1112, null, false, Buffer.alloc(12), []])
            runtime.pump()
            a.disconnect()
            b.disconnect()
            assert.deepEqual(seen.sort(), ['GlobalStatsReceived_t', 'PS3TrophiesInstalled_t'])
        })

        test('pointer fields of callbacks come from the copied extras', () => {
            let url
            const h = sdk.on('HTML_StartRequest_t', (e) => { url = e.pchURL })
            const names = tables.callbacks.find(([, n]) => n === 'HTML_StartRequest_t')[2]
            const extras = names.map((n) => (n === 'pchURL' ? 'https://example.com/' : null))
            queue.push([0, 0, sdk.callbackIds.HTML_StartRequest_t, null, false, Buffer.alloc(sdk.HTML_StartRequest_t.size), extras])
            runtime.pump()
            h.disconnect()
            assert.equal(url, 'https://example.com/')
        })

        test('a throwing handler does not stop other handlers', () => {
            const seen = []
            const a = sdk.on('SteamShutdown_t', () => { throw new Error('boom') })
            const b = sdk.on('SteamShutdown_t', () => seen.push('second'))
            queue.push([0, 0, sdk.callbackIds.SteamShutdown_t, null, false, Buffer.alloc(1), []])
            assert.throws(() => runtime.pump(), /boom/)
            a.disconnect()
            b.disconnect()
            assert.deepEqual(seen, ['second'])
        })

        await testAsync('reset rejects pending call results', async () => {
            const p = sdk.SteamUserStats.FindLeaderboard('pending')
            runtime.reset('Steam was re-initialized')
            await assert.rejects(p, /re-initialized/)
        })

        test('outputs come back in a result object', () => {
            fake.sdkCall = (index, accessor, args) => {
                // GetStatInt32(pchName, pData) -> [result, pData]
                assert.equal(args[0], 'NumGames')
                assert.equal(args[1], undefined)
                return [true, 12]
            }
            assert.deepEqual(sdk.SteamUserStats.GetStatInt32('NumGames'), { result: true, pData: 12 })
            fake.sdkCall = (index, accessor, args) => {
                // GetAuthSessionTicket(pTicket, cbMaxTicket, pcbTicket, identity): the buffer is allocated
                assert.ok(args[0] instanceof Uint8Array)
                assert.equal(args[0].length, 1024)
                assert.equal(args[3], null)
                args[0][0] = 0xab
                return [55, 4]
            }
            const ticket = sdk.SteamUser.GetAuthSessionTicket(undefined, 1024, null)
            assert.equal(ticket.result, 55)
            assert.equal(ticket.pcbTicket, 4)
            assert.equal(ticket.pTicket[0], 0xab)
            fake.sdkCall = (index, accessor, args) => {
                // GetFriendGamePlayed(steamIDFriend, pFriendGameInfo): the struct is allocated
                const info = new sdk.FriendGameInfo_t(args[1])
                info.m_gameID = 480n
                return true
            }
            const played = sdk.SteamFriends.GetFriendGamePlayed(76561197960287930n)
            assert.equal(played.result, true)
            assert.equal(played.pFriendGameInfo.m_gameID, 480n)
        })
    } finally {
        runtime.attach(real)
    }
}

dispatchTests().then(
    () => console.log(`sdk offline checks passed on ${process.platform}-${process.arch} (${passed})`),
    (e) => {
        console.error(e)
        process.exit(1)
    },
)
