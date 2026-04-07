#!/usr/bin/env bun
/**
 * review.ts — end-to-end review test using a bundle from index.ts.
 *
 * Usage:
 *   bun run review.ts <bundle.json> [file-path]
 *   bun run review.ts /tmp/ctx-v7.json                      # auto-pick meaty file
 *   bun run review.ts /tmp/ctx-v7.json apps/backend/seed.ts # review a specific file
 *
 * Builds a Greptile-style per-file review prompt with all context lanes and
 * calls a local Ollama chat model (default: gemma4:31b) to generate the
 * review. Prints the raw response and a parsed JSON view.
 */

import { readFile } from 'node:fs/promises';

interface SemanticNeighbor { path: string; score: number; alsoIn: string[] }
interface HopNode { path: string; via: string; viaSymbols: string[]; type: string }
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
  directImports: Array<{
    specifier: string; kind: 'internal' | 'external'; type: string;
    resolvedPath?: string; namedSymbols: string[]
  }>;
  directCallers: Array<{ path: string; importedSymbols: string[]; type: string }>;
  multiHop: { forwardTiers: HopNode[][]; reverseTiers: HopNode[][] };
  semanticNeighbors: SemanticNeighbor[];
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

const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL = process.env.REVIEW_MODEL || 'gemma4:31b';

const bundlePath = process.argv[2] ?? '/tmp/ctx-v7.json';
const targetArg = process.argv[3];

const bundle: Bundle = JSON.parse(await readFile(bundlePath, 'utf8'));

// Pick a file: either the one the user asked for, or a "meaty" one that
// exercises the full context (internal imports + callers + multi-hop + neighbors).
let file: FileEntry | undefined;
if (targetArg) {
  file = bundle.files.find((f) => f.path === targetArg || f.path.endsWith(targetArg));
}
if (!file) {
  file = bundle.files.find((f) =>
    f.directImports.filter((i) => i.kind === 'internal').length >= 3 &&
    f.directCallers.length >= 1 &&
    f.multiHop.forwardTiers.length >= 1 &&
    f.semanticNeighbors.length >= 3 &&
    f.patch.length > 200 &&
    f.patch.length < 8000,
  );
}
if (!file) file = bundle.files[0]!;

console.error(`[review] bundle : ${bundlePath}`);
console.error(`[review] file   : ${file.path}`);
console.error(`[review] model  : ${MODEL}`);
console.error(`[review] lanes  : imports=${file.directImports.length} callers=${file.directCallers.length} fwdHops=${file.multiHop.forwardTiers.map((t) => t.length).join(',')} revHops=${file.multiHop.reverseTiers.map((t) => t.length).join(',')} neighbors=${file.semanticNeighbors.length}`);

// ---------------------------------------------------------------------------
// Prompt construction — Greptile-style per-file review, all lanes included
// ---------------------------------------------------------------------------
function fmtImports(imports: FileEntry['directImports']): string {
  const internal = imports.filter((i) => i.kind === 'internal');
  if (internal.length === 0) return '  (none)';
  return internal
    .map((i) => {
      const syms = i.namedSymbols.length > 0 ? ` { ${i.namedSymbols.join(', ')} }` : '';
      return `  ${i.resolvedPath}${syms}`;
    })
    .join('\n');
}

function fmtCallers(callers: FileEntry['directCallers']): string {
  if (callers.length === 0) return '  (none)';
  return callers
    .map((c) => {
      const syms = c.importedSymbols.length > 0 ? ` uses { ${c.importedSymbols.join(', ')} }` : '';
      return `  ${c.path}${syms}`;
    })
    .join('\n');
}

function fmtHops(tiers: HopNode[][]): string {
  if (tiers.length < 2 || tiers[1]!.length === 0) return '  (none)';
  return tiers[1]!
    .map((n) => `  ${n.path}  ← via ${n.via}`)
    .join('\n');
}

function fmtNeighbors(neighbors: SemanticNeighbor[]): string {
  if (neighbors.length === 0) return '  (none)';
  return neighbors
    .slice(0, 6)
    .map((n) => {
      const also = Array.isArray(n.alsoIn) ? n.alsoIn : [];
      const overlap = also.length > 0 ? ` [also in ${also.join('+')}]` : '';
      return `  ${n.score.toFixed(3)}  ${n.path}${overlap}`;
    })
    .join('\n');
}

function extractMemorySections(memory: string): string {
  // Keep just the Rules + Suppressed patterns + Notes bullets for the prompt
  return memory
    .split('\n')
    .filter((l) => l.startsWith('- ') || /^##\s/.test(l))
    .join('\n');
}

const systemPrompt = `You are a senior code reviewer. Given a single file that was modified in a pull request, write a concise review focused on the most important issues.

Respond ONLY with valid JSON matching this exact schema — no prose before or after:
{
  "summary": string,
  "comments": [{ "line": number, "category": "logic"|"style"|"syntax", "body": string }]
}

Hard rules (all must be followed):
- Only comment on the most pressing, objective issues. Most files need 0-2 comments. Zero comments is perfectly acceptable.
- Never say "check", "verify", "consider", "ensure", "validate", "confirm".
- Never describe what the change does — that's obvious from the diff.
- Assume every design decision is deliberate. Don't suggest revisiting choices.
- Assume imports, dependencies, and callers are correct — don't tell the user to inspect them.
- Never recommend adding docstrings, logs, or comments unless something is actively wrong.
- Each comment must cite a specific line number from the "File with line numbers" section.
- Prefer logic issues (bugs, edge cases, race conditions) over style.

The user will ALSO provide a Review Memory with team-specific rules and suppressions. Follow the rules and NEVER violate the suppressions.`;

const memoryBlock = bundle.memory ? extractMemorySections(bundle.memory.content) : '(no memory)';
const ruleBlock = Object.entries(bundle.rules)
  .map(([k, v]) => `### ${k}\n${v.slice(0, 800)}`)
  .join('\n\n');

// Truncate fullContent if very large to fit context
const MAX_BODY_CHARS = 14000;
let body = file.fullContent;
if (body.length > MAX_BODY_CHARS) {
  body = body.slice(0, MAX_BODY_CHARS) + '\n... [truncated for context window]';
}

const userPrompt = `Repository: ${bundle.meta.repo}
Base: ${bundle.meta.base}
PR scope: ${bundle.meta.changedFileCount} files changed

=== Review Memory (team preferences) ===
${memoryBlock}

=== Project rules ===
${ruleBlock}

=== File under review ===
Path: ${file.path}
Status: ${file.status} (+${file.additions} / -${file.deletions})
${file.prevPath ? `Renamed from: ${file.prevPath}` : ''}

=== Extracted symbols ===
exports:   ${file.symbols.exports.join(', ') || '(none)'}
functions: ${file.symbols.functions.join(', ') || '(none)'}
classes:   ${file.symbols.classes.join(', ') || '(none)'}

=== Direct dependencies (internal) ===
${fmtImports(file.directImports)}

=== Callers (who imports this file) ===
${fmtCallers(file.directCallers)}

=== 2-hop forward (reached through direct deps) ===
${fmtHops(file.multiHop.forwardTiers)}

=== 2-hop reverse (callers-of-callers) ===
${fmtHops(file.multiHop.reverseTiers)}

=== Semantically similar files (embedding cosine) ===
${fmtNeighbors(file.semanticNeighbors)}

=== Other files in this PR ===
${file.otherChangedFiles.slice(0, 15).join('\n') || '(none)'}

=== Diff ===
${file.patch.slice(0, 6000)}${file.patch.length > 6000 ? '\n... [truncated]' : ''}

=== File with line numbers ===
${body}

Respond ONLY with the JSON review object.`;

console.error(`[review] prompt bytes: system=${systemPrompt.length} user=${userPrompt.length} total≈${Math.round((systemPrompt.length + userPrompt.length) / 4)}t`);

// ---------------------------------------------------------------------------
// Call Ollama chat
// ---------------------------------------------------------------------------
const t0 = Date.now();

console.error(`[review] calling ${MODEL}... (this can take several minutes for a 31B model)`);
// Bun's fetch has a default 10s idle timeout via undici that kills long-running
// Ollama generation calls. Pass an explicit AbortSignal with a large timeout.
const res = await fetch(`${OLLAMA_URL}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    stream: false,
    format: 'json',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    options: {
      temperature: 0.2,
      num_ctx: 16384,
    },
  }),
  signal: AbortSignal.timeout(30 * 60 * 1000),
});

if (!res.ok) {
  const t = await res.text().catch(() => '');
  console.error(`[review] ollama ${res.status}: ${t.slice(0, 500)}`);
  process.exit(1);
}

const data = (await res.json()) as {
  message?: { content?: string };
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
};
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const content = data.message?.content ?? '';

console.error(`[review] done in ${elapsed}s — prompt=${data.prompt_eval_count ?? '?'}t  gen=${data.eval_count ?? '?'}t`);
console.error();

console.log('===============================================================');
console.log('  REVIEW TARGET :', file.path);
console.log('  MODEL         :', MODEL);
console.log('  ELAPSED       :', elapsed + 's');
console.log('===============================================================');
console.log();
console.log('--- raw response ---');
console.log(content);
console.log();

// Parse and pretty-print
try {
  const parsed = JSON.parse(content);
  console.log('--- parsed ---');
  console.log();
  if (parsed.summary) {
    console.log('SUMMARY:');
    console.log('  ' + parsed.summary.split('\n').join('\n  '));
    console.log();
  }
  if (Array.isArray(parsed.comments) && parsed.comments.length > 0) {
    console.log(`COMMENTS (${parsed.comments.length}):`);
    for (const c of parsed.comments) {
      console.log(`  line ${c.line}  [${c.category}]`);
      console.log('    ' + (c.body || '').split('\n').join('\n    '));
      console.log();
    }
  } else {
    console.log('COMMENTS: (none — "most files need 0-2 comments, zero is acceptable")');
  }
} catch (e) {
  console.error('[review] response was not valid JSON:', (e as Error).message);
}
