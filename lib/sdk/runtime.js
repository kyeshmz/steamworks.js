'use strict'
// Runtime for the 1:1 Steamworks SDK layer.
//
// lib/sdk/generated.js describes every interface, method, struct, callback, enum
// and constant in steam_api.json. This file turns those tables into the
// JavaScript API: one object per interface accessor (SteamUser, SteamFriends,
// ...), one class per struct, Promises for call results and `on()` for
// callbacks. The native side (src/sdk) validates every argument again before
// calling Steam, so the checks here are about producing helpful errors.

const { inspect } = require('node:util')
const tables = require('./generated')

/** @type {any} */
let native = null
let layouts = null

/** Thrown for SDK calls that cannot be made from JavaScript, or failed call results. */
class SteamSdkError extends Error {
    constructor(message, details) {
        super(message)
        this.name = 'SteamSdkError'
        Object.assign(this, details)
    }
}

function requireNative() {
    if (!native) throw new SteamSdkError('steamworks.js native addon is not loaded')
    return native
}

// ---------------------------------------------------------------------------
// structs

const TYPED = {
    bool: Uint8Array, i8: Int8Array, u8: Uint8Array, i16: Int16Array, u16: Uint16Array,
    i32: Int32Array, u32: Uint32Array, i64: BigInt64Array, u64: BigUint64Array,
    f32: Float32Array, f64: Float64Array, isize: BigInt64Array, usize: BigUint64Array,
}
const SIZE = { bool: 1, i8: 1, u8: 1, i16: 2, u16: 2, i32: 4, u32: 4, i64: 8, u64: 8, f32: 4, f64: 8, isize: 8, usize: 8 }
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function readScalar(view, off, k) {
    switch (k) {
        case 'bool': return view.getUint8(off) !== 0
        case 'i8': return view.getInt8(off)
        case 'u8': return view.getUint8(off)
        case 'i16': return view.getInt16(off, true)
        case 'u16': return view.getUint16(off, true)
        case 'i32': return view.getInt32(off, true)
        case 'u32': return view.getUint32(off, true)
        case 'i64': case 'isize': return view.getBigInt64(off, true)
        case 'u64': case 'usize': case 'pointer': return view.getBigUint64(off, true)
        case 'f32': return view.getFloat32(off, true)
        case 'f64': return view.getFloat64(off, true)
    }
    return undefined
}

function writeScalar(view, off, k, v) {
    switch (k) {
        case 'bool': return view.setUint8(off, v ? 1 : 0)
        case 'i8': return view.setInt8(off, v)
        case 'u8': return view.setUint8(off, v)
        case 'i16': return view.setInt16(off, v, true)
        case 'u16': return view.setUint16(off, v, true)
        case 'i32': return view.setInt32(off, v, true)
        case 'u32': return view.setUint32(off, v, true)
        case 'i64': case 'isize': return view.setBigInt64(off, BigInt(v), true)
        case 'u64': case 'usize': return view.setBigUint64(off, BigInt(v), true)
        case 'f32': return view.setFloat32(off, v, true)
        case 'f64': return view.setFloat64(off, v, true)
    }
    throw new TypeError(`cannot write field of kind ${k}`)
}

function readString(bytes) {
    const end = bytes.indexOf(0)
    return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end))
}

/** Base class of every SDK struct: a typed view over the struct's bytes. */
class SteamStruct {
    /**
     * @param {Uint8Array | ArrayBuffer} [bytes] existing struct bytes (shared, not copied).
     * Without bytes a zeroed struct is allocated and the C++ constructor (if any) runs.
     */
    constructor(bytes) {
        const layout = layoutOf(this.constructor)
        if (bytes === undefined) {
            this.buffer = new Uint8Array(layout.size)
            const ctor = this.constructor.$ctor
            if (ctor) ctor.call(this)
        } else {
            const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
            if (u8.byteLength < layout.size) {
                // Callbacks may arrive shorter than this struct (shared ids); pad with zeros.
                const padded = new Uint8Array(layout.size)
                padded.set(u8)
                this.buffer = padded
            } else {
                this.buffer = u8.byteLength === layout.size ? u8 : u8.subarray(0, layout.size)
            }
        }
        this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
    }

    /** Size of this struct in bytes on the current platform. */
    static get size() {
        return layoutOf(this).size
    }

    /** Plain object with every field (nested structs become plain objects). */
    toObject() {
        const out = {}
        for (const [name] of this.constructor.$fields) {
            const v = this[name]
            out[name] = v instanceof SteamStruct ? v.toObject()
                : Array.isArray(v) ? v.map(x => (x instanceof SteamStruct ? x.toObject() : x))
                    : v instanceof Uint8Array ? Array.from(v)
                        : v
        }
        return out
    }

    /** JSON form: like toObject() with bigints as strings. */
    toJSON() {
        return JSON.parse(JSON.stringify(this.toObject(), (_, v) => (typeof v === 'bigint' ? v.toString() : v)))
    }

    [inspect.custom](depth, options) {
        return `${this.constructor.name} ${inspect(this.toObject(), { ...options, depth: options.depth == null ? null : options.depth - 1 })}`
    }
}

const recordClasses = {}

function layoutOf(cls) {
    if (!cls.$layout) {
        if (!layouts) layouts = requireNative().sdkLayouts()
        const entry = layouts[cls.$name]
        if (!entry) throw new SteamSdkError(`no native layout for ${cls.$name}`)
        cls.$layout = { size: entry[0], offsets: entry[1] }
    }
    return cls.$layout
}

function defineRecord(name, spec) {
    // A named class so stack traces and inspect() show the SDK name.
    const cls = { [name]: class extends SteamStruct {} }[name]
    cls.$name = name
    cls.$fields = spec.fields
    cls.$callback = spec.callback
    recordClasses[name] = cls
    spec.fields.forEach(([field, kind, arg], i) => {
        const off = () => layoutOf(cls).offsets[i]
        const desc = { enumerable: true, configurable: true }
        switch (kind) {
            case 'string':
                desc.get = function () { return readString(this.buffer.subarray(off(), off() + arg)) }
                desc.set = function (v) {
                    const target = this.buffer.subarray(off(), off() + arg)
                    target.fill(0)
                    encoder.encodeInto(String(v), target.subarray(0, arg - 1))
                }
                break
            case 'bytes':
                desc.get = function () { return this.buffer.subarray(off(), off() + arg) }
                desc.set = function (v) { this.buffer.subarray(off(), off() + arg).set(v) }
                break
            case 'array': {
                const [of, len] = arg
                desc.get = function () {
                    const out = new Array(len)
                    for (let j = 0; j < len; j++) out[j] = readScalar(this.view, off() + j * SIZE[of], of)
                    return out
                }
                desc.set = function (v) {
                    for (let j = 0; j < len; j++) writeScalar(this.view, off() + j * SIZE[of], of, v[j] ?? 0)
                }
                break
            }
            case 'struct':
                desc.get = function () {
                    const inner = recordClasses[arg]
                    return new inner(this.buffer.subarray(off(), off() + layoutOf(inner).size))
                }
                desc.set = function (v) { this.buffer.set(structBytes(v, arg), off()) }
                break
            case 'structArray': {
                const [inner, len] = arg
                desc.get = function () {
                    const cls2 = recordClasses[inner]
                    const size = layoutOf(cls2).size
                    return Array.from({ length: len }, (_, j) => new cls2(this.buffer.subarray(off() + j * size, off() + (j + 1) * size)))
                }
                break
            }
            case 'cstr':
                // Pointer fields of callbacks are copied natively (see $extras).
                desc.get = function () {
                    const extras = this.$extras
                    const idx = cls.$extraIndex?.[field]
                    if (extras && idx !== undefined) return extras[idx]
                    return readScalar(this.view, off(), 'pointer')
                }
                break
            case 'pointer':
                desc.get = function () { return readScalar(this.view, off(), 'pointer') }
                break
            case 'opaque':
                return
            default:
                desc.get = function () { return readScalar(this.view, off(), kind) }
                desc.set = function (v) { writeScalar(this.view, off(), kind, v) }
        }
        Object.defineProperty(cls.prototype, field, desc)
    })
    return cls
}

/** Bytes of a struct argument: an instance of the right class, or raw bytes. */
function structBytes(value, name) {
    if (value instanceof SteamStruct) {
        if (value.constructor.$name !== name) throw new TypeError(`expected ${name}, got ${value.constructor.$name}`)
        return value.buffer
    }
    if (value instanceof Uint8Array) return value
    if (value instanceof ArrayBuffer) return new Uint8Array(value)
    if (value && typeof value === 'object') {
        // A plain object: copy matching fields into a new struct.
        const inst = new recordClasses[name]()
        for (const [k, v] of Object.entries(value)) if (k in inst) inst[k] = v
        return inst.buffer
    }
    throw new TypeError(`expected a ${name} instance`)
}

// ---------------------------------------------------------------------------
// methods

function countOf(spec, nativeArgs) {
    if (!spec) return 0
    const [from, v] = spec
    if (from === 'k') return v
    return Number(nativeArgs[v] ?? 0)
}

function toTypedArray(value, elem, name) {
    const Ctor = TYPED[elem]
    if (value instanceof Ctor) return value
    if (value instanceof ArrayBuffer) return new Ctor(value)
    // Other views pass through; the native side checks their byte length.
    if (ArrayBuffer.isView(value)) return value
    if (Array.isArray(value)) {
        const big = Ctor === BigInt64Array || Ctor === BigUint64Array
        return Ctor.from(value, big ? (x) => BigInt(x) : (x) => (typeof x === 'boolean' ? Number(x) : x))
    }
    throw new TypeError(`${name} must be a ${Ctor.name}, Buffer or array`)
}

/** Parameters that take a JavaScript argument, in order. */
function takesArgument(p) {
    switch (p[0]) {
        case 's': case 'c': case 'io': case 'sa': case 'cl': case 'tv': case 'm': return true
        case 't': return p[2] !== 'out' && p[1] !== 'self'
        case 'ta': return p[2] === 'in'
        default: return false
    }
}

function makeMethod(owner, spec, accessorIndex, manual) {
    const [index, name, params, ret, status, extra] = spec
    const label = `${owner}.${name}`
    if (status === 2) {
        const fn = function () {
            throw new SteamSdkError(`${label} is not available from JavaScript: ${extra}`, { method: label })
        }
        return Object.defineProperty(fn, 'name', { value: name })
    }
    if (status === 1) {
        const impl = manual[extra]
        if (!impl) throw new Error(`missing manual implementation for ${extra}`)
        return Object.defineProperty(impl((args) => callNative(index, accessorIndex, args, label), label), 'name', { value: name })
    }
    const fn = function (...jsArgs) {
        const nativeArgs = new Array(params.length)
        const locals = new Array(params.length)
        let j = 0
        // pass 1: arguments
        for (let i = 0; i < params.length; i++) {
            const p = params[i]
            if (p[1] === 'self' && p[0] === 't') {
                nativeArgs[i] = this.buffer
                continue
            }
            if (!takesArgument(p)) continue
            const v = jsArgs[j++]
            switch (p[0]) {
                case 'tv': nativeArgs[i] = structBytes(v, p[2]); break
                case 't': nativeArgs[i] = v == null && p[4] ? null : structBytes(v, p[3]); break
                case 'ta':
                    if (v == null) { nativeArgs[i] = null; break }
                    nativeArgs[i] = packStructs(v, p[3], p[1])
                    break
                case 'm':
                    if (v == null) { nativeArgs[i] = undefined; break }
                    nativeArgs[i] = toTypedArray(v, p[3], p[1])
                    locals[i] = nativeArgs[i]
                    break
                default: nativeArgs[i] = v
            }
        }
        // pass 2: allocations sized by other arguments
        for (let i = 0; i < params.length; i++) {
            const p = params[i]
            if (p[0] === 't' && p[2] === 'out') {
                locals[i] = new recordClasses[p[3]]()
                nativeArgs[i] = locals[i].buffer
            } else if (p[0] === 'ta' && p[2] !== 'in') {
                const n = countOf(p[4], nativeArgs)
                if (n === 0 && p[5]) { nativeArgs[i] = null; continue }
                const cls = recordClasses[p[3]]
                const size = layoutOf(cls).size
                const buf = new Uint8Array(n * size)
                locals[i] = { buf, cls, size, n }
                nativeArgs[i] = buf
            } else if (p[0] === 'm' && nativeArgs[i] === undefined) {
                if (p[5]) { nativeArgs[i] = null; continue }
                if (p[2] === 'in') throw new TypeError(`${label}: ${p[1]} is required`)
                const n = countOf(p[4], nativeArgs)
                const Ctor = TYPED[p[3]]
                locals[i] = p[6] ? new Ctor(new ArrayBuffer(Math.max(0, n))) : new Ctor(Math.max(0, n))
                nativeArgs[i] = locals[i]
            }
        }
        const raw = callNative(index, accessorIndex, nativeArgs, label)
        return buildResult(params, ret, raw, locals, nativeArgs, label, accessorIndex)
    }
    return Object.defineProperty(fn, 'name', { value: name })
}

/** Call the native method; native errors become SteamSdkError with the JS method name. */
function callNative(index, accessorIndex, args, label) {
    try {
        return requireNative().sdkCall(index, accessorIndex, args)
    } catch (e) {
        const reason = String(e.message).replace(/^SteamAPI_\w+: /, '')
        const err = new SteamSdkError(`${label}: ${reason}`, { method: label, code: e.code })
        err.cause = e
        throw err
    }
}

function packStructs(list, name, label) {
    if (list instanceof Uint8Array) return list
    if (!Array.isArray(list)) throw new TypeError(`${label} must be an array of ${name}`)
    const size = layoutOf(recordClasses[name]).size
    const buf = new Uint8Array(list.length * size)
    list.forEach((v, i) => buf.set(structBytes(v, name).subarray(0, size), i * size))
    return buf
}

function wrapReturn(ret, value, label, accessorIndex) {
    switch (ret[0]) {
        case 'cr': return callResultPromise(value, ret[1], label, accessorIndex)
        case 'tv': return new recordClasses[ret[1]](value)
        case 'tc': return value == null ? null : new recordClasses[ret[1]](value)
        default: return value
    }
}

function buildResult(params, ret, raw, locals, nativeArgs, label, accessorIndex) {
    const nativeOuts = params.some(p => ['o', 'io', 'os', 'op'].includes(p[0]))
    const values = nativeOuts ? raw : [raw]
    let k = 0
    const result = {}
    let hasOutputs = false
    if (ret[0] !== 'v') result.result = wrapReturn(ret, values[k++], label, accessorIndex)
    else if (!nativeOuts) k++
    for (let i = 0; i < params.length; i++) {
        const p = params[i]
        switch (p[0]) {
            case 'o': case 'io': case 'os': case 'op':
                result[p[1]] = values[k++]
                hasOutputs = true
                break
            case 't':
                if (p[2] === 'out') { result[p[1]] = locals[i]; hasOutputs = true }
                break
            case 'ta':
                if (p[2] !== 'in' && locals[i]) {
                    const { buf, cls, size } = locals[i]
                    // When the count is an in/out parameter, Steam reports how many it wrote.
                    let n = locals[i].n
                    if (p[4]?.[0] === 'i') n = Math.min(n, Number(result[params[p[4][1]][1]] ?? n))
                    result[p[1]] = Array.from({ length: n }, (_, j) => new cls(buf.subarray(j * size, (j + 1) * size)))
                    hasOutputs = true
                } else if (p[2] !== 'in') {
                    result[p[1]] = []
                    hasOutputs = true
                }
                break
            case 'm':
                if (p[2] !== 'in') { result[p[1]] = nativeArgs[i]; hasOutputs = true }
                break
        }
    }
    if (!hasOutputs) return ret[0] === 'v' ? undefined : result.result
    return result
}

// ---------------------------------------------------------------------------
// call results and callbacks

// SteamInputActionEvent_t is passed to a function pointer rather than posted
// as a callback; src/sdk/manual.rs queues it under this pseudo id.
const INPUT_ACTION_EVENT_ID = -1
let inputActionHandler = null

const pending = new Map() // handle -> { resolve, reject, name, label }
const listeners = new Map() // callback name -> Set<fn>
const callbackIdByName = new Map()
const callbackNamesById = new Map()
for (const [id, name, extras] of tables.callbacks) {
    callbackIdByName.set(name, id)
    if (!callbackNamesById.has(id)) callbackNamesById.set(id, [])
    callbackNamesById.get(id).push(name)
    const cls = recordClasses[name] ?? null
    if (cls) cls.$extraIndex = Object.fromEntries(extras.map((f, i) => [f, i]))
}

function callResultPromise(handle, name, label, accessorIndex) {
    return new Promise((resolve, reject) => {
        if (!handle) {
            reject(new SteamSdkError(`${label} returned k_uAPICallInvalid`, { method: label }))
            return
        }
        pending.set(handle, { resolve, reject, name, label, accessorIndex })
    })
}

/**
 * Wait for the result of a SteamAPICall_t you got another way (for example
 * the pCallHandle out parameter of SteamHTTP.SendHTTPRequest).
 * @param {bigint} handle
 * @param {string} name call result struct, e.g. 'HTTPRequestCompleted_t'
 * @param {{ gameServer?: boolean }} [options]
 */
function awaitCallResult(handle, name, options = {}) {
    if (!callbackIdByName.has(name)) throw new TypeError(`unknown call result struct ${name}`)
    if (!handle) return Promise.reject(new SteamSdkError('handle is k_uAPICallInvalid'))
    requireNative().sdkWatchCallResult(BigInt(handle), !!options.gameServer)
    return callResultPromise(BigInt(handle), name, 'awaitCallResult', -1)
}

function subscribe(id) {
    const names = callbackNamesById.get(id) ?? []
    const active = names.some(n => (listeners.get(n)?.size ?? 0) > 0)
    requireNative().sdkSubscribe(id, active)
}

/**
 * Listen for a Steam callback by its SDK struct name.
 * The handler receives the struct and which pipe it came from.
 * @param {string} name e.g. 'GameOverlayActivated_t'
 * @param {(event: any, source: 'client' | 'gameServer') => void} handler
 * @returns {{ disconnect(): void }}
 */
function on(name, handler) {
    const id = callbackIdByName.get(name)
    if (id === undefined) throw new TypeError(`unknown callback ${name}`)
    if (typeof handler !== 'function') throw new TypeError('handler must be a function')
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name).add(handler)
    subscribe(id)
    let connected = true
    return {
        disconnect() {
            if (!connected) return
            connected = false
            listeners.get(name)?.delete(handler)
            if (native) subscribe(id)
        },
    }
}

/** Resolve with the next callback of this type. */
function once(name) {
    return new Promise((resolve) => {
        const handle = on(name, (event, source) => {
            handle.disconnect()
            resolve(event)
        })
    })
}

/** Drain the native queue. Called after every runCallbacks(). */
function pump() {
    if (!native) return
    const events = native.sdkTakeEvents()
    let firstError = null
    for (const [kind, pipe, id, handle, failed, data, extras] of events) {
        const source = pipe === 1 ? 'gameServer' : 'client'
        if (kind === 1) {
            const p = pending.get(handle)
            if (!p) continue
            pending.delete(handle)
            const expected = callbackIdByName.get(p.name)
            if (failed) {
                p.reject(new SteamSdkError(`${p.label}: call result failed (I/O failure)`, { method: p.label, handle, ioFailure: true }))
            } else if (id !== expected) {
                p.reject(new SteamSdkError(`${p.label}: expected ${p.name} (${expected}) but Steam returned callback ${id}`, { method: p.label, handle }))
            } else {
                p.resolve(new recordClasses[p.name](data))
            }
            continue
        }
        if (id === INPUT_ACTION_EVENT_ID) {
            if (!inputActionHandler) continue
            try {
                inputActionHandler(new recordClasses.SteamInputActionEvent_t(data))
            } catch (e) {
                if (!firstError) firstError = e
            }
            continue
        }
        for (const name of callbackNamesById.get(id) ?? []) {
            const set = listeners.get(name)
            if (!set?.size) continue
            for (const handler of [...set]) {
                const event = new recordClasses[name](data)
                event.$extras = extras
                try {
                    handler(event, source)
                } catch (e) {
                    if (!firstError) firstError = e
                }
            }
        }
    }
    if (firstError) throw firstError
}

/** Reject pending call results (Steam was shut down or re-initialized). */
function reset(reason) {
    for (const [handle, p] of pending) p.reject(new SteamSdkError(`${p.label}: ${reason}`, { method: p.label, handle }))
    pending.clear()
    if (native) for (const id of callbackNamesById.keys()) subscribe(id)
}

// ---------------------------------------------------------------------------
// manual methods (see src/sdk/manual.rs)

function messageFromNative(bytes, payload) {
    const msg = new recordClasses.SteamNetworkingMessage_t(bytes)
    // The native message is released already; this is a copy of its payload.
    msg.data = payload
    return msg
}

function receiveMessages(call, label) {
    return function (first, nMaxMessages) {
        const [result, flat] = call([first, undefined, nMaxMessages])
        const ppOutMessages = []
        for (let i = 0; i < flat.length; i += 2) ppOutMessages.push(messageFromNative(flat[i], flat[i + 1]))
        return { result, ppOutMessages }
    }
}

const manual = {
    SteamAPI_ISteamNetworkingMessages_ReceiveMessagesOnChannel: receiveMessages,
    SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnConnection: receiveMessages,
    SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnPollGroup: receiveMessages,
    SteamAPI_ISteamNetworkingSockets_SendMessages: (call, label) => function (nMessages, pMessages) {
        if (!Array.isArray(pMessages)) throw new TypeError(`${label}: pMessages must be an array`)
        const flat = []
        for (const m of pMessages) {
            const struct = m instanceof SteamStruct ? m : Object.assign(new recordClasses.SteamNetworkingMessage_t(), m.message ?? {}, pick(m))
            flat.push(struct.buffer, m.data ?? null)
        }
        const [results] = call([nMessages, flat, undefined])
        return { pOutMessageNumberOrResult: results }
    },
    SteamAPI_ISteamInput_EnableActionEventCallbacks: (call, label) => function (pCallback) {
        if (pCallback !== null && typeof pCallback !== 'function') throw new TypeError(`${label}: pCallback must be a function or null`)
        call([pCallback !== null])
        inputActionHandler = pCallback
    },
    SteamAPI_ISteamNetworkingUtils_SetConfigValue: (call) => function (eValue, eScopeType, scopeObj, eDataType, pArg) {
        return call([eValue, eScopeType, scopeObj, eDataType, pArg])
    },
}

function pick(m) {
    const out = {}
    for (const k of ['m_conn', 'm_identityPeer', 'm_nChannel', 'm_nFlags', 'm_nUserData', 'm_idxLane']) if (k in m) out[k] = m[k]
    return out
}

// ---------------------------------------------------------------------------
// assembly

for (const [name, spec] of Object.entries(tables.records)) defineRecord(name, spec)
for (const [name, spec] of Object.entries(tables.records)) {
    const cls = recordClasses[name]
    for (const m of spec.methods) {
        const fn = makeMethod(name, m, -1, manual)
        Object.defineProperty(cls.prototype, m[1], { value: fn, writable: true, configurable: true })
        if (m[0] === spec.ctor) cls.$ctor = fn
    }
}
// re-index pointer-field extras now that the classes exist
for (const [, name, extras] of tables.callbacks) {
    if (recordClasses[name]) recordClasses[name].$extraIndex = Object.fromEntries(extras.map((f, i) => [f, i]))
}

const interfaces = {}
tables.accessors.forEach(([accessor, iface], accessorIndex) => {
    const obj = {}
    for (const spec of tables.interfaces[iface]) obj[spec[1]] = makeMethod(accessor, spec, accessorIndex, manual)
    Object.defineProperty(obj, Symbol.toStringTag, { value: accessor })
    interfaces[accessor] = Object.freeze(obj)
})

const enums = {}
for (const [name, values] of Object.entries(tables.enums)) {
    // Like TypeScript numeric enums: name -> value and value -> name.
    const e = {}
    for (const [k, v] of Object.entries(values)) {
        e[k] = v
        if (!(v in e)) e[v] = k
    }
    enums[name] = Object.freeze(e)
}

function attach(nativeBinding) {
    native = nativeBinding
    layouts = null
    for (const cls of Object.values(recordClasses)) delete cls.$layout
}

/** `{ client, gameServer }`: which Steam APIs are initialized. */
function state() {
    if (!native) return { client: false, gameServer: false }
    const [client, gameServer] = native.sdkState()
    return { client, gameServer }
}

module.exports = {
    attach,
    pump,
    reset,
    state,
    on,
    once,
    awaitCallResult,
    SteamStruct,
    SteamSdkError,
    interfaces,
    structs: recordClasses,
    enums,
    constants: tables.constants,
    sdkVersion: tables.sdkVersion,
    callbackIds: Object.fromEntries(callbackIdByName),
}
