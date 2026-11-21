// Helpers shared by the TypeScript and Markdown emitters.

import { NUM_INFO } from './model.mjs'

export const VALVE = 'https://partner.steamgames.com/doc/api'

/** Valve documentation page for a header file. */
export function pageForLocation(location, docs) {
    if (!location) return 'steam_api'
    const [file, lineText] = location.split(':')
    const line = Number(lineText)
    const base = file.replace(/\.h$/, '')
    const special = {
        steamclientpublic: 'steam_api', steamtypes: 'steam_api', steam_api_common: 'steam_api',
        steamnetworkingtypes: 'steamnetworkingtypes', matchmakingtypes: 'ISteamMatchmakingServers',
        steamnetworkingfakeip: 'ISteamNetworkingSockets', steamhttpenums: 'ISteamHTTP',
        isteamdualsense: 'ISteamInput',
    }
    if (special[base]) return special[base]
    // The interface declared closest above this line in the same header.
    let best = null
    for (const [iface, loc] of Object.entries(docs.diagnostics?.locations?.interfaces ?? {})) {
        const [f, l] = loc.split(':')
        if (f !== file) continue
        const n = Number(l)
        if (n <= line && (!best || n > best.n)) best = { iface, n }
        if (!best && n > line) best = { iface, n: -1 }
    }
    return best?.iface ?? 'steam_api'
}

export function docLocation(docs, kind, name) {
    return docs.diagnostics?.locations?.[kind]?.[name]
}

/** C++ declaration of a method, from steam_api.json. */
export function cppSignature(m) {
    const params = m.json.params.map(p => `${p.paramtype} ${p.paramname}`).join(', ')
    return `${m.json.returntype} ${m.cppName}(${params ? ` ${params} ` : ''})`
}

export function valveMethodUrl(m) {
    return `${VALVE}/${m.owner}#${m.cppName}`
}

/** Escape Valve comment text for use inside a JSDoc block. */
export function jsdocText(text) {
    return text.replace(/\*\//g, '*\\/').replace(/@(see|note)\b/g, '\\@$1')
}

/** Lines of a `/** ... *\/` block, indented. */
export function jsdoc(lines, indent = '') {
    const flat = lines.flatMap(l => (l === null || l === undefined ? [] : String(l).split('\n')))
    while (flat.length && flat.at(-1) === '') flat.pop()
    if (!flat.length) return []
    return [`${indent}/**`, ...flat.map(l => `${indent} *${l ? ` ${l}` : ''}`), `${indent} */`]
}

// ---------------------------------------------------------------------------
// TypeScript types

const TYPED = {
    bool: 'Uint8Array', i8: 'Int8Array', u8: 'Uint8Array', i16: 'Int16Array', u16: 'Uint16Array',
    i32: 'Int32Array', u32: 'Uint32Array', i64: 'BigInt64Array', u64: 'BigUint64Array',
    f32: 'Float32Array', f64: 'Float64Array', isize: 'BigInt64Array', usize: 'BigUint64Array',
}

export function tsScalar(num, enumName) {
    if (enumName) return enumName
    return NUM_INFO[num].js
}

export function tsRecord(model, rust) {
    return model.records.get(rust)?.name ?? rust
}

/** Does this parameter take a JavaScript argument? (mirrors runtime.js) */
export function takesArgument(p) {
    switch (p.kind) {
        case 'scalar': case 'cstr': case 'inout': case 'strArray': case 'cstrList': case 'structValue': case 'mem': return true
        case 'struct': return p.dir !== 'out' && !p.isSelf
        case 'structArray': return p.dir === 'in'
        default: return false
    }
}

export function isOutput(p) {
    switch (p.kind) {
        case 'out': case 'inout': case 'outString': case 'outCStrPtr': return true
        case 'struct': return p.dir === 'out'
        case 'structArray': return p.dir !== 'in'
        case 'mem': return p.dir !== 'in'
        default: return false
    }
}

export function tsParamType(model, p) {
    switch (p.kind) {
        case 'scalar': {
            const t = tsScalar(p.num, p.enumName)
            return t === 'bigint' ? 'bigint | number' : t
        }
        case 'inout': return NUM_INFO[p.num].js === 'bigint' ? 'bigint | number' : tsScalar(p.num, p.enumName)
        case 'cstr': return p.nullable ? 'string | null' : 'string'
        case 'mem': {
            const typed = p.bytes || p.elem === 'u8' ? 'Uint8Array | ArrayBuffer' : TYPED[p.elem]
            const list = p.dir === 'in' && !(p.bytes || p.elem === 'u8') ? ` | readonly ${NUM_INFO[p.elem].js === 'bigint' ? '(bigint | number)' : 'number'}[]` : ''
            const optional = p.dir !== 'in' || p.nullable ? ' | null | undefined' : ''
            return `${typed}${list}${optional}`
        }
        case 'struct': return `${tsRecord(model, p.record)}${p.nullable ? ' | null' : ''}`
        case 'structArray': return `readonly ${tsRecord(model, p.record)}[]${p.nullable ? ' | null' : ''}`
        case 'structValue': return tsRecord(model, p.record)
        case 'strArray': case 'cstrList': return 'readonly string[] | null'
        default: return 'never'
    }
}

export function tsOutType(model, p) {
    switch (p.kind) {
        case 'out': case 'inout': return tsScalar(p.num, p.enumName)
        case 'outString': return 'string'
        case 'outCStrPtr': return 'string | null'
        case 'struct': return tsRecord(model, p.record)
        case 'structArray': return `${tsRecord(model, p.record)}[]`
        case 'mem': return p.bytes || p.elem === 'u8' ? 'Uint8Array' : TYPED[p.elem]
        default: return 'unknown'
    }
}

export function tsReturnType(model, r) {
    switch (r.kind) {
        case 'void': return 'void'
        case 'scalar': return tsScalar(r.num, r.enumName)
        case 'cstr': return 'string | null'
        case 'callResult': return `Promise<${tsRecord(model, r.record)}>`
        case 'structValue': return tsRecord(model, r.record)
        case 'structCopy': return `${tsRecord(model, r.record)} | null`
        case 'bytes': return 'Buffer | null'
        default: return 'never'
    }
}

export const MANUAL_TS = {
    SteamAPI_ISteamNetworkingMessages_ReceiveMessagesOnChannel: {
        params: 'nLocalChannel: number, nMaxMessages: number',
        ret: '{ result: number; ppOutMessages: SteamNetworkingMessageCopy[] }',
    },
    SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnConnection: {
        params: 'hConn: number, nMaxMessages: number',
        ret: '{ result: number; ppOutMessages: SteamNetworkingMessageCopy[] }',
    },
    SteamAPI_ISteamNetworkingSockets_ReceiveMessagesOnPollGroup: {
        params: 'hPollGroup: number, nMaxMessages: number',
        ret: '{ result: number; ppOutMessages: SteamNetworkingMessageCopy[] }',
    },
    SteamAPI_ISteamNetworkingSockets_SendMessages: {
        params: 'nMessages: number, pMessages: readonly SteamNetworkingMessageToSend[]',
        ret: '{ pOutMessageNumberOrResult: bigint[] }',
    },
    SteamAPI_ISteamInput_EnableActionEventCallbacks: {
        params: 'pCallback: ((event: SteamInputActionEvent_t) => void) | null',
        ret: 'void',
    },
    SteamAPI_ISteamNetworkingUtils_SetConfigValue: {
        params: 'eValue: ESteamNetworkingConfigValue, eScopeType: ESteamNetworkingConfigScope, scopeObj: bigint | number, eDataType: ESteamNetworkingConfigDataType, pArg: number | bigint | string',
        ret: 'boolean',
    },
}

/** `name: Type` list for the JavaScript signature (optional only when trailing). */
export function tsParams(model, m) {
    const ps = m.params.filter(takesArgument)
    let trailingOptional = ps.length
    for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i]
        const opt = (p.kind === 'mem' && (p.dir !== 'in' || p.nullable)) || (p.nullable && p.kind !== 'mem')
        if (!opt) break
        trailingOptional = i
    }
    return ps.map((p, i) => `${p.name}${i >= trailingOptional ? '?' : ''}: ${tsParamType(model, p)}`).join(', ')
}

export function tsResult(model, m) {
    const outs = m.params.filter(isOutput)
    const ret = tsReturnType(model, m.ret)
    if (!outs.length) return ret
    const fields = []
    if (m.ret.kind !== 'void') fields.push(`result: ${ret}`)
    for (const p of outs) fields.push(`${p.key ?? p.name}: ${tsOutType(model, p)}`)
    return `{ ${fields.join('; ')} }`
}

/** Text describing a parameter for docs. */
export function paramNote(model, p, m) {
    const parts = []
    if (p.json?.desc) parts.push(p.json.desc)
    const count = (c) => {
        if (!c) return ''
        if (c.from === 'param') return `\`${c.name}\``
        if (c.from === 'inout') return `the value passed for \`${c.name}\``
        return c.name ? `\`${c.name}\` (${c.value})` : String(c.value)
    }
    switch (p.kind) {
        case 'out': parts.push('Output: returned in the result object.'); break
        case 'inout': parts.push('In/out: pass the input value; the value Steam writes is returned in the result object.'); break
        case 'outString': parts.push(`Output string; buffer size ${count(p.cap)}.`); break
        case 'outCStrPtr': parts.push('Output string returned in the result object.'); break
        case 'mem':
            if (p.dir === 'in') parts.push(`Input ${p.bytes || p.elem === 'u8' ? 'bytes' : 'array'}; Steam reads ${count(p.count)} ${p.bytes || p.elem === 'u8' ? 'bytes' : 'elements'}.`)
            else parts.push(`Buffer Steam writes ${count(p.count)} ${p.bytes || p.elem === 'u8' ? 'bytes' : 'elements'} into. ${p.nullable ? 'Omit or pass null to send NULL.' : 'Omit to have one allocated.'} Returned in the result object.`)
            if (p.nullable && p.dir === 'in') parts.push('May be null.')
            break
        case 'struct':
            if (p.dir === 'out') parts.push('Output struct: allocated for you and returned in the result object.')
            else if (p.nullable) parts.push('May be null.')
            break
        case 'structArray':
            if (p.dir === 'in') parts.push(`Array of structs; Steam reads ${count(p.count)}.`)
            else parts.push(`Output array of ${count(p.count)} structs, returned in the result object.`)
            break
        case 'strArray': parts.push('Array of strings (marshalled into SteamParamStringArray_t), or null.'); break
        case 'cstrList': parts.push('Array of strings (a NULL-terminated list), or null.'); break
        case 'nullOnly': parts.push('Always NULL: the struct is not defined in the public SDK.'); break
    }
    return parts.join(' ')
}
