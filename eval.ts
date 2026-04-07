#!/usr/bin/env bun
/**
 * eval.ts — quality evaluation for a review-ctx bundle.
 *
 * Usage:
 *   bun run eval.ts <bundle.json> [repo-root]
 *
 * Performs the following checks on a bundle produced by index.ts:
 *   1. Existence — every resolvedPath / hop node / neighbor exists on disk
 *   2. Resolution — audit external imports for missed internal resolution
 *   3. AST symbol recall — cross-check exports against a naive regex pass
 *   4. Multi-hop integrity — hop-2 nodes reachable via hop-1 `via` edges
 *   5. Semantic neighbor coherence — feature-area clustering
 *   6. Memory/rules drift — bundle vs on-disk
 *   7. Context gaps — changed files with zero derived context
 *
 * Output: a markdown-style report on stdout with counts, pass/fail, and
 *         specific offending entries.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';

interface ForwardEdge {
  specifier: string;
  kind: 'internal' | 'external';
  type: string;
  resolvedPath?: string;
  namedSymbols: string[];
}
interface ReverseEdge {
  path: string;
  importedSymbols: string[];
  type: string;
}
interface HopNode {
  path: string;
  via: string;
  viaSymbols: string[];
  type: string;
}
interface FileEntry {
  path: string;
  prevPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
  fullContent: string;
  truncated: boolean;
  symbols: { exports: string[]; functions: string[]; classes: string[] };
  directImports: ForwardEdge[];
  directCallers: ReverseEdge[];
  multiHop: { forwardTiers: HopNode[][]; reverseTiers: HopNode[][] };
  semanticNeighbors: { path: string; score: number }[];
  siblings: string[];
  otherChangedFiles: string[];
}
interface Bundle {
  meta: Record<string, unknown>;
  rules: Record<string, string>;
  memory: { path: string; content: string } | null;
  changedFiles: string[];
  files: FileEntry[];
}

type Severity = 'error' | 'warning' | 'info';
interface Issue {
  severity: Severity;
  category: string;
  file?: string;
  message: string;
}

const args = process.argv.slice(2);
const bundlePath = args[0] ?? '/tmp/ctx-v3.json';
const root = args[1] ?? '/Users/barreloflube/Desktop/stack-auth.nosync /4';

const bundle: Bundle = JSON.parse(await readFile(bundlePath, 'utf8'));

const issues: Issue[] = [];
function add(severity: Severity, category: string, message: string, file?: string) {
  issues.push({ severity, category, file, message });
}

// ---------------------------------------------------------------------------
// 1. Existence
// ---------------------------------------------------------------------------
let existChecked = 0;
let existMissing = 0;
function checkExists(p: string, cat: string, file: string, label: string) {
  existChecked++;
  if (!existsSync(join(root, p))) {
    existMissing++;
    add('error', cat, `${label}: ${p}`, file);
  }
}

for (const f of bundle.files) {
  if (f.status !== 'deleted') checkExists(f.path, 'existence', f.path, 'changed file');
  for (const imp of f.directImports) {
    if (imp.kind === 'internal' && imp.resolvedPath) {
      checkExists(imp.resolvedPath, 'existence', f.path, `resolvedPath ${imp.specifier} →`);
    }
  }
  for (const c of f.directCallers) {
    checkExists(c.path, 'existence', f.path, 'caller');
  }
  for (const tier of f.multiHop.forwardTiers)
    for (const n of tier)
      checkExists(n.path, 'existence', f.path, 'multiHop.forward');
  for (const tier of f.multiHop.reverseTiers)
    for (const n of tier)
      checkExists(n.path, 'existence', f.path, 'multiHop.reverse');
  for (const n of f.semanticNeighbors)
    checkExists(n.path, 'existence', f.path, 'semanticNeighbor');
}

// ---------------------------------------------------------------------------
// 2. Resolution audit
// ---------------------------------------------------------------------------
let extTotal = 0;
let extRelativeBroken = 0;
let extAliasBroken = 0;
for (const f of bundle.files) {
  for (const imp of f.directImports) {
    if (imp.kind !== 'external') continue;
    extTotal++;
    // Relative imports that didn't resolve — almost certainly a bug unless the
    // target file was deleted or lives outside the indexed --scope.
    if (
      imp.specifier.startsWith('./') ||
      imp.specifier.startsWith('../') ||
      imp.specifier.startsWith('/')
    ) {
      extRelativeBroken++;
      add('warning', 'resolution',
        `relative import classed external: ${imp.specifier}`, f.path);
    }
    // `@/` is the stack-auth alias for apps/dashboard/src/.  If it's still
    // external, the tsconfig alias lookup missed.
    if (imp.specifier.startsWith('@/')) {
      extAliasBroken++;
      add('error', 'resolution',
        `@/ alias unresolved: ${imp.specifier}`, f.path);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. AST symbol recall vs naive regex
// ---------------------------------------------------------------------------
const REGEX_EXPORT = /(?:^|\s)export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+(\w+)/g;
const SOURCE_EXTS_SET = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// Strip string literals (", ', `) and comments so the regex baseline doesn't
// match "export const config = {}" that lives inside a JS string.
function stripStringsAndComments(src: string): string {
  let out = '';
  let i = 0;
  let inString: string | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (inString) {
      if (ch === '\\' && next !== undefined) { i += 2; continue; }
      if (ch === inString) { inString = null; }
      i++; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; i++; continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

let regexMissed = 0;
let astMissed = 0;
let symbolFilesChecked = 0;
for (const f of bundle.files) {
  if (f.status === 'deleted') continue;
  const ext = extname(f.path);
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) continue;
  let content: string;
  try { content = await readFile(join(root, f.path), 'utf8'); } catch { continue; }
  const stripped = stripStringsAndComments(content);
  const regexNames = new Set<string>();
  REGEX_EXPORT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REGEX_EXPORT.exec(stripped))) regexNames.add(m[1]!);

  // A symbol counts as "found by AST" if it appears in exports, functions,
  // or classes. Rationale: the regex baseline is naive — it treats
  // `export default function PageClient()` as exporting `PageClient`, but
  // the *actual* export name is `default` and `PageClient` is only the
  // local function name. Our AST correctly puts `default` in exports and
  // `PageClient` in functions, which together represent the same fact.
  const astNames = new Set([
    ...f.symbols.exports,
    ...f.symbols.functions,
    ...f.symbols.classes,
  ]);

  const inRegexOnly = [...regexNames].filter((n) => !astNames.has(n));
  const inAstOnly = [...f.symbols.exports].filter(
    (n) => !regexNames.has(n) && n !== 'default',
  );

  if (inRegexOnly.length > 0) {
    regexMissed += inRegexOnly.length;
    add('warning', 'ast-recall',
      `AST missed ${inRegexOnly.length} symbol(s) regex found: ${inRegexOnly.slice(0, 4).join(', ')}${inRegexOnly.length > 4 ? '…' : ''}`,
      f.path);
  }
  if (inAstOnly.length > 0) {
    astMissed += inAstOnly.length;
    // Not necessarily a problem — AST sees re-exports, export {}, etc.
  }
  symbolFilesChecked++;
}

// ---------------------------------------------------------------------------
// 4. Multi-hop integrity
// ---------------------------------------------------------------------------
let hopIntegrityOk = 0;
let hopIntegrityBad = 0;
for (const f of bundle.files) {
  // forward: hop[i+1].via must be in hop[i] set (or the start file for hop0→hop1)
  const fwd = f.multiHop.forwardTiers;
  for (let i = 1; i < fwd.length; i++) {
    const prev = new Set([f.path, ...(fwd[i - 1] ?? []).map((n) => n.path)]);
    for (const n of fwd[i] ?? []) {
      if (!prev.has(n.via)) {
        hopIntegrityBad++;
        add('error', 'multi-hop',
          `forward hop${i + 1}: ${n.path} via ${n.via} not in hop${i}`, f.path);
      } else hopIntegrityOk++;
    }
  }
  const rev = f.multiHop.reverseTiers;
  for (let i = 1; i < rev.length; i++) {
    const prev = new Set([f.path, ...(rev[i - 1] ?? []).map((n) => n.path)]);
    for (const n of rev[i] ?? []) {
      if (!prev.has(n.via)) {
        hopIntegrityBad++;
        add('error', 'multi-hop',
          `reverse hop${i + 1}: ${n.path} via ${n.via} not in hop${i}`, f.path);
      } else hopIntegrityOk++;
    }
  }
  // No self-reference
  const allHopPaths = new Set<string>();
  for (const t of fwd) for (const n of t) allHopPaths.add(n.path);
  for (const t of rev) for (const n of t) allHopPaths.add(n.path);
  if (allHopPaths.has(f.path)) {
    add('error', 'multi-hop', 'self-reference in hop set', f.path);
    hopIntegrityBad++;
  }
}

// ---------------------------------------------------------------------------
// 5. Semantic neighbor coherence
// ---------------------------------------------------------------------------
// Proxy: what fraction of top-K neighbors share the same 3-deep path prefix
// (e.g. apps/dashboard/src/app/...projects/[projectId]/...) as the target.
// Higher = more locally-relevant retrieval; lower = more cross-repo spread.
function prefix(p: string, depth: number): string {
  return p.split('/').slice(0, depth).join('/');
}
let nbrTotal = 0, nbrSameDir3 = 0, nbrSameDir4 = 0, nbrSameFeature = 0;
// Heuristic: "feature area" = the 5-component prefix path
for (const f of bundle.files) {
  const p3 = prefix(f.path, 3);
  const p4 = prefix(f.path, 4);
  const p5 = prefix(f.path, 5);
  for (const n of f.semanticNeighbors) {
    nbrTotal++;
    if (prefix(n.path, 3) === p3) nbrSameDir3++;
    if (prefix(n.path, 4) === p4) nbrSameDir4++;
    if (prefix(n.path, 5) === p5) nbrSameFeature++;
  }
}

// ---------------------------------------------------------------------------
// 6. Memory & rules drift
// ---------------------------------------------------------------------------
let memoryOk = false;
if (bundle.memory) {
  try {
    const onDisk = await readFile(bundle.memory.path, 'utf8');
    memoryOk = onDisk === bundle.memory.content;
    if (!memoryOk) add('warning', 'memory', 'bundle memory drifted from on-disk file');
  } catch {
    add('error', 'memory', `memory path unreadable: ${bundle.memory.path}`);
  }
}
let rulesChecked = 0, rulesOk = 0;
for (const [name, content] of Object.entries(bundle.rules)) {
  rulesChecked++;
  try {
    const onDisk = await readFile(join(root, name), 'utf8');
    if (onDisk === content) rulesOk++;
    else add('warning', 'rules', `rule drift: ${name}`);
  } catch {
    add('error', 'rules', `rule unreadable on disk: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// 7. Context gaps
// ---------------------------------------------------------------------------
let contextGapCount = 0;
let contextGapPartial = 0;
for (const f of bundle.files) {
  if (f.status === 'deleted') continue;
  // Non-source files (md, snap, json, css, ...) aren't supposed to have AST
  // or graph context — they ship with patch + fullContent only, which is the
  // correct representation for a review agent. Don't flag them as gaps.
  if (!SOURCE_EXTS_SET.has(extname(f.path))) continue;
  const hasDirect = f.directImports.length + f.directCallers.length > 0;
  const hasHops =
    f.multiHop.forwardTiers.some((t) => t.length > 0) ||
    f.multiHop.reverseTiers.some((t) => t.length > 0);
  const hasNbrs = f.semanticNeighbors.length > 0;
  if (!hasDirect && !hasHops && !hasNbrs) {
    contextGapCount++;
    add('warning', 'context-gap', 'no context of any kind', f.path);
  } else if (!hasHops && !hasNbrs) {
    contextGapPartial++;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function pct(n: number, d: number): string {
  if (d === 0) return 'n/a';
  return ((n / d) * 100).toFixed(1) + '%';
}
function count(cat: string, sev: Severity): number {
  return issues.filter((i) => i.category === cat && i.severity === sev).length;
}

const bySeverity = {
  error: issues.filter((i) => i.severity === 'error').length,
  warning: issues.filter((i) => i.severity === 'warning').length,
  info: issues.filter((i) => i.severity === 'info').length,
};

console.log(`# Review-Context Bundle Quality Report
Bundle: ${bundlePath}
Repo:   ${root}
Meta:   ${bundle.meta.indexedFileCount} indexed, ${bundle.meta.changedFileCount} changed, ${bundle.meta.graphEdgeCount} internal edges

---

## 1. Existence
   paths checked: ${existChecked}
   missing on disk: ${existMissing}  (${pct(existMissing, existChecked)})
   ${existMissing === 0 ? 'PASS' : 'FAIL'}

## 2. Import resolution audit
   external imports:          ${extTotal}
   relative-but-unresolved:   ${extRelativeBroken}  ← should be 0
   @/ alias unresolved:       ${extAliasBroken}     ← should be 0
   ${extRelativeBroken === 0 && extAliasBroken === 0 ? 'PASS' : 'FAIL'}

## 3. AST symbol recall (vs regex baseline)
   source files checked: ${symbolFilesChecked}
   exports the AST missed that regex caught: ${regexMissed}
   exports the AST caught that regex didn't: ${astMissed} (re-exports, export {})
   ${regexMissed === 0 ? 'PASS' : regexMissed < 10 ? 'PASS*' : 'FAIL'}

## 4. Multi-hop integrity
   valid hop edges:   ${hopIntegrityOk}
   invalid hop edges: ${hopIntegrityBad}
   ${hopIntegrityBad === 0 ? 'PASS' : 'FAIL'}

## 5. Semantic neighbor coherence
   total neighbors: ${nbrTotal}
   share 3-deep path prefix: ${nbrSameDir3}  (${pct(nbrSameDir3, nbrTotal)})
   share 4-deep path prefix: ${nbrSameDir4}  (${pct(nbrSameDir4, nbrTotal)})
   share 5-deep path prefix: ${nbrSameFeature}  (${pct(nbrSameFeature, nbrTotal)})
   INFO: higher = more locally clustered. For a dashboard-scoped run on a
   multi-app monorepo, the 3-deep prefix is 'apps/dashboard/src' and should
   dominate.

## 6. Memory & rules
   memory match: ${bundle.memory ? (memoryOk ? 'ok' : 'DRIFT') : 'no memory'}
   rules: ${rulesOk}/${rulesChecked} match disk
   ${(bundle.memory ? memoryOk : true) && rulesOk === rulesChecked ? 'PASS' : 'FAIL'}

## 7. Context gaps
   changed files with NO context at all:            ${contextGapCount}
   changed files with direct but no hops/neighbors: ${contextGapPartial}
   ${contextGapCount === 0 ? 'PASS' : 'INFO'}

---

## Issue totals
   errors:   ${bySeverity.error}
   warnings: ${bySeverity.warning}
   info:     ${bySeverity.info}

   by category:
     existence:     E=${count('existence', 'error')}  W=${count('existence', 'warning')}
     resolution:    E=${count('resolution', 'error')}  W=${count('resolution', 'warning')}
     ast-recall:    E=${count('ast-recall', 'error')}  W=${count('ast-recall', 'warning')}
     multi-hop:     E=${count('multi-hop', 'error')}  W=${count('multi-hop', 'warning')}
     memory:        E=${count('memory', 'error')}  W=${count('memory', 'warning')}
     rules:         E=${count('rules', 'error')}  W=${count('rules', 'warning')}
     context-gap:   W=${count('context-gap', 'warning')}

`);

// Top offenders
if (issues.length > 0) {
  console.log('## Sample issues (first 20)\n');
  for (const i of issues.slice(0, 20)) {
    const prefixStr = i.severity.toUpperCase().padEnd(7);
    const cat = i.category.padEnd(12);
    const file = i.file ? ` [${i.file}]` : '';
    console.log(`  ${prefixStr} ${cat} ${i.message}${file}`);
  }
  if (issues.length > 20) console.log(`  … and ${issues.length - 20} more`);
}
