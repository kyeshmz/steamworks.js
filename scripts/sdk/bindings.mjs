// Parser for the bindgen output shipped by steamworks-sys
// (`src/{linux,windows,macos}_bindings.rs`).
//
// steam_api.json tells us what a Steamworks function *means* (out parameters,
// call results, array counts). The bindgen output tells us what the compiler
// sees: exact Rust FFI types, enum representations, struct and union fields.
// The generator uses both and cross-checks them, so the extern declarations it
// writes match the headers that steamworks-sys was built from.

import { readFileSync } from 'node:fs'

const PRIMS = {
    'c_char': 'i8', 'c_schar': 'i8', 'c_uchar': 'u8', 'c_short': 'i16', 'c_ushort': 'u16',
    'c_int': 'i32', 'c_uint': 'u32', 'c_longlong': 'i64', 'c_ulonglong': 'u64',
    'c_void': 'void', 'c_float': 'f32', 'c_double': 'f64',
    'i8': 'i8', 'u8': 'u8', 'i16': 'i16', 'u16': 'u16', 'i32': 'i32', 'u32': 'u32',
    'i64': 'i64', 'u64': 'u64', 'f32': 'f32', 'f64': 'f64', 'bool': 'bool',
    'usize': 'usize', 'isize': 'isize',
}

/** Normalize `::std::os::raw::c_int` → `c_int`, collapse whitespace. */
function clean(type) {
    return type
        .replace(/::std::os::raw::/g, '')
        .replace(/::std::option::Option/g, 'Option')
        .replace(/\s+/g, ' ')
        .replace(/ ,/g, ',')
        .trim()
}

/** Split a comma separated list at depth 0 (ignores commas inside <>, (), []). */
function splitTop(text) {
    const out = []
    let depth = 0
    let cur = ''
    for (const ch of text) {
        if ('<([{'.includes(ch)) depth++
        if ('>)]}'.includes(ch)) depth--
        if (ch === ',' && depth === 0) {
            if (cur.trim()) out.push(cur.trim())
            cur = ''
        } else {
            cur += ch
        }
    }
    if (cur.trim()) out.push(cur.trim())
    return out
}

/**
 * Parse a Rust type string into a tree.
 * kinds: prim | named | ptr | array | fnptr
 */
export function parseType(text) {
    const t = clean(text)
    let m
    if ((m = /^\*(mut|const) (.+)$/.exec(t))) return { kind: 'ptr', mut: m[1] === 'mut', to: parseType(m[2]) }
    if ((m = /^\[(.+); (\d+)usize\]$/.exec(t))) return { kind: 'array', of: parseType(m[1]), len: Number(m[2]) }
    if ((m = /^Option<unsafe extern "C" fn\((.*)\)( -> .+)?>$/.exec(t))) return { kind: 'fnptr', text: t }
    if (t === '()') return { kind: 'prim', name: 'void' }
    if (PRIMS[t]) return { kind: 'prim', name: PRIMS[t] }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) return { kind: 'named', name: t }
    return { kind: 'unknown', text: t }
}

/** Parse one bindgen file into maps of typedefs, enums, structs/unions, functions, consts. */
export function parseBindings(path, { stripPrefix } = {}) {
    let src = readFileSync(path, 'utf8')
    if (stripPrefix) src = src.split(stripPrefix).join('')
    const lines = src.split('\n')
    const typedefs = new Map()
    const enums = new Map() // name -> { repr, values: Map(name -> value) }
    const records = new Map() // name -> { kind: 'struct'|'union', packed, fields: [{ name, type }] }
    const functions = new Map() // name -> { params: [{ name, type }], ret }
    const consts = new Map() // name -> { type, value }

    let attrs = []
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmed = line.trim()
        if (trimmed.startsWith('#[')) {
            attrs.push(trimmed)
            continue
        }
        let m
        if ((m = /^pub type ([A-Za-z0-9_]+)(<[^>]*>)? =(.*)$/.exec(trimmed))) {
            let body = m[3]
            while (!body.trimEnd().endsWith(';')) body += ' ' + lines[++i].trim()
            if (!m[2]) typedefs.set(m[1], parseType(body.trim().replace(/;$/, '')))
        } else if ((m = /^pub enum ([A-Za-z0-9_]+) \{$/.exec(trimmed))) {
            const repr = (attrs.find(a => /^#\[repr\((u|i)\d+\)\]$/.test(a)) || '#[repr(u32)]').match(/repr\((\w+)\)/)[1]
            const values = new Map()
            while (!lines[++i].trim().startsWith('}')) {
                const v = /^([A-Za-z0-9_]+) = (-?\d+),$/.exec(lines[i].trim())
                if (v) values.set(v[1], BigInt(v[2]))
            }
            enums.set(m[1], { repr, values })
        } else if ((m = /^pub (struct|union) ([A-Za-z0-9_]+) \{$/.exec(trimmed))) {
            const packed = attrs.some(a => a.includes('packed'))
            const fields = []
            let pending = ''
            while (!lines[++i].trim().startsWith('}')) {
                const fl = lines[i].trim()
                if (fl.startsWith('#[') || fl.startsWith('//')) continue
                pending += (pending ? ' ' : '') + fl
                if (!pending.endsWith(',')) continue
                const f = /^pub ([A-Za-z0-9_]+): (.+),$/.exec(pending)
                if (f) fields.push({ name: f[1], type: parseType(f[2]) })
                pending = ''
            }
            records.set(m[2], { kind: m[1], packed, fields })
        } else if ((m = /^pub struct ([A-Za-z0-9_]+);$/.exec(trimmed)) || (m = /^pub struct ([A-Za-z0-9_]+) \{\}$/.exec(trimmed))) {
            records.set(m[1], { kind: 'struct', packed: false, fields: [] })
        } else if ((m = /^pub fn ([A-Za-z0-9_]+)\((.*)$/.exec(trimmed))) {
            let sig = m[2]
            while (!/;$/.test(sig.trim())) sig += ' ' + lines[++i].trim()
            sig = sig.trim().replace(/;$/, '')
            // sig is now: `params) -> ret` or `params)`
            let depth = 1
            let j = 0
            for (; j < sig.length; j++) {
                if (sig[j] === '(') depth++
                if (sig[j] === ')') depth--
                if (depth === 0) break
            }
            const params = splitTop(sig.slice(0, j)).map(p => {
                const k = p.indexOf(':')
                return { name: p.slice(0, k).trim(), type: parseType(p.slice(k + 1)) }
            })
            const rest = sig.slice(j + 1).trim()
            const ret = rest.startsWith('->') ? parseType(rest.slice(2)) : { kind: 'prim', name: 'void' }
            functions.set(m[1], { params, ret })
        } else if ((m = /^pub const ([A-Za-z0-9_]+): ([^=]+) = (.+);$/.exec(trimmed))) {
            consts.set(m[1], { type: clean(m[2]), value: m[3].trim() })
        }
        if (!trimmed.startsWith('#[')) attrs = []
    }
    return { path, typedefs, enums, records, functions, consts }
}

/**
 * Resolve a type through typedefs until it is a primitive, pointer, array,
 * function pointer, enum or record. Returns { node, via } where `via` is the
 * outermost typedef name (useful for emitting `sys::AppId_t`).
 */
export function resolve(b, type) {
    let node = type
    let via = null
    for (let guard = 0; guard < 32 && node.kind === 'named'; guard++) {
        if (b.enums.has(node.name)) return { node: { kind: 'enum', name: node.name, repr: b.enums.get(node.name).repr }, via }
        if (b.records.has(node.name)) return { node: { kind: 'record', name: node.name }, via }
        if (!b.typedefs.has(node.name)) return { node: { kind: 'unknown', text: node.name }, via }
        via ??= node.name
        node = b.typedefs.get(node.name)
    }
    return { node, via }
}

export function typeToString(t) {
    switch (t.kind) {
        case 'prim': return t.name
        case 'named': return t.name
        case 'ptr': return `*${t.mut ? 'mut' : 'const'} ${typeToString(t.to)}`
        case 'array': return `[${typeToString(t.of)}; ${t.len}]`
        case 'fnptr': return t.text
        default: return t.text ?? t.kind
    }
}
