#!/usr/bin/env node
// Generates the 1:1 Steamworks SDK layer from steam_api.json + steamworks-sys.
//
//   node scripts/sdk/generate.mjs           write all generated files
//   node scripts/sdk/generate.mjs --check   fail if a generated file is stale
//   node scripts/sdk/generate.mjs --stats   print the classification summary
//   node scripts/sdk/generate.mjs --sdk <dir>   use a specific steamworks-sys checkout
//
// By default the steamworks-sys checkout that Cargo resolved for this
// repository is used (via `cargo metadata`), so the generated code always
// matches the bindings and SDK binaries the addon links against.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBindings } from './bindings.mjs'
import { buildModel } from './model.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolvePath(here, '..', '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
}

function locateSys() {
    const explicit = option('--sdk')
    if (explicit) return resolvePath(explicit)
    const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--manifest-path', join(root, 'Cargo.toml')], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    }))
    const sys = meta.packages.find(p => p.name === 'steamworks-sys')
    if (!sys) throw new Error('steamworks-sys not found in cargo metadata')
    return dirname(sys.manifest_path)
}

export async function loadInputs(sysDir) {
    const sdkDir = join(sysDir, 'lib', 'steam', 'public', 'steam')
    const api = JSON.parse(readFileSync(join(sdkDir, 'steam_api.json'), 'utf8'))
    const bindings = parseBindings(join(sysDir, 'src', 'linux_bindings.rs'))
    const platformBindings = ['windows', 'macos'].map(p => parseBindings(join(sysDir, 'src', `${p}_bindings.rs`)))
    // Supplemental definitions for records steamworks-sys only forward-declares.
    const extra = parseBindings(join(root, 'src', 'sdk', 'extra.rs'), { stripPrefix: 'sys::' })
    bindings.extraRecords = new Set(extra.records.keys())
    for (const [name, record] of extra.records) bindings.records.set(name, record)
    for (const [name, type] of extra.typedefs) bindings.typedefs.set(name, type)
    let docs = {}
    const extractor = join(here, 'extract-docs.mjs')
    if (existsSync(extractor)) {
        const { extractDocs } = await import(extractor)
        docs = extractDocs(sdkDir, api)
    }
    return { sysDir, sdkDir, api, bindings, platformBindings, docs }
}

async function main() {
    const sysDir = locateSys()
    const inputs = await loadInputs(sysDir)
    const model = buildModel(inputs)
    model.sdkVersion = readSdkVersion(inputs.sdkDir)
    model.sysRevision = sysDir.split('/').filter(Boolean).at(-2)

    if (flag('--stats')) {
        printStats(model)
        return
    }

    const { emitRust } = await import('./emit-rust.mjs')
    const files = { 'src/sdk/generated.rs': emitRust(model, inputs) }
    if (option('--only') !== 'rust') {
        const { emitJs } = await import('./emit-js.mjs')
        const { emitDts } = await import('./emit-dts.mjs')
        const { emitDocs } = await import('./emit-docs.mjs')
        files['lib/sdk/generated.js'] = emitJs(model, inputs)
        files['lib/sdk/index.d.ts'] = emitDts(model, inputs)
        Object.assign(files, emitDocs(model, inputs))
    }
    if (model.problems.length) {
        console.error(`${model.problems.length} problem(s):`)
        for (const p of model.problems) console.error(`  - ${p}`)
        if (flag('--strict')) process.exit(1)
    }
    let stale = 0
    for (const [rel, content] of Object.entries(files)) {
        const path = join(root, rel)
        const current = existsSync(path) ? readFileSync(path, 'utf8') : null
        if (current === content) continue
        if (flag('--check')) {
            console.error(`stale: ${rel}`)
            stale++
            continue
        }
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, content)
        console.log(`wrote ${rel}`)
    }
    if (stale) process.exit(1)
    printStats(model, true)
}

function readSdkVersion(sdkDir) {
    // steam_api_common.h does not carry a version number; the interface
    // version strings identify the SDK, so record a few of them.
    const text = readFileSync(join(sdkDir, 'isteamclient.h'), 'utf8')
    const m = /#define STEAMCLIENT_INTERFACE_VERSION\s+"([^"]+)"/.exec(text)
    return m ? m[1] : 'unknown'
}

function printStats(model, short = false) {
    const by = {}
    for (const m of model.methods) by[m.status] = (by[m.status] ?? 0) + 1
    console.log(`methods: ${model.methods.length}`, by)
    if (short) return
    const kinds = {}
    for (const m of model.methods) for (const p of m.params) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1
    console.log('param kinds', kinds)
    const rets = {}
    for (const m of model.methods) rets[m.ret?.kind] = (rets[m.ret?.kind] ?? 0) + 1
    console.log('return kinds', rets)
    console.log(`records: ${model.records.size}, callbacks: ${model.callbacks.length}, enums: ${model.enums.length}, consts: ${model.consts.length}`)
    for (const m of model.methods.filter(m => m.status !== 'generated' && m.status !== 'excluded')) {
        console.log(`  [${m.status}] ${m.flat}: ${m.reason}`)
    }
    if (model.problems.length) {
        console.log('problems:')
        for (const p of model.problems) console.log(`  - ${p}`)
    }
    if (flag('--verbose')) {
        for (const m of model.methods.filter(m => m.status === 'generated')) {
            const ps = m.params.map(p => `${p.name}:${p.kind}${p.dir ? '/' + p.dir : ''}${p.count ? '#' + (p.count.name ?? p.count.value) : ''}${p.cap ? '#' + (p.cap.name ?? p.cap.value) : ''}${p.nullable ? '?' : ''}`).join(', ')
            console.log(`  ${m.flat}(${ps}) -> ${m.ret.kind}`)
        }
    }
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
