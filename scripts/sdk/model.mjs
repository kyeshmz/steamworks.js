// Builds the model that every emitter consumes.
//
// Inputs: steam_api.json (meaning) + steamworks-sys bindgen output (types)
// + overrides.mjs (what the JSON leaves out).
//
// Parameter kinds (what JavaScript passes / gets back):
//   scalar       number | bigint | boolean, passed by value
//   cstr         string (UTF-8), `const char *`
//   mem          caller memory: a TypedArray / Buffer (buffers and scalar arrays)
//   struct       a struct instance (pointer or reference to one struct)
//   structArray  an array of struct instances, packed into one buffer
//   structValue  a struct instance passed by value
//   strArray     string[] marshalled into SteamParamStringArray_t
//   cstrList     string[] marshalled into a NULL-terminated `const char **`
//   out          scalar written by Steam, returned in the result object
//   inout        scalar read and written by Steam; passed in, returned
//   outString    char buffer written by Steam, returned as a string
//   outCStrPtr   `char **` written by Steam, returned as a string
//   nullOnly     always NULL (type not available in the public SDK)
//
// Return kinds: void | scalar | cstr | callResult | structValue | structCopy | bytes

import {
    methodOverrides, structMethodsRequiringSteam, paramPatterns, interfaceExclusions,
    manualMethods, unsupportedMethods, pendingInterfaces,
} from './overrides.mjs'
import { resolve, typeToString } from './bindings.mjs'

const NUM_INFO = {
    bool: { size: 1, js: 'boolean', array: 'Uint8Array' },
    i8: { size: 1, js: 'number', array: 'Int8Array' },
    u8: { size: 1, js: 'number', array: 'Uint8Array' },
    i16: { size: 2, js: 'number', array: 'Int16Array' },
    u16: { size: 2, js: 'number', array: 'Uint16Array' },
    i32: { size: 4, js: 'number', array: 'Int32Array' },
    u32: { size: 4, js: 'number', array: 'Uint32Array' },
    i64: { size: 8, js: 'bigint', array: 'BigInt64Array' },
    u64: { size: 8, js: 'bigint', array: 'BigUint64Array' },
    f32: { size: 4, js: 'number', array: 'Float32Array' },
    f64: { size: 8, js: 'number', array: 'Float64Array' },
    isize: { size: 8, js: 'bigint', array: 'BigInt64Array' },
    usize: { size: 8, js: 'bigint', array: 'BigUint64Array' },
}
export { NUM_INFO }

// Records that are really 64-bit integers in the flat API.
const U64_RECORDS = new Set(['CSteamID', 'CGameID'])

export function buildModel({ api, bindings, platformBindings, docs }) {
    const b = bindings
    const problems = []
    const jsonEnums = new Map(api.enums.map(e => [e.enumname, e]))
    const callbackByName = new Map(api.callback_structs.map(c => [c.struct, c]))

    // ---- enums --------------------------------------------------------------
    const enums = api.enums.map(e => {
        const rustName = e.fqname ? e.fqname.replace('::', '_') : e.enumname
        const be = b.enums.get(rustName)
        if (!be) problems.push(`enum ${e.enumname} missing from bindings`)
        return {
            name: e.enumname,
            rustName,
            repr: be?.repr ?? 'i32',
            values: e.values.map(v => ({ name: v.name, value: Number(v.value), doc: docs.enumValues?.[v.name] })),
            doc: docs.enums?.[e.enumname],
        }
    })
    // nested enums declared inside structs/interfaces
    for (const owner of [...api.structs, ...api.callback_structs, ...api.interfaces]) {
        for (const e of owner.enums ?? []) {
            if (jsonEnums.has(e.enumname)) continue
            const rustName = `${owner.struct ?? owner.classname}_${e.enumname}`
            const be = b.enums.get(rustName)
            enums.push({
                name: e.enumname,
                rustName,
                repr: be?.repr ?? 'i32',
                values: e.values.map(v => ({ name: v.name, value: Number(v.value), doc: docs.enumValues?.[v.name] })),
                doc: docs.enums?.[e.enumname],
            })
            jsonEnums.set(e.enumname, e)
        }
    }
    const enumByRust = new Map(enums.map(e => [e.rustName, e]))

    // ---- type helpers -------------------------------------------------------
    /** Describe a by-value bindgen type for scalar use. */
    function scalarOf(type) {
        const { node, via } = resolve(b, type)
        if (node.kind === 'prim' && NUM_INFO[node.name]) return { num: node.name, via, ts: NUM_INFO[node.name].js }
        if (node.kind === 'enum') {
            const en = enumByRust.get(node.name)
            return { num: node.repr, via: null, enumName: en?.name ?? node.name, ts: en?.name ?? 'number' }
        }
        if (node.kind === 'record' && U64_RECORDS.has(node.name)) return { num: 'u64', via: null, ts: 'bigint', record: node.name }
        return null
    }

    // ---- records (structs exposed to JS) -----------------------------------
    const records = new Map() // rustName -> record model
    const recordAlias = new Map() // rust anon name -> JS name
    function jsRecordName(rustName) {
        return recordAlias.get(rustName) ?? rustName
    }
    function fieldKind(type, owner, fieldName) {
        const { node } = resolve(b, type)
        if (node.kind === 'prim' && NUM_INFO[node.name]) return { k: node.name }
        if (node.kind === 'enum') return { k: node.repr, enumName: enumByRust.get(node.name)?.name }
        if (node.kind === 'record') {
            if (U64_RECORDS.has(node.name)) return { k: 'u64' }
            if (node.name.includes('__bindgen_ty_') && !recordAlias.has(node.name)) {
                recordAlias.set(node.name, `${owner}_${fieldName}`)
            }
            ensureRecord(node.name)
            return records.get(node.name)?.opaque ? { k: 'opaque' } : { k: 'struct', name: node.name }
        }
        if (node.kind === 'array') {
            const inner = resolve(b, node.of).node
            if (inner.kind === 'prim' && inner.name === 'i8') return { k: 'string', len: node.len }
            if (inner.kind === 'prim' && inner.name === 'u8') return { k: 'bytes', len: node.len }
            const s = scalarOf(node.of)
            if (s) return { k: 'array', of: s.num, len: node.len, enumName: s.enumName }
            if (inner.kind === 'record') {
                ensureRecord(inner.name)
                return { k: 'structArray', name: inner.name, len: node.len }
            }
            return { k: 'opaque' }
        }
        if (node.kind === 'ptr') {
            const to = resolve(b, node.to).node
            if (to.kind === 'prim' && to.name === 'i8' && !node.mut) return { k: 'cstr' }
            return { k: 'pointer' }
        }
        if (node.kind === 'fnptr') return { k: 'pointer' }
        return { k: 'opaque' }
    }
    function ensureRecord(rustName) {
        if (records.has(rustName)) return records.get(rustName)
        const r = b.records.get(rustName)
        if (!r) {
            problems.push(`record ${rustName} missing from bindings`)
            return null
        }
        const model = { rustName, kind: r.kind, fields: [], opaque: false, methods: [], ctor: null }
        records.set(rustName, model)
        const jsonStruct = api.structs.find(s => s.struct === rustName) ?? callbackByName.get(rustName)
        model.doc = docs.structs?.[rustName]
        model.callbackId = callbackByName.get(rustName)?.callback_id ?? null
        // bindgen writes forward declarations as `{ _unused: [u8; 0] }` (no
        // public fields) and empty structs as `{ pub _address: u8 }`; only the
        // former is opaque. Empty callbacks such as SteamServersConnected_t are real.
        if (r.fields.length === 0) {
            model.opaque = true
            return model
        }
        // `path` is the list of Rust field names from the record to the field.
        const walk = (rec, path, ownerName) => {
            for (const f of rec.fields) {
                if (f.name === '_address' || f.name === 'vtable_' || f.name.startsWith('_bitfield') || f.name.startsWith('__bindgen_padding')) continue
                if (f.name.startsWith('__bindgen_anon_')) {
                    const { node } = resolve(b, f.type)
                    const inner = b.records.get(node.name)
                    if (inner) walk(inner, [...path, { rec: rec === r ? rustName : path.at(-1)?.type, field: f.name, type: node.name }], ownerName)
                    continue
                }
                const kind = fieldKind(f.type, ownerName, f.name)
                model.fields.push({
                    name: f.name,
                    kind,
                    path: [...path.map(p => p.field), f.name],
                    // the records the path walks through, for offset_of!
                    chain: [rustName, ...path.map(p => p.type)],
                    doc: docs.fields?.[`${rustName}.${f.name}`],
                })
            }
        }
        walk(r, [], rustName)
        if (jsonStruct && jsonStruct.fields?.length && model.fields.length === 0) problems.push(`record ${rustName} has no usable fields`)
        return model
    }
    for (const s of api.structs) ensureRecord(s.struct)
    for (const c of api.callback_structs) ensureRecord(c.struct)

    // ---- methods ------------------------------------------------------------
    const methods = []
    function parseCount(spec, params) {
        if (!spec) return null
        const [from, rest] = spec.split(':')
        if (from === 'fixed') return { from: 'fixed', value: Number(rest) }
        if (from === 'const') return constCount(rest)
        const idx = params.findIndex(p => p.name === rest)
        if (idx < 0) return null
        return { from, name: rest, index: idx }
    }
    function constCount(name) {
        const c = b.consts.get(name)
        if (!c) return null
        return { from: 'const', name, value: Number(c.value.replace(/[^0-9]/g, '')) }
    }
    /** Interpret a JSON count annotation: a parameter name or a constant name. */
    function annotationCount(value, params) {
        if (!value) return null
        const first = value.split(',')[0].trim()
        const idx = params.findIndex(p => p.name === first)
        if (idx >= 0) return { from: 'param', name: first, index: idx }
        return constCount(first)
    }

    function classifyMethod({ owner, flat, json, isStruct }) {
        const fn = b.functions.get(flat)
        const ov = methodOverrides[flat] ?? {}
        const m = {
            owner,
            flat,
            jsName: flat.replace(new RegExp(`^SteamAPI_${owner}_`), ''),
            cppName: json.methodname,
            json,
            isStruct,
            params: [],
            ret: null,
            callresult: json.callresult ?? null,
            callback: json.callback ?? null,
            status: 'generated',
            reason: null,
            requiresSteam: !isStruct || structMethodsRequiringSteam.has(flat),
            doc: docs.methods?.[flat],
        }
        if (!fn) {
            m.status = 'unsupported'
            m.reason = 'Not exported by the flat API in this SDK version.'
            problems.push(`function ${flat} missing from bindings`)
            return m
        }
        // Cross-check: every platform exports the same signature.
        for (const pb of platformBindings) {
            const other = pb.functions.get(flat)
            if (!other || other.params.length !== fn.params.length) problems.push(`${flat}: signature differs in ${pb.path}`)
        }
        const ffiParams = fn.params.slice(1) // drop self_
        const jsonParams = json.params
        if (ffiParams.length !== jsonParams.length) {
            problems.push(`${flat}: JSON has ${jsonParams.length} params, bindings ${ffiParams.length}`)
        }
        const params = jsonParams.map((p, i) => ({
            name: p.paramname,
            cType: p.paramtype,
            json: p,
            ffi: ffiParams[i]?.type,
            ov: ov.params?.[p.paramname] ?? {},
        }))
        if (isStruct) {
            params.unshift({ name: 'self', cType: `${owner} *`, json: {}, ffi: fn.params[0].type, ov: {}, isSelf: true })
        }
        for (const p of params) {
            if (p.ffi?.kind === 'ptr') {
                const to = resolve(b, p.ffi.to).node
                if (to.kind === 'record') p.record = to.name
            }
            for (const pat of paramPatterns) if (pat.match(p)) p.ov = { ...pat.apply, ...p.ov }
        }
        m.params = params

        if (manualMethods[flat]) {
            m.status = 'manual'
            m.reason = manualMethods[flat]
        } else if (unsupportedMethods[flat] || ov.status === 'unsupported') {
            m.status = 'unsupported'
            m.reason = unsupportedMethods[flat] ?? ov.reason
        } else if (ov.status === 'manual') {
            m.status = 'manual'
            m.reason = ov.reason
        }

        for (const p of params) classifyParam(m, p, params)
        // Outputs are returned as `{ result, <param>... }`; keep the keys distinct.
        for (const p of params) p.key = p.name === 'result' ? 'resultOut' : p.name
        // A scalar pointer used as another parameter's count is read and written.
        for (const p of params) {
            const c = p.count ?? p.cap
            if (c?.from === 'inout') {
                const target = params[c.index]
                if (target.kind === 'out') target.kind = 'inout'
            }
        }
        classifyReturn(m, fn.ret, json, ov)
        const bad = params.filter(p => p.kind === 'unsupported')
        if (m.status === 'generated' && bad.length) {
            m.status = 'unsupported'
            m.reason = bad.map(p => `${p.name}: ${p.reason}`).join('; ')
        }
        if (m.status === 'generated' && m.ret.kind === 'unsupported') {
            m.status = 'unsupported'
            m.reason = `return value: ${m.ret.reason}`
        }
        return m
    }

    function classifyParam(m, p, params) {
        const ov = p.ov
        const t = p.ffi
        const unsupported = (reason) => Object.assign(p, { kind: 'unsupported', reason })
        if (!t) return unsupported('missing from bindings')
        if (p.isSelf) {
            const rec = ensureRecord(m.owner)
            if (!rec || rec.opaque) return unsupported(`${m.owner} is not defined in the public SDK headers shipped with steamworks-sys`)
            return Object.assign(p, { kind: 'struct', dir: 'inout', record: m.owner })
        }
        if (ov.as === 'nullOnly') return Object.assign(p, { kind: 'nullOnly' })
        if (t.kind === 'fnptr') return unsupported('native function pointer')
        const resolved = resolve(b, t).node
        if (resolved.kind === 'fnptr') return unsupported('native function pointer')
        if (t.kind !== 'ptr') {
            const s = scalarOf(t)
            if (s) return Object.assign(p, { kind: 'scalar', ...s })
            if (resolved.kind === 'record') {
                ensureRecord(resolved.name)
                return Object.assign(p, { kind: 'structValue', record: resolved.name })
            }
            if (resolved.kind === 'ptr') return unsupported('raw native pointer')
            return unsupported(`type ${typeToString(t)}`)
        }
        const isConst = !t.mut
        const toType = t.to
        const to = resolve(b, toType).node
        const a = p.json
        const nextIsCount = () => {
            const i = params.indexOf(p)
            const n = params[i + 1]
            if (!n) return null
            if (n.ffi?.kind !== 'ptr' && scalarOf(n.ffi)?.ts === 'number') return { from: 'param', name: n.name, index: i + 1 }
            if (n.ffi?.kind === 'ptr' && scalarOf(n.ffi.to)?.ts === 'number') return { from: 'inout', name: n.name, index: i + 1 }
            if (n.ffi?.kind === 'ptr' && scalarOf(n.ffi.to)?.num === 'usize') return { from: 'inout', name: n.name, index: i + 1 }
            return null
        }
        const countFromAnnotation = (v) => {
            const c = annotationCount(v, params)
            if (c?.from !== 'param') return c
            const ref = params[c.index]
            // steam_api.json sometimes names the array itself, or another
            // array (GetItemsWithPrices); those are not counts.
            if (ref === p || ref.json.array_count || ref.json.out_array_count) return null
            if (ref.ffi?.kind === 'ptr') c.from = 'inout'
            return c
        }

        // char strings ----------------------------------------------------
        if (to.kind === 'prim' && to.name === 'i8') {
            if (isConst) return Object.assign(p, { kind: 'cstr', nullable: !!ov.nullable })
            if (ov.as === 'array' || p.cType.startsWith('void')) {
                // a byte buffer that happens to be typed char
            } else {
                const cap = parseCount(ov.cap, params) ?? countFromAnnotation(a.out_string_count) ?? nextIsCount()
                if (!cap) return unsupported('char buffer without a size')
                return Object.assign(p, { kind: 'outString', cap })
            }
        }
        if (to.kind === 'array' && resolve(b, to.of).node.name === 'i8') {
            return Object.assign(p, { kind: 'outString', cap: { from: 'fixed', value: to.len } })
        }
        // double pointers ---------------------------------------------------
        if (to.kind === 'ptr') {
            const inner = resolve(b, to.to).node
            if (inner.kind === 'prim' && inner.name === 'i8') {
                if (!to.mut) return Object.assign(p, { kind: 'cstrList', nullable: true })
                return Object.assign(p, { kind: 'outCStrPtr' })
            }
            return unsupported(`pointer to pointer (${typeToString(t)})`)
        }
        // raw byte buffers ---------------------------------------------------
        if ((to.kind === 'prim' && (to.name === 'void' || to.name === 'u8' || to.name === 'i8')) && ov.as !== 'array') {
            const count = parseCount(ov.count, params)
                ?? countFromAnnotation(a.out_buffer_count ?? a.buffer_count)
                ?? nextIsCount()
            if (!count) return unsupported('buffer without a size')
            return Object.assign(p, {
                kind: 'mem', elem: 'u8', count, bytes: true,
                dir: ov.dir ?? (isConst ? 'in' : 'out'), nullable: !!ov.nullable,
            })
        }
        // structs ------------------------------------------------------------
        if (to.kind === 'record' && !U64_RECORDS.has(to.name)) {
            if (to.name === 'SteamParamStringArray_t') return Object.assign(p, { kind: 'strArray', nullable: true })
            if (/^ISteam/.test(to.name)) return unsupported(`native ${to.name} object`)
            const rec = ensureRecord(to.name)
            if (!rec || rec.opaque) return unsupported(`${to.name} is not defined in the public SDK headers shipped with steamworks-sys`)
            const arrayCount = parseCount(ov.count, params) ?? countFromAnnotation(a.out_array_count) ?? countFromAnnotation(a.array_count)
            if (ov.as === 'structArray' || (arrayCount && ov.as !== 'struct')) {
                if (!arrayCount) return unsupported('struct array without a count')
                return Object.assign(p, {
                    kind: 'structArray', record: to.name, count: arrayCount,
                    dir: ov.dir ?? (isConst ? 'in' : 'out'), nullable: !!ov.nullable,
                })
            }
            return Object.assign(p, { kind: 'struct', record: to.name, dir: ov.dir ?? (isConst ? 'in' : 'out'), nullable: !!ov.nullable })
        }
        // scalar pointers ----------------------------------------------------
        const s = scalarOf(toType)
        if (!s) return unsupported(`pointer to ${typeToString(toType)}`)
        const arrayCount = parseCount(ov.count, params)
            ?? countFromAnnotation(a.out_array_count)
            ?? countFromAnnotation(a.out_array_call)
            ?? countFromAnnotation(a.array_count)
        const isArray = ov.as === 'array' || !!arrayCount || isConst
        if (isArray) {
            const count = arrayCount ?? nextIsCount()
            if (!count) return unsupported('array without a count')
            let dir = ov.dir ?? (isConst ? 'in' : 'out')
            // Non-const CSteamID arrays with only array_count are inputs (lists of users).
            if (!ov.dir && !isConst && s.record === 'CSteamID' && a.array_count && !a.out_array_count && !a.out_array_call) dir = 'in'
            return Object.assign(p, {
                kind: 'mem', elem: s.num, enumName: s.enumName, count, bytes: !!ov.bytes,
                dir, nullable: !!ov.nullable,
            })
        }
        if (ov.as === 'inout') return Object.assign(p, { kind: 'inout', ...s })
        return Object.assign(p, { kind: 'out', ...s })
    }

    function classifyReturn(m, ret, json, ov) {
        const r = { cType: json.returntype }
        m.ret = r
        if (ov.ret?.kind === 'bytes') {
            const idx = m.params.findIndex(p => p.name === ov.ret.len)
            return Object.assign(r, { kind: 'bytes', lenIndex: idx })
        }
        if (ret.kind === 'prim' && ret.name === 'void') return Object.assign(r, { kind: 'void' })
        if (json.callresult) {
            if (!callbackByName.has(json.callresult)) return Object.assign(r, { kind: 'unsupported', reason: `unknown call result ${json.callresult}` })
            return Object.assign(r, { kind: 'callResult', record: json.callresult, num: 'u64' })
        }
        if (ret.kind === 'ptr') {
            const to = resolve(b, ret.to).node
            if (to.kind === 'prim' && to.name === 'i8') return Object.assign(r, { kind: 'cstr' })
            if (to.kind === 'record' && !/^ISteam/.test(to.name)) {
                const rec = ensureRecord(to.name)
                if (rec && !rec.opaque) return Object.assign(r, { kind: 'structCopy', record: to.name })
            }
            return Object.assign(r, { kind: 'unsupported', reason: `returns a native ${typeToString(ret)}` })
        }
        const s = scalarOf(ret)
        if (s) return Object.assign(r, { kind: 'scalar', ...s })
        const node = resolve(b, ret).node
        if (node.kind === 'record') {
            ensureRecord(node.name)
            return Object.assign(r, { kind: 'structValue', record: node.name })
        }
        return Object.assign(r, { kind: 'unsupported', reason: `type ${typeToString(ret)}` })
    }

    // ---- interfaces -----------------------------------------------------------
    const interfaces = []
    for (const iface of api.interfaces) {
        const excluded = interfaceExclusions[iface.classname]
        const pending = pendingInterfaces[iface.classname]
        const model = {
            name: iface.classname,
            accessors: (iface.accessors ?? []).map(a => ({
                name: a.name.replace(/_SteamAPI$/, ''),
                flat: a.name_flat,
                kind: a.kind,
            })),
            version: iface.version_string,
            doc: docs.interfaces?.[iface.classname],
            excluded: excluded ?? null,
            pending: pending ?? null,
            methods: [],
        }
        interfaces.push(model)
        for (const json of iface.methods ?? []) {
            const m = classifyMethod({ owner: iface.classname, flat: json.methodname_flat, json, isStruct: false })
            if (excluded) {
                m.status = 'excluded'
                m.reason = excluded
            } else if (pending) {
                m.status = 'pending'
                m.reason = pending
            }
            model.methods.push(m)
            methods.push(m)
        }
        for (const a of model.accessors) {
            const fn = b.functions.get(a.flat)
            if (!fn) problems.push(`accessor ${a.flat} missing from bindings`)
        }
    }
    // struct methods
    for (const s of api.structs) {
        for (const json of s.methods ?? []) {
            const m = classifyMethod({ owner: s.struct, flat: json.methodname_flat, json, isStruct: true })
            const rec = records.get(s.struct)
            rec.methods.push(m)
            methods.push(m)
            if (m.jsName === 'Construct' && m.status === 'generated') rec.ctor = m
        }
    }
    methods.forEach((m, i) => { m.index = i })

    // ---- callbacks ------------------------------------------------------------
    const callbacks = api.callback_structs.map(c => {
        const rec = records.get(c.struct)
        return {
            name: c.struct,
            id: c.callback_id,
            record: rec,
            cstrFields: rec.fields.filter(f => f.kind.k === 'cstr'),
            doc: docs.structs?.[c.struct],
        }
    })
    // The SDK reuses a few ids (e.g. 1112 is both PS3TrophiesInstalled_t and
    // GlobalStatsReceived_t), so an id maps to every struct declared with it.
    const callbacksById = new Map()
    for (const cb of callbacks) {
        if (cb.record.opaque) problems.push(`callback ${cb.name} has no definition`)
        if (!callbacksById.has(cb.id)) callbacksById.set(cb.id, [])
        callbacksById.get(cb.id).push(cb)
    }

    // ---- constants ------------------------------------------------------------
    const C_PRIMS = { 'float': 'f32', 'double': 'f64', 'int': 'i32', 'unsigned int': 'u32', 'short': 'i16', 'unsigned short': 'u16' }
    const consts = api.consts.map(c => {
        const t = { kind: 'named', name: c.consttype }
        const s = scalarOf(t) ?? (C_PRIMS[c.consttype] ? { num: C_PRIMS[c.consttype] } : null)
        const bc = b.consts.get(c.constname)
        let value = bc ? parseRustConst(bc.value) : null
        value ??= evalConst(c.constval, api.consts)
        return { name: c.constname, type: c.consttype, num: s?.num ?? null, value, doc: docs.consts?.[c.constname] }
    }).filter(c => {
        if (c.value === null || c.num === null) {
            problems.push(`const ${c.name} (${c.type}) could not be evaluated`)
            return false
        }
        return true
    })

    // Record aliases may have been created while walking; finish naming.
    for (const r of records.values()) r.name = jsRecordName(r.rustName)

    // The generated offset_of! paths name bindgen records and fields
    // (including anonymous `__bindgen_ty_N` types); they must exist in the
    // Windows and macOS bindings too, or the addon only builds on Linux.
    for (const pb of platformBindings) {
        for (const r of records.values()) {
            if (r.opaque || b.extraRecords?.has(r.rustName)) continue
            for (const f of r.fields) {
                f.path.forEach((fieldName, i) => {
                    const rec = pb.records.get(f.chain[i])
                    if (!rec || !rec.fields.some(x => x.name === fieldName)) {
                        problems.push(`${r.rustName}.${f.path.join('.')}: ${f.chain[i]}.${fieldName} missing in ${pb.path}`)
                    }
                })
            }
        }
        for (const m of methods) {
            for (const p of m.params) {
                const rec = p.record ?? null
                if (rec && !b.extraRecords?.has(rec) && !pb.records.has(rec)) problems.push(`${m.flat}: record ${rec} missing in ${pb.path}`)
            }
        }
    }

    const rustPath = (name) => (b.extraRecords?.has(name) ? `extra::${name}` : `sys::${name}`)
    return { interfaces, methods, records, callbacks, callbacksById, enums, consts, problems, rustPath }
}

function parseRustConst(text) {
    const t = text.trim().replace(/_/g, '')
    if (/^-?\d+$/.test(t)) return BigInt(t)
    if (/^0x[0-9a-fA-F]+$/.test(t)) return BigInt(t)
    if (/^-?\d+\.\d*(e-?\d+)?$/.test(t)) return Number(t)
    return null
}

// Small evaluator for the C constant expressions in steam_api.json
// (arithmetic, shifts, casts, char literals and references to other consts).
function evalConst(expr, all, depth = 0) {
    if (depth > 8) return null
    let e = expr
        .replace(/\(\s*(unsigned int|u?int\d+|SteamItemInstanceID_t|uint32|AppId_t)\s*\)/g, '')
        .replace(/(0x[0-9a-fA-F]+)u?ll/gi, '$1')
        .replace(/(\d+)U\b/g, '$1')
        .replace(/(\d+\.)f\b/g, '$1')
        .replace(/'(.)'/g, (_, ch) => String(ch.charCodeAt(0)))
    e = e.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => {
        const ref = all.find(c => c.constname === name)
        if (!ref) return name
        const v = evalConst(ref.constval, all, depth + 1)
        return v === null ? name : String(v)
    })
    if (/[A-Za-z_]/.test(e.replace(/0x[0-9a-fA-F]+/g, ''))) return null
    try {
        const isFloat = /\d\.\d*|\d\./.test(e)
        if (isFloat) return Function(`"use strict"; return (${e})`)()
        const big = e.replace(/0x[0-9a-fA-F]+|\d+/g, (n) => `${BigInt(n)}n`).replace(/~/g, '~')
        const v = Function(`"use strict"; return (${big})`)()
        return typeof v === 'bigint' ? v : null
    } catch {
        return null
    }
}
