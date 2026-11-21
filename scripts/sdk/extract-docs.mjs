#!/usr/bin/env node
/**
 * extract-docs.mjs: collects Valve's comment documentation from the Steamworks SDK
 * public headers and keys it by the names used in `steam_api.json`.
 *
 * Usage (module):
 *   import { extractDocs, docsCoverage } from './extract-docs.mjs';
 *   const docs = extractDocs(sdkDir, api);
 *
 * Usage (CLI):
 *   node scripts/sdk/extract-docs.mjs <sdkDir>          # coverage summary + first 20 unmatched
 *   node scripts/sdk/extract-docs.mjs <sdkDir> --dump   # full DocsIndex as JSON on stdout
 *   node scripts/sdk/extract-docs.mjs <sdkDir> --diagnostics   # the diagnostics object as JSON
 *
 * Inputs
 *   sdkDir  Directory holding the SDK public headers (isteam*.h, steamclientpublic.h,
 *           steamnetworkingtypes.h, matchmakingtypes.h, ...). steam_api_flat.h is skipped.
 *   api     Parsed steam_api.json from that same directory.
 *
 * Output: DocsIndex. Every value is a cleaned comment string, and keys with no docs are left out.
 *   methods     { [methodname_flat]: doc }      interface methods and struct methods
 *   interfaces  { [classname]: doc }            comment above `class ISteamX`
 *   structs     { [struct]: doc }               structs and callback structs (also STEAM_CALLBACK_BEGIN)
 *   fields      { ['Struct.field']: doc }       leading comment lines and/or trailing `// ...`
 *   enums       { [enumname]: doc }             includes enums nested in classes/structs
 *   enumValues  { [valueName]: doc }
 *   consts      { [constname]: doc }            struct-scoped consts use 'Struct::constname'
 *
 *   The index also carries a non-enumerable `diagnostics` property. JSON.stringify skips it.
 *   It holds:
 *     unmatchedHeaderMethods  public methods of API classes that match no JSON method
 *     ignoredNonPublic        private/protected/STEAM_PRIVATE_API methods without a JSON match
 *     unmatchedOutOfLine      `inline X::Y()` definitions outside the class that match nothing
 *     jsonMethodsWithoutHeaderDecl  JSON methods for which no header declaration was found
 *     classesNotInApi         header classes/structs with methods that are not in steam_api.json
 *     paramMismatches         matched methods whose parameter names differ from the JSON
 *     sectionComments         leading comment blocks treated as section headers (see below)
 *     groupMembers            { key: leaderKey } undocumented methods/fields/consts that directly
 *                             follow an item with a leading comment, with no blank line between
 *                             them. They probably share its comment ("// Data accessors" style groups).
 *     locations               { [category]: { [key]: 'file.h:line' } } for every matched item
 *     duplicates              keys documented in more than one place with different text
 *     warnings                parser problems (unbalanced scopes etc.)
 *
 * Attachment rules
 *   - Leading doc: the contiguous run of `//`, `///` or `/* *\/` comment lines that ends right
 *     above a declaration. Lines that hold only STEAM_* annotation macros
 *     (STEAM_FLAT_NAME, STEAM_CALL_RESULT, ...) and #if/#else/#endif/#pragma/#error lines may sit
 *     between the comment and the declaration. A blank line, #define, #include or access label
 *     ends the run. If comments sit on both sides of such a #if block, only the later block counts.
 *     Exception for classes/structs/enums: a block whose first line names the type still
 *     attaches across a single blank line.
 *   - Trailing doc: a comment on the same line after the declaration, plus following
 *     comment-only lines that are indented to the comment column (multi-line trailing comments).
 *   - When an item has both, they are joined with a blank line. If an item has a trailing comment
 *     and so does the item right after it, but that next item has no leading comment of its own,
 *     the leading block is treated as a section header.
 *     It is left out of the item's doc and reported in diagnostics.sectionComments.
 *   - Header methods map to flat names via STEAM_FLAT_NAME( X ) -> SteamAPI_<Class>_X, otherwise
 *     SteamAPI_<Class>_<Name>. If that name is not in the JSON, the method is matched by name and
 *     parameter names. Constructors map to `Construct`, operators to the JSON `operator..` names.
 *
 * Comment cleaning: strips the comment markers (//, ///, ///<, /*, *\/, leading `*`), decorative
 * lines made only of - = / * (3+ chars; a bare `///` is a paragraph break), commented-out
 * enumerators (`//k_EFoo = 3, // old`), and a `Purpose:` prefix. Tabs become spaces at the
 * columns they occupy in the file (4-wide), so aligned tables keep their alignment. Common
 * indentation is removed (all indentation in `Purpose:` blocks), as are trailing whitespace and
 * leading/trailing blank lines, and repeated blank lines collapse. All other wording is kept
 * verbatim (Valve's text). Code samples inside comments keep their own `//` comments.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TAB_WIDTH = 4;

/** Headers that hold no documentation we want (generated flat C declarations). */
const EXCLUDED_HEADERS = new Set(['steam_api_flat.h']);

/** STEAM_* macro calls that are real statements, not annotations to be skipped. */
const CALLBACK_MACROS = new Set([
	'STEAM_CALLBACK_BEGIN',
	'STEAM_CALLBACK_MEMBER',
	'STEAM_CALLBACK_MEMBER_ARRAY',
	'STEAM_CALLBACK_END',
]);

/**
 * Preprocessor directives that do not end a comment run. They are layout only, e.g. the
 * `#if VALVE_CALLBACK_PACK_SMALL / #pragma pack / #error` block between a struct and its comment.
 */
const TRANSPARENT_DIRECTIVES = new Set(['if', 'ifdef', 'ifndef', 'elif', 'else', 'endif', 'pragma', 'error', 'warning']);

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

/**
 * Splits C++ source into tokens:
 *   { type: 'id'|'num'|'str'|'punct', text, line, col }
 *   { type: 'comment', style: 'line'|'block', text, line, endLine, col, trailing }
 *   { type: 'pp', text, line, endLine }            whole preprocessor line, comments included
 *   { type: 'nl', line }
 * `col` is the visual column (tabs expand to TAB_WIDTH). `trailing` is true when code
 * precedes the comment on its line.
 */
function tokenize(src) {
	const toks = [];
	const n = src.length;
	let i = 0;
	let line = 1;
	let col = 0;
	let lineHasCode = false;

	const advance = (ch) => {
		if (ch === '\n') {
			line++;
			col = 0;
		} else if (ch === '\t') {
			col += TAB_WIDTH - (col % TAB_WIDTH);
		} else {
			col++;
		}
	};

	while (i < n) {
		const c = src[i];

		if (c === '\n') {
			toks.push({ type: 'nl', line });
			advance(c);
			lineHasCode = false;
			i++;
			continue;
		}
		if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
			advance(c);
			i++;
			continue;
		}

		const startLine = line;
		const startCol = col;

		// Line comment.
		if (c === '/' && src[i + 1] === '/') {
			let j = src.indexOf('\n', i);
			if (j < 0) j = n;
			toks.push({
				type: 'comment',
				style: 'line',
				text: src.slice(i, j).replace(/\r$/, ''),
				line,
				endLine: line,
				col: startCol,
				trailing: lineHasCode,
			});
			i = j;
			continue;
		}

		// Block comment.
		if (c === '/' && src[i + 1] === '*') {
			let j = src.indexOf('*/', i + 2);
			j = j < 0 ? n : j + 2;
			for (let k = i; k < j; k++) advance(src[k]);
			toks.push({
				type: 'comment',
				style: 'block',
				text: src.slice(i, j),
				line: startLine,
				endLine: line,
				col: startCol,
				trailing: lineHasCode,
			});
			if (line !== startLine) lineHasCode = false;
			i = j;
			continue;
		}

		// Preprocessor directive: swallow the whole logical line (continuations and comments).
		if (c === '#' && !lineHasCode) {
			let j = i;
			let text = '';
			while (j < n && src[j] !== '\n') {
				if (src[j] === '\\' && (src[j + 1] === '\n' || (src[j + 1] === '\r' && src[j + 2] === '\n'))) {
					const skip = src[j + 1] === '\n' ? 2 : 3;
					for (let k = j; k < j + skip; k++) advance(src[k]);
					j += skip;
					text += ' ';
					continue;
				}
				if (src[j] === '/' && src[j + 1] === '*') {
					let e = src.indexOf('*/', j + 2);
					e = e < 0 ? n : e + 2;
					for (let k = j; k < e; k++) advance(src[k]);
					j = e;
					continue;
				}
				if (src[j] === '/' && src[j + 1] === '/') {
					while (j < n && src[j] !== '\n') j++;
					break;
				}
				text += src[j];
				advance(src[j]);
				j++;
			}
			toks.push({ type: 'pp', text: text.trim(), line: startLine, endLine: line });
			i = j;
			continue;
		}

		lineHasCode = true;
		let j = i + 1;
		let type;
		if (/[A-Za-z_]/.test(c)) {
			while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
			type = 'id';
		} else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
			while (j < n && (/[0-9A-Za-z_.']/.test(src[j]) || (/[+-]/.test(src[j]) && /[eEpP]/.test(src[j - 1])))) j++;
			type = 'num';
		} else if (c === '"' || c === "'") {
			while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
			j = Math.min(j + 1, n);
			type = 'str';
		} else if (c === ':' && src[i + 1] === ':') {
			j = i + 2;
			type = 'punct';
		} else {
			type = 'punct';
		}
		toks.push({ type, text: src.slice(i, j), line, col: startCol });
		for (let k = i; k < j; k++) advance(src[k]);
		i = j;
	}
	return toks;
}

const isCode = (t) => t.type !== 'nl' && t.type !== 'comment' && t.type !== 'pp';
const OPEN = { '(': ')', '[': ']', '{': '}' };

/** Index of the next code token at or after `i`, or -1. */
function nextCode(toks, i) {
	for (; i < toks.length; i++) if (isCode(toks[i])) return i;
	return -1;
}

/** Index of the bracket that closes the one at `open`, skipping nested brackets. */
function findClose(toks, open) {
	const stack = [OPEN[toks[open].text]];
	for (let i = open + 1; i < toks.length; i++) {
		const t = toks[i];
		if (!isCode(t) || t.type !== 'punct') continue;
		if (OPEN[t.text]) stack.push(OPEN[t.text]);
		else if (t.text === stack[stack.length - 1]) {
			stack.pop();
			if (!stack.length) return i;
		}
	}
	return toks.length - 1;
}

/**
 * STEAM_PRIVATE_API( ... ) wraps ordinary declarations, so drop the wrapper and mark the
 * wrapped code tokens instead.
 */
function unwrapPrivateApi(toks) {
	const out = [];
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (t.type === 'id' && t.text === 'STEAM_PRIVATE_API') {
			const open = nextCode(toks, i + 1);
			if (open >= 0 && toks[open].text === '(') {
				const close = findClose(toks, open);
				for (let k = i + 1; k < open; k++) out.push(toks[k]);
				for (let k = open + 1; k < close; k++) out.push(isCode(toks[k]) ? { ...toks[k], privateApi: true } : toks[k]);
				i = close;
				continue;
			}
		}
		out.push(t);
	}
	return out;
}

/** Splits a token list on top-level commas. */
function splitTopLevel(toks, sep = ',') {
	const parts = [[]];
	let depth = 0;
	for (const t of toks) {
		if (t.type === 'punct' && OPEN[t.text]) depth++;
		else if (t.type === 'punct' && (t.text === ')' || t.text === ']' || t.text === '}')) depth--;
		if (depth === 0 && t.type === 'punct' && t.text === sep) parts.push([]);
		else parts[parts.length - 1].push(t);
	}
	return parts.filter((p) => p.length);
}

/** Index of the first top-level token with the given text, or -1. */
function indexOfTopLevel(toks, text, from = 0) {
	let depth = 0;
	for (let i = from; i < toks.length; i++) {
		const t = toks[i];
		if (depth === 0 && t.text === text && t.type !== 'str') return i;
		if (t.type === 'punct' && OPEN[t.text]) depth++;
		else if (t.type === 'punct' && (t.text === ')' || t.text === ']' || t.text === '}')) depth--;
	}
	return -1;
}

// ---------------------------------------------------------------------------------------------
// Comment cleaning
// ---------------------------------------------------------------------------------------------

/** Separator lines such as `//------` or `///////`. A bare `///` or ` *` is an empty line, not decoration. */
const isDecorative = (body) => /^[\s\-=/*]*$/.test(body) && body.replace(/\s/g, '').length >= 3;

/** A commented-out enumerator such as `//k_EUniverseRC = 5, // no such universe anymore`. */
const COMMENTED_OUT_ENUMERATOR = /^\s*k_\w+\s*=\s*[^=,\s][^,]*,/;

/**
 * Replaces tabs with spaces, keeping the alignment seen in an editor. `startCol` is the
 * visual column in the source file where `s` begins.
 */
function expandTabs(s, startCol) {
	let out = '';
	let col = startCol;
	for (const ch of s) {
		if (ch === '\t') {
			const width = TAB_WIDTH - (col % TAB_WIDTH);
			out += ' '.repeat(width);
			col += width;
		} else {
			out += ch;
			col++;
		}
	}
	return out;
}

/** Text lines of one comment token with markers stripped and tabs expanded. Dropped lines become null. */
function commentTokenLines(tok) {
	if (tok.style === 'line') {
		const body = tok.text.slice(2);
		if (isDecorative(body)) return [null];
		// `///` and `///<` (doxygen) are just longer markers
		return [expandTabs(body, tok.col + 2).replace(/^\/+/, '').replace(/^[<!]/, '')];
	}
	const body = tok.text.replace(/^\/\*/, '').replace(/\*\/$/, '');
	return body.split(/\r?\n/).map((l, k) => {
		if (isDecorative(l)) return null;
		l = expandTabs(l, k === 0 ? tok.col + 2 : 0);
		if (k === 0) l = l.replace(/^\*+[<!]?/, (m) => ' '.repeat(m.length)); // `/**`, `/**<`
		return l.replace(/^(\s*)\*(?!\/)/, '$1 '); // leading ` * ` of block comment lines
	});
}

/** Turns a list of comment tokens into clean doc text ('' when there is nothing). */
function cleanComments(commentToks) {
	let lines = [];
	for (const t of commentToks) lines.push(...commentTokenLines(t));
	lines = lines.filter((l) => l !== null && !COMMENTED_OUT_ENUMERATOR.test(l)).map((l) => l.trimEnd());

	// "Purpose:" prefix; the continuation lines of such blocks are tab-aligned, so drop all indentation.
	let purpose = false;
	const first = lines.findIndex((l) => l.trim() !== '');
	if (first >= 0 && /^\s*Purpose:/.test(lines[first])) {
		purpose = true;
		lines[first] = lines[first].replace(/^\s*Purpose:\s*/, '');
	}

	if (purpose) {
		lines = lines.map((l) => l.trimStart());
	} else {
		const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length);
		const min = indents.length ? Math.min(...indents) : 0;
		lines = lines.map((l) => l.slice(Math.min(min, /^ */.exec(l)[0].length)));
	}

	// Collapse blank-line runs and trim blank lines at both ends.
	const out = [];
	for (const l of lines) {
		if (l === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
		out.push(l);
	}
	while (out.length && out[out.length - 1] === '') out.pop();
	return out.join('\n').trim();
}

// ---------------------------------------------------------------------------------------------
// Header parser
// ---------------------------------------------------------------------------------------------

/**
 * Parses one header into a flat list of declarations:
 *   { kind: 'type'|'method'|'field'|'enum'|'enumValue'|'const', name, owner, keyword,
 *     params, flatAnnot, access, outOfLine, leading: comment[], trailing: comment[],
 *     leadingText, trailingText, leadingIsSection, file, line, endLine, startCol, groupPrev }
 * `owner` is the nearest named class/struct for members (null at file scope).
 * `groupPrev` is the previous declaration in the same scope when no blank line, access label
 * or #define separates the two (the "run" used for section and group detection).
 *
 * It is a scope-aware statement scanner, not a C++ parser: it tracks class/struct/union/enum
 * bodies and skips function bodies and brace initializers. Every #if branch is read.
 */
function parseHeader(src, file) {
	const toks = unwrapPrivateApi(tokenize(src));
	const decls = [];
	const warnings = [];

	const newScope = (kind, name, extra = {}) => ({
		kind, // 'file' | 'struct' | 'union' | 'enum'
		name,
		access: 'public',
		owner: null,
		suspended: null,
		chainPrev: null,
		...extra,
	});
	const scopes = [newScope('file', null)];
	const top = () => scopes[scopes.length - 1];

	const newStmt = () => ({
		toks: [],
		leading: null, // set when the statement starts
		firstLine: 0, // first token, including annotation macros
		declLine: 0, // first token of the declaration itself
		startCol: 0,
		flatAnnot: null,
		trailingCands: [],
		privateApi: false,
		afterBody: false,
		depth: 0,
	});

	let stmt = newStmt();
	let pending = [];
	let lastDecl = null;
	let nlRun = 0;
	let detached = []; // the last comment run cut off by a blank line (see typeDoc fallback)
	let ppAfterPending = false; // a transparent #if/#pragma line came after the pending comments

	const beginStmt = (t) => {
		if (stmt.leading !== null) return;
		stmt.leading = pending;
		pending = [];
		stmt.firstLine = t.line;
		stmt.startCol = t.col;
		lastDecl = null;
	};

	const pushDecl = (d, st, endLine) => {
		const scope = top();
		const decl = {
			file,
			line: st.declLine || st.firstLine,
			endLine,
			startCol: st.startCol,
			leading: st.leading ?? [],
			trailing: [],
			trailingEnd: 0,
			groupPrev: scope.chainPrev,
			owner: scope.kind === 'file' ? null : scope.owner,
			...d,
		};
		// Trailing comments collected while the statement was still open (e.g. the last enumerator).
		const lastLine = st.toks.length ? st.toks[st.toks.length - 1].line : endLine;
		const startIdx = st.trailingCands.findIndex((c) => c.line === lastLine);
		if (startIdx >= 0) {
			let prevEnd = st.trailingCands[startIdx].endLine - 1;
			for (const c of st.trailingCands.slice(startIdx)) {
				if (c.line !== prevEnd + 1) break;
				decl.trailing.push(c);
				prevEnd = c.endLine;
			}
			decl.trailingEnd = prevEnd;
		}
		scope.chainPrev = decl;
		decls.push(decl);
		lastDecl = decl;
		return decl;
	};

	const resetChain = () => {
		top().chainPrev = null;
	};

	// ---- statement classification -------------------------------------------------------

	const paramNames = (paramToks) =>
		splitTopLevel(paramToks).map((p) => {
			const eq = indexOfTopLevel(p, '=');
			if (eq >= 0) p = p.slice(0, eq);
			// function pointer parameter: ret (*name)(args)
			const fp = p.findIndex((t, k) => t.text === '(' && p[k + 1]?.text === '*');
			if (fp >= 0) return p[fp + 2]?.type === 'id' ? p[fp + 2].text : '';
			while (p.length && p[p.length - 1].text === ']') {
				const open = p.map((t) => t.text).lastIndexOf('[');
				p = p.slice(0, open < 0 ? p.length - 1 : open);
			}
			const last = p[p.length - 1];
			return p.length >= 2 && last?.type === 'id' ? last.text : '';
		}).filter((name, k, all) => !(all.length === 1 && name === '')); // `( void )` / `()`

	/** Field name of one declarator (`int a[3]`, `void (*fn)(...)`, `uint32 b : 1`). */
	const declaratorName = (p) => {
		const fp = p.findIndex((t, k) => t.text === '(' && p[k + 1]?.text === '*');
		if (fp >= 0) return p[fp + 2]?.type === 'id' ? p[fp + 2].text : null;
		let end = p.length;
		for (let k = 0; k < p.length; k++) {
			if (p[k].text === '[' || p[k].text === '=' || p[k].text === ':') {
				end = k;
				break;
			}
		}
		for (let k = end - 1; k >= 0; k--) if (p[k].type === 'id') return p[k].text;
		return null;
	};

	/** Classifies a finished statement as a method, const or field declaration (or ignores it). */
	const finalizeStatement = (endTok) => {
		const st = stmt;
		stmt = newStmt();
		if (!st.toks.length || st.afterBody) return;
		const scope = top();
		const t = st.toks;
		const texts = t.map((x) => x.text);
		if (['typedef', 'using', 'friend', 'static_assert', 'template'].includes(texts[0])) return;

		const inType = scope.kind === 'struct' || scope.kind === 'union';
		const parenIdx = indexOfTopLevel(t, '(');
		const eqIdx = indexOfTopLevel(t, '=');
		const opIdx = texts.indexOf('operator');
		const isFnPtr = parenIdx >= 0 && texts[parenIdx + 1] === '*' && opIdx < 0; // void (*m_pfn)( ... );

		if (parenIdx >= 0 && !isFnPtr && (opIdx >= 0 || eqIdx < 0 || parenIdx < eqIdx)) {
			// `operator==( ... )`: the name is `operator` plus the symbol and the parameters follow it
			const isOperator = opIdx >= 0 && opIdx < parenIdx;
			const paramOpen = isOperator ? texts.indexOf('(', opIdx + 2) : parenIdx;
			const nameIdx = isOperator ? opIdx : parenIdx - 1;
			let name = isOperator ? 'operator' + texts.slice(opIdx + 1, paramOpen).join('') : texts[nameIdx];
			if (t[nameIdx]?.type !== 'id' || texts[nameIdx - 1] === '~') return; // destructor, cast, ...

			// `inline void servernetadr_t::Init( ... ) { ... }` defined outside the class body
			const outOfLine = texts[nameIdx - 1] === '::' && t[nameIdx - 2]?.type === 'id';
			if (!inType && !outOfLine) return; // plain function at file scope
			const owner = outOfLine ? texts[nameIdx - 2] : scope.owner;
			if (name === owner) name = 'Construct'; // steam_api.json's name for constructors

			pushDecl(
				{
					kind: 'method',
					name,
					owner,
					params: paramNames(t.slice(paramOpen + 1, findClose(t, paramOpen))),
					flatAnnot: st.flatAnnot,
					access: st.privateApi ? 'private-api' : outOfLine ? 'public' : scope.access,
					outOfLine,
				},
				st,
				endTok.line,
			);
			return;
		}

		const isConst = eqIdx >= 0 && (texts.includes('const') || texts.includes('constexpr') || texts.includes('static'));
		if (isConst && t[eqIdx - 1]?.type === 'id') {
			pushDecl({ kind: 'const', name: texts[eqIdx - 1] }, st, endTok.line);
			return;
		}
		if (inType) {
			for (const part of splitTopLevel(t)) {
				const name = declaratorName(part);
				if (name) pushDecl({ kind: 'field', name, access: scope.access }, st, endTok.line);
			}
		}
	};

	const finalizeEnumerator = (endLine) => {
		const st = stmt;
		stmt = newStmt();
		const nameTok = st.toks.find((x) => x.type === 'id');
		if (!nameTok) return;
		const scope = top();
		pushDecl(
			scope.name
				? { kind: 'enumValue', name: nameTok.text, enumName: scope.name }
				: { kind: 'const', name: nameTok.text },
			st,
			endLine,
		);
	};

	/** What does a `{` at the end of the current statement open? */
	const classifyOpener = (t) => {
		const texts = t.map((x) => x.text);
		if (texts[0] === 'namespace') return { kind: 'transparent' };
		if (texts[0] === 'extern' && t[1]?.type === 'str') return { kind: 'transparent' };
		let start = 0;
		if (texts[0] === 'template') {
			let depth = 0;
			for (let k = 1; k < texts.length; k++) {
				if (texts[k] === '<') depth++;
				else if (texts[k] === '>' && --depth === 0) {
					start = k + 1;
					break;
				}
			}
		}
		if (indexOfTopLevel(t, '(') >= 0) return { kind: 'body' };
		for (let k = start; k < texts.length; k++) {
			const kw = texts[k];
			if (kw === 'enum') {
				let n = k + 1;
				if (texts[n] === 'class' || texts[n] === 'struct') n++;
				return { kind: 'enum', name: t[n]?.type === 'id' ? texts[n] : null };
			}
			if (kw === 'class' || kw === 'struct' || kw === 'union') {
				const name = t[k + 1]?.type === 'id' ? texts[k + 1] : null;
				return { kind: 'type', keyword: kw, name, typedef: texts[0] === 'typedef' };
			}
		}
		return { kind: 'body' };
	};

	const openScope = (i) => {
		const t = toks[i];
		const scope = top();
		const opener = classifyOpener(stmt.toks);
		const prev = stmt.toks[stmt.toks.length - 1];

		if (opener.kind === 'type' || opener.kind === 'enum') {
			beginStmt(t);
			const named = opener.name && !opener.typedef;
			if (named) {
				const typeDecl = pushDecl({ kind: opener.kind === 'enum' ? 'enum' : 'type', name: opener.name, keyword: opener.keyword }, stmt, t.line);
				// A block that names the type, separated from it by one blank line, still documents it
				// (e.g. `/// ISteamNetworkingFakeUDPPort` in steamnetworkingfakeip.h).
				const end = detached[detached.length - 1]?.endLine;
				if (!typeDecl.leading.length && end === typeDecl.line - 2 && cleanComments(detached).split('\n')[0].includes(opener.name)) {
					typeDecl.leading = detached;
				}
			}
			const kind = opener.kind === 'enum' ? 'enum' : opener.keyword === 'union' ? 'union' : 'struct';
			const s = newScope(kind, named ? opener.name : null, {
				access: opener.keyword === 'class' ? 'private' : 'public',
				suspended: stmt,
			});
			s.owner = kind === 'struct' && named ? opener.name : scope.owner;
			const leading = stmt.leading;
			stmt.afterBody = true;
			scopes.push(s);
			stmt = newStmt();
			// `enum { k_cchFoo = 1 };` is how the SDK spells a constant, so the comment above an
			// anonymous enum documents its first enumerator.
			pending = kind === 'enum' && !named ? leading : [];
			lastDecl = null;
			return i;
		}
		if (opener.kind === 'transparent') {
			const s = newScope('file', null, { suspended: null, transparent: true });
			s.owner = scope.owner;
			scopes.push(s);
			stmt = newStmt();
			pending = [];
			return i;
		}
		const close = findClose(toks, i);
		if (prev && prev.text === '=') {
			// brace initializer: keep accumulating until ';'
			stmt.toks.push({ type: 'punct', text: '{}', line: toks[close].line, col: t.col });
			return close;
		}
		// function body: the statement ends at its closing brace
		if (stmt.toks.length) finalizeStatement(toks[close]);
		else stmt = newStmt();
		return close;
	};

	const closeScope = (t) => {
		const scope = top();
		if (scopes.length === 1) {
			warnings.push(`${file}:${t.line}: unbalanced '}'`);
			return;
		}
		if (scope.kind === 'enum') {
			if (stmt.toks.length) finalizeEnumerator(stmt.toks[stmt.toks.length - 1].line);
		} else if (stmt.toks.length) {
			warnings.push(`${file}:${t.line}: statement without ';' before '}' (${stmt.toks.map((x) => x.text).join(' ').slice(0, 60)})`);
		}
		scopes.pop();
		stmt = scope.suspended ?? newStmt();
		pending = [];
		lastDecl = null;
		resetChain();
	};

	// ---- STEAM_* macro calls -------------------------------------------------------------

	const handleSteamMacro = (i) => {
		const t = toks[i];
		const open = nextCode(toks, i + 1);
		const close = findClose(toks, open);
		const inner = toks.slice(open + 1, close).filter(isCode);
		const args = splitTopLevel(inner);
		const name = t.text;

		if (CALLBACK_MACROS.has(name)) {
			if (name === 'STEAM_CALLBACK_BEGIN') {
				beginStmt(t);
				const structName = args[0]?.[0]?.text;
				pushDecl({ kind: 'type', name: structName, keyword: 'struct', callbackMacro: true }, stmt, toks[close].line);
				const s = newScope('struct', structName, { callbackMacro: true });
				s.owner = structName;
				scopes.push(s);
				stmt = newStmt();
				pending = [];
				lastDecl = null;
			} else if (name === 'STEAM_CALLBACK_END') {
				if (top().callbackMacro) scopes.pop();
				else warnings.push(`${file}:${t.line}: STEAM_CALLBACK_END without BEGIN`);
				stmt = newStmt();
				pending = [];
				lastDecl = null;
				resetChain();
			} else {
				// STEAM_CALLBACK_MEMBER( index, type, name ) / _ARRAY( index, type, name, count )
				beginStmt(t);
				const nameTok = args[2]?.filter((x) => x.type === 'id').pop();
				const st = stmt;
				stmt = newStmt();
				if (nameTok) pushDecl({ kind: 'field', name: nameTok.text, access: 'public' }, st, toks[close].line);
			}
			return close;
		}

		if (name.startsWith('STEAM_DEFINE_')) {
			// interface accessor definitions: an ordinary statement as far as we care
			beginStmt(t);
			stmt.toks.push({ type: 'macro', text: name, line: t.line, col: t.col });
			return close;
		}

		// Annotation (STEAM_FLAT_NAME, STEAM_CALL_RESULT, STEAM_ARRAY_COUNT, STEAM_DESC, ...).
		beginStmt(t);
		if (name === 'STEAM_FLAT_NAME') stmt.flatAnnot = inner.map((x) => x.text).join('');
		return close;
	};

	// ---- comments / preprocessor / blank lines -------------------------------------------

	const onComment = (c) => {
		if (c.trailing) {
			if (stmt.toks.length) stmt.trailingCands.push(c);
			else if (lastDecl && lastDecl.endLine === c.line) {
				lastDecl.trailing.push(c);
				lastDecl.trailingEnd = c.endLine;
			}
			return;
		}
		// Continuation of a multi-line trailing comment: next line, indented to the comment column.
		const cands = stmt.trailingCands;
		if (stmt.toks.length && cands.length && c.line === cands[cands.length - 1].endLine + 1 && c.col >= cands[0].col - TAB_WIDTH) {
			cands.push(c);
			return;
		}
		if (
			!stmt.toks.length &&
			stmt.leading === null &&
			lastDecl &&
			lastDecl.trailing.length &&
			c.line === lastDecl.trailingEnd + 1 &&
			c.col > lastDecl.startCol &&
			c.col >= lastDecl.trailing[0].col - TAB_WIDTH
		) {
			lastDecl.trailing.push(c);
			lastDecl.trailingEnd = c.endLine;
			return;
		}
		if (stmt.leading !== null && !stmt.toks.length) {
			stmt.leading.push(c); // between annotation macros and the declaration
			return;
		}
		if (stmt.toks.length) return; // comment inside a declaration (e.g. between parameters)
		// `// callbacks` + #if/#pragma block + `// Purpose: ...`: only the block nearest the
		// declaration counts.
		if (ppAfterPending) pending = [];
		ppAfterPending = false;
		pending.push(c);
	};

	const onPreprocessor = (p) => {
		const directive = /^#\s*(\w+)/.exec(p.text)?.[1] ?? '';
		if (TRANSPARENT_DIRECTIVES.has(directive)) {
			if (pending.length) ppAfterPending = true;
			return;
		}
		pending = [];
		lastDecl = null;
		if (stmt.leading !== null && !stmt.toks.length) stmt.leading = [];
		resetChain();
	};

	const onBlankLine = () => {
		if (pending.length) detached = pending;
		pending = [];
		if (stmt.leading !== null && !stmt.toks.length) stmt.leading = [];
		resetChain();
	};

	// ---- main loop -----------------------------------------------------------------------

	for (let i = 0; i < toks.length; i++) {
		const t = toks[i];
		if (t.type === 'nl') {
			if (++nlRun >= 2) onBlankLine();
			continue;
		}
		nlRun = 0;
		if (t.type === 'comment') {
			onComment(t);
			continue;
		}
		if (t.type === 'pp') {
			onPreprocessor(t);
			continue;
		}

		if (t.type === 'id' && t.text.startsWith('STEAM_')) {
			const open = nextCode(toks, i + 1);
			if (open >= 0 && toks[open].text === '(') {
				i = handleSteamMacro(i);
				continue;
			}
		}

		const scope = top();
		if (t.privateApi) stmt.privateApi = true;

		if (scope.kind === 'enum') {
			if (t.text === '}' && stmt.depth === 0) {
				closeScope(t);
				continue;
			}
			if (t.text === ',' && stmt.depth === 0) {
				finalizeEnumerator(t.line);
				continue;
			}
			if (OPEN[t.text]) stmt.depth++;
			else if (t.text === ')' || t.text === ']') stmt.depth--;
			beginStmt(t);
			if (!stmt.toks.length) stmt.declLine = t.line;
			stmt.toks.push(t);
			continue;
		}

		if (t.type === 'punct' && stmt.depth === 0) {
			if (t.text === '{') {
				i = openScope(i);
				continue;
			}
			if (t.text === '}') {
				closeScope(t);
				continue;
			}
			if (t.text === ';') {
				finalizeStatement(t);
				continue;
			}
			if (
				t.text === ':' &&
				(scope.kind === 'struct' || scope.kind === 'union') &&
				stmt.toks.length === 1 &&
				['public', 'private', 'protected'].includes(stmt.toks[0].text)
			) {
				scope.access = stmt.toks[0].text;
				stmt = newStmt();
				pending = [];
				lastDecl = null;
				resetChain();
				continue;
			}
		}
		if (t.text === '(' || t.text === '[') stmt.depth++;
		else if (t.text === ')' || t.text === ']') stmt.depth--;
		beginStmt(t);
		if (!stmt.toks.length) stmt.declLine = t.line;
		stmt.toks.push(t);
	}

	if (scopes.length !== 1) warnings.push(`${file}: ${scopes.length - 1} scope(s) left open at EOF (${scopes.map((s) => s.name ?? s.kind).join(' > ')})`);

	for (const d of decls) {
		d.leadingText = cleanComments(d.leading);
		d.trailingText = cleanComments(d.trailing);
	}
	// Section headers: a leading block on an item with a trailing comment, followed directly by
	// another item that has a trailing comment but no leading comment of its own.
	const nextInRun = new Map(decls.filter((d) => d.groupPrev).map((d) => [d.groupPrev, d]));
	for (const d of decls) {
		if (!d.leadingText || !d.trailingText) continue;
		const next = nextInRun.get(d);
		if (next && next.trailingText && !next.leadingText) d.leadingIsSection = true;
	}

	return { decls, warnings };
}

// ---------------------------------------------------------------------------------------------
// Matching against steam_api.json
// ---------------------------------------------------------------------------------------------

function buildApiIndex(api) {
	const classes = new Map(); // name -> { kind, methods, fields:Set }
	const enums = new Set();
	const enumValues = new Set();
	const consts = new Set();
	const addEnums = (list) => {
		for (const e of list ?? []) {
			enums.add(e.enumname);
			for (const v of e.values) enumValues.add(v.name);
		}
	};
	for (const itf of api.interfaces) {
		classes.set(itf.classname, { kind: 'interface', methods: itf.methods ?? [], fields: new Set((itf.fields ?? []).map((f) => f.fieldname)) });
		addEnums(itf.enums);
	}
	for (const s of [...api.structs, ...api.callback_structs]) {
		classes.set(s.struct, { kind: 'struct', methods: s.methods ?? [], fields: new Set(s.fields.map((f) => f.fieldname)) });
		addEnums(s.enums);
		for (const c of s.consts ?? []) consts.add(`${s.struct}::${c.constname}`);
	}
	addEnums(api.enums);
	for (const c of api.consts) consts.add(c.constname);
	return { classes, enums, enumValues, consts };
}

const sameParams = (jsonMethod, params) => jsonMethod.params.map((p) => p.paramname).join(',') === params.join(',');

/**
 * Resolves a header method declaration to a JSON method (or null).
 * `overloaded` is true when the class body declares this name more than once. In that case an
 * un-annotated declaration must also match the JSON parameter names, because only one overload
 * can own the plain SteamAPI_<Class>_<Name> flat name.
 */
function matchMethod(d, info, overloaded) {
	const methods = info.methods;
	const sameName = methods.filter((m) => m.methodname === d.name);
	const byParams = () => {
		const alt = sameName.filter((x) => sameParams(x, d.params));
		return alt.length === 1 ? alt[0] : null;
	};
	const m = methods.find((x) => x.methodname_flat === `SteamAPI_${d.owner}_${d.flatAnnot ?? d.name}`) ?? null;
	if (m) return d.flatAnnot || !overloaded || sameParams(m, d.params) ? m : byParams();
	if (sameName.length === 1 && !overloaded) return sameName[0];
	return byParams();
}

function declDocText(d) {
	return [d.leadingIsSection ? '' : d.leadingText, d.trailingText].filter(Boolean).join('\n\n');
}

/** Headers are mostly ASCII; a few are UTF-8 (with BOM) and a few Latin-1 (copyright signs). */
function readHeader(file) {
	const buf = fs.readFileSync(file);
	let text;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
	} catch {
		text = buf.toString('latin1');
	}
	return text.replace(/^\uFEFF/, '');
}

/**
 * Extracts documentation for everything in `api` from the headers in `sdkDir`.
 * @param {string} sdkDir
 * @param {object} api parsed steam_api.json
 * @returns {DocsIndex}
 */
export function extractDocs(sdkDir, api) {
	const idx = buildApiIndex(api);
	const files = fs
		.readdirSync(sdkDir)
		.filter((f) => f.endsWith('.h') && !EXCLUDED_HEADERS.has(f))
		.sort();

	const diagnostics = {
		unmatchedHeaderMethods: [],
		ignoredNonPublic: [],
		unmatchedOutOfLine: [],
		jsonMethodsWithoutHeaderDecl: [],
		classesNotInApi: [],
		paramMismatches: [],
		sectionComments: [],
		groupMembers: {},
		duplicates: [],
		warnings: [],
		locations: {},
	};

	// candidates[category][key] = [{ text, prio, where }]
	const categories = ['methods', 'interfaces', 'structs', 'fields', 'enums', 'enumValues', 'consts'];
	const candidates = Object.fromEntries(categories.map((c) => [c, new Map()]));
	for (const c of categories) diagnostics.locations[c] = {};
	const offer = (cat, key, text, prio, where) => {
		if (!candidates[cat].has(key)) candidates[cat].set(key, []);
		candidates[cat].get(key).push({ text, prio, where });
	};
	const seenMethods = new Set();
	const classesNotInApi = new Set();
	const allDecls = [];

	const parsed = [];
	for (const file of files) {
		const { decls, warnings } = parseHeader(readHeader(path.join(sdkDir, file)), file);
		diagnostics.warnings.push(...warnings);
		parsed.push(...decls);
	}

	// Header overloads: names declared more than once in the same class body.
	const overloadCount = new Map();
	for (const d of parsed) {
		if (d.kind !== 'method' || d.outOfLine) continue;
		const k = `${d.owner}::${d.name}`;
		overloadCount.set(k, (overloadCount.get(k) ?? 0) + 1);
	}

	for (const d of parsed) {
		const where = `${d.file}:${d.line}`;
		let cat = null;
		let key = null;
		let prio = 2;

		if (d.kind === 'method') {
			const info = idx.classes.get(d.owner);
			if (!info) {
				if (!d.outOfLine) classesNotInApi.add(d.owner);
				continue;
			}
			const m = matchMethod(d, info, (overloadCount.get(`${d.owner}::${d.name}`) ?? 0) > 1);
			if (!m) {
				const entry = `${d.owner}::${d.name}(${d.params.join(', ')}) @ ${where}`;
				if (d.outOfLine) diagnostics.unmatchedOutOfLine.push(entry);
				else if (d.access !== 'public') diagnostics.ignoredNonPublic.push(`${entry} [${d.access}]`);
				else diagnostics.unmatchedHeaderMethods.push(entry);
				continue;
			}
			if (!sameParams(m, d.params)) {
				diagnostics.paramMismatches.push(
					`${m.methodname_flat}: header (${d.params.join(', ')}) vs json (${m.params.map((p) => p.paramname).join(', ')}) @ ${where}`,
				);
			}
			seenMethods.add(m.methodname_flat);
			cat = 'methods';
			key = m.methodname_flat;
			prio = d.outOfLine ? 1 : 2;
		} else if (d.kind === 'type') {
			const info = idx.classes.get(d.name);
			if (!info) continue;
			cat = info.kind === 'interface' ? 'interfaces' : 'structs';
			key = d.name;
		} else if (d.kind === 'field') {
			const info = idx.classes.get(d.owner);
			if (!info || !info.fields.has(d.name)) continue;
			cat = 'fields';
			key = `${d.owner}.${d.name}`;
		} else if (d.kind === 'enum') {
			if (!idx.enums.has(d.name)) continue;
			cat = 'enums';
			key = d.name;
		} else if (d.kind === 'enumValue') {
			if (!idx.enumValues.has(d.name)) continue;
			cat = 'enumValues';
			key = d.name;
		} else if (d.kind === 'const') {
			key = d.owner ? `${d.owner}::${d.name}` : d.name;
			if (!idx.consts.has(key)) continue;
			cat = 'consts';
		}
		if (!cat) continue;

		d.cat = cat;
		d.key = key;
		allDecls.push(d);
		diagnostics.locations[cat][key] ??= where;
		offer(cat, key, declDocText(d), prio, where);
	}

	// Resolve candidates: highest priority first, then file order; first non-empty text wins.
	const docs = Object.fromEntries(categories.map((c) => [c, {}]));
	for (const cat of categories) {
		for (const [key, list] of candidates[cat]) {
			const withText = list.filter((c) => c.text);
			if (!withText.length) continue;
			const best = Math.max(...withText.map((c) => c.prio));
			const top = withText.filter((c) => c.prio === best);
			docs[cat][key] = top[0].text;
			const distinct = new Set(top.map((c) => c.text));
			if (distinct.size > 1) diagnostics.duplicates.push(`${cat}:${key} documented differently at ${top.map((c) => c.where).join(', ')}`);
		}
	}

	// Section headers and group members (informational, for the generator to use if it wants).
	const nextInRun = new Map(allDecls.filter((d) => d.groupPrev).map((d) => [d.groupPrev, d]));
	for (const d of allDecls) {
		if (d.leadingIsSection) {
			const keys = [d.key];
			for (let n = nextInRun.get(d); n; n = nextInRun.get(n)) keys.push(n.key);
			diagnostics.sectionComments.push({ text: d.leadingText, keys, where: `${d.file}:${d.line}` });
		}
		if (d.cat === 'enumValues' || docs[d.cat][d.key] || !d.groupPrev) continue;
		for (let p = d.groupPrev; p && p.cat === d.cat; p = p.groupPrev) {
			if (p.trailingText && !p.leadingText) break; // items documented one by one; no group
			if (p.leadingText && !p.leadingIsSection) {
				if (docs[p.cat][p.key]) diagnostics.groupMembers[d.key] = p.key;
				break;
			}
		}
	}

	for (const itf of [...api.interfaces, ...api.structs, ...api.callback_structs]) {
		for (const m of itf.methods ?? []) if (!seenMethods.has(m.methodname_flat)) diagnostics.jsonMethodsWithoutHeaderDecl.push(m.methodname_flat);
	}
	diagnostics.classesNotInApi = [...classesNotInApi].sort();

	Object.defineProperty(docs, 'diagnostics', { value: diagnostics, enumerable: false });
	return docs;
}

/**
 * Coverage of a DocsIndex against steam_api.json.
 * @returns {{ methods, interfaces, structs, fields, enums, enumValues, consts: {documented:number,total:number},
 *             unmatchedHeaderMethods: string[] }}
 */
export function docsCoverage(docs, api) {
	const count = (keys, map) => {
		const unique = [...new Set(keys)];
		return { documented: unique.filter((k) => map[k]).length, total: unique.length };
	};
	const allStructs = [...api.structs, ...api.callback_structs];
	const allEnums = [
		...api.enums,
		...api.interfaces.flatMap((i) => i.enums ?? []),
		...allStructs.flatMap((s) => s.enums ?? []),
	];
	return {
		methods: count(
			[...api.interfaces, ...allStructs].flatMap((c) => (c.methods ?? []).map((m) => m.methodname_flat)),
			docs.methods,
		),
		interfaces: count(api.interfaces.map((i) => i.classname), docs.interfaces),
		structs: count(allStructs.map((s) => s.struct), docs.structs),
		fields: count(allStructs.flatMap((s) => s.fields.map((f) => `${s.struct}.${f.fieldname}`)), docs.fields),
		enums: count(allEnums.map((e) => e.enumname), docs.enums),
		enumValues: count(allEnums.flatMap((e) => e.values.map((v) => v.name)), docs.enumValues),
		consts: count(
			[...api.consts.map((c) => c.constname), ...allStructs.flatMap((s) => (s.consts ?? []).map((c) => `${s.struct}::${c.constname}`))],
			docs.consts,
		),
		unmatchedHeaderMethods: docs.diagnostics?.unmatchedHeaderMethods ?? [],
	};
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function main(argv) {
	const args = argv.filter((a) => !a.startsWith('--'));
	const flags = new Set(argv.filter((a) => a.startsWith('--')));
	const sdkDir = args[0];
	if (!sdkDir) {
		console.error('usage: node scripts/sdk/extract-docs.mjs <sdkDir> [--dump] [--diagnostics]');
		process.exit(2);
	}
	const api = JSON.parse(fs.readFileSync(path.join(sdkDir, 'steam_api.json'), 'utf8'));
	const docs = extractDocs(sdkDir, api);
	if (flags.has('--dump')) {
		process.stdout.write(JSON.stringify(docs, null, 2) + '\n');
		return;
	}
	if (flags.has('--diagnostics')) {
		process.stdout.write(JSON.stringify(docs.diagnostics, null, 2) + '\n');
		return;
	}
	const cov = docsCoverage(docs, api);
	const unmatched = cov.unmatchedHeaderMethods;
	const summary = { ...cov, unmatchedHeaderMethods: unmatched.length };
	console.log(JSON.stringify(summary, null, 2));
	if (unmatched.length) {
		console.log(`\nFirst ${Math.min(20, unmatched.length)} of ${unmatched.length} unmatched header methods:`);
		for (const u of unmatched.slice(0, 20)) console.log(`  ${u}`);
	}
	if (docs.diagnostics.warnings.length) {
		console.log('\nParser warnings:');
		for (const w of docs.diagnostics.warnings) console.log(`  ${w}`);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main(process.argv.slice(2));
}
