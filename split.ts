#!/usr/bin/env bun
/**
 * split.ts — slice a review-context bundle into per-bucket per-pass text files.
 *
 * Usage:
 *   bun run split.ts <bundle.json> [outDir]
 *
 * Emits:
 *   <outDir>/00-overview.md             # PR stats, bucket map, shared notes
 *   <outDir>/rules-and-memory.md        # CLAUDE.md + AGENTS.md + REVIEW_MEMORY.md
 *   <outDir>/prompts/pass1+3.md         # coupled P1+P3 prompt template
 *   <outDir>/prompts/pass2.md           # P2 prompt template
 *   <outDir>/prompts/pass4.md           # P4 prompt template
 *   <outDir>/buckets/<id>-<name>/
 *     pass1+3.md                        # per-file: patch + fullContent + symbols
 *     pass2.md                          # per-file: signatures + imports + callers
 *     pass4.md                          # per-file: patch + external deps + PR-wide
 *
 * Each bucket/pass file is self-contained: a codex agent can read ONE file
 * and have everything it needs for that review pass on that bucket.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Bundle types (mirror index.ts)
// ---------------------------------------------------------------------------
interface SemanticNeighbor { path: string; score: number; alsoIn?: string[] }
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

// ---------------------------------------------------------------------------
// Bucket assignment
// ---------------------------------------------------------------------------
interface BucketDef {
  id: string;
  name: string;
  match: (path: string) => boolean;
}

const BUCKETS: BucketDef[] = [
  {
    id: '01',
    name: 'db-migrations-and-schema',
    // Migrations deserve their own bucket because the skill requires extra
    // scrutiny: CREATE INDEX CONCURRENTLY, backfills, check constraints,
    // rollback plans. Pull in schema.prisma too because migrations and the
    // schema file have to stay consistent.
    match: (p) =>
      p.includes('/prisma/migrations/') ||
      p.endsWith('schema.prisma') ||
      p.endsWith('.sql'),
  },
  {
    id: '02',
    name: 'backend-api-routes',
    match: (p) =>
      p.startsWith('apps/backend/src/app/api/') ||
      p.startsWith('apps/backend/src/route-handlers/'),
  },
  {
    id: '03',
    name: 'backend-lib',
    match: (p) =>
      p.startsWith('apps/backend/src/lib/') ||
      p.startsWith('apps/backend/scripts/') ||
      p === 'apps/backend/prisma/seed.ts',
  },
  {
    id: '04',
    name: 'dashboard-pages',
    match: (p) =>
      p.startsWith('apps/dashboard/src/app/'),
  },
  {
    id: '05',
    name: 'dashboard-components-and-lib',
    match: (p) =>
      p.startsWith('apps/dashboard/src/components/') ||
      p.startsWith('apps/dashboard/src/lib/'),
  },
  {
    id: '06',
    name: 'e2e-tests',
    match: (p) => p.startsWith('apps/e2e/'),
  },
  {
    id: '07',
    name: 'shared-packages',
    match: (p) =>
      p.startsWith('packages/stack-shared/') ||
      p.startsWith('packages/stack-cli/') ||
      p.startsWith('packages/stack/') ||
      p.startsWith('packages/template/') ||
      p.startsWith('packages/dashboard-ui-components/') ||
      p.startsWith('packages/react/') ||
      p.startsWith('packages/js/') ||
      p.startsWith('packages/stack-sc/') ||
      p.startsWith('packages/stack-ui/'),
  },
  {
    id: '08',
    name: 'other-apps',
    match: (p) =>
      (p.startsWith('apps/') &&
       !p.startsWith('apps/backend/') &&
       !p.startsWith('apps/dashboard/') &&
       !p.startsWith('apps/e2e/')),
  },
  {
    id: '09',
    name: 'config-ci-docs',
    match: (p) =>
      p.startsWith('.github/') ||
      p === 'package.json' ||
      p === 'pnpm-lock.yaml' ||
      p === 'pnpm-workspace.yaml' ||
      p.startsWith('docs/') ||
      p.startsWith('docs-mintlify/') ||
      p.startsWith('docker/') ||
      p.startsWith('configs/') ||
      p.startsWith('claude/') ||
      p.endsWith('.md') ||
      p === 'CLAUDE.md' ||
      p === 'AGENTS.md' ||
      p.endsWith('.css'),
  },
];

function bucketOf(path: string): BucketDef {
  for (const b of BUCKETS) if (b.match(path)) return b;
  return { id: '99', name: 'misc', match: () => false };
}

// ---------------------------------------------------------------------------
// Formatting helpers — compact, codex-friendly
// ---------------------------------------------------------------------------
function hr(): string {
  return '\n---\n';
}

function bulletList(xs: string[]): string {
  if (xs.length === 0) return '_(none)_';
  return xs.map((x) => '- ' + x).join('\n');
}

function fmtInternalImports(f: FileEntry): string {
  const internal = f.directImports.filter((i) => i.kind === 'internal');
  if (internal.length === 0) return '_(none)_';
  return internal
    .map((i) => {
      const syms = i.namedSymbols.length > 0 ? ` { ${i.namedSymbols.join(', ')} }` : '';
      return `- \`${i.resolvedPath}\`${syms}`;
    })
    .join('\n');
}

function fmtExternalImports(f: FileEntry): string {
  const external = f.directImports.filter((i) => i.kind === 'external');
  if (external.length === 0) return '_(none)_';
  // Deduplicate by specifier, merge named symbols
  const map = new Map<string, Set<string>>();
  for (const i of external) {
    if (!map.has(i.specifier)) map.set(i.specifier, new Set());
    for (const n of i.namedSymbols) map.get(i.specifier)!.add(n);
  }
  return [...map.entries()]
    .map(([spec, syms]) => {
      const list = [...syms];
      return `- \`${spec}\`${list.length ? ` { ${list.join(', ')} }` : ''}`;
    })
    .join('\n');
}

function fmtCallers(f: FileEntry, limit = 8): string {
  if (f.directCallers.length === 0) return '_(no known internal callers)_';
  return f.directCallers
    .slice(0, limit)
    .map((c) => {
      const syms = c.importedSymbols.length > 0 ? ` uses { ${c.importedSymbols.join(', ')} }` : '';
      return `- \`${c.path}\`${syms}`;
    })
    .join('\n');
}

function fmtHops(tiers: HopNode[][], tierIdx: number): string {
  const tier = tiers[tierIdx];
  if (!tier || tier.length === 0) return '_(none)_';
  return tier.slice(0, 10).map((n) => `- \`${n.path}\` ← via \`${n.via}\``).join('\n');
}

function sym(s: string[]): string {
  return s.length === 0 ? '_(none)_' : s.map((x) => `\`${x}\``).join(', ');
}

/**
 * Trim fullContent to a reasonable size for context windows. The first 60KB
 * budget already applied when the bundle was built, but for codex we cap a
 * bit tighter per-file to keep the bucket file manageable.
 */
function trimContent(content: string, maxChars: number): { body: string; truncated: boolean } {
  if (content.length <= maxChars) return { body: content, truncated: false };
  return { body: content.slice(0, maxChars) + '\n... [truncated, file continues]', truncated: true };
}

// ---------------------------------------------------------------------------
// Per-bucket per-pass emitters
// ---------------------------------------------------------------------------
const MAX_CONTENT_PER_FILE = 45_000;
const MAX_PATCH_PER_FILE = 12_000;

function emitP1P3ForFile(f: FileEntry): string {
  const patch = trimContent(f.patch, MAX_PATCH_PER_FILE);
  const content = trimContent(f.fullContent, MAX_CONTENT_PER_FILE);
  return `
## \`${f.path}\`

Status: **${f.status}**  +${f.additions} / -${f.deletions}
${f.prevPath ? `Renamed from: \`${f.prevPath}\`\n` : ''}
Extracted symbols:
- exports: ${sym(f.symbols.exports)}
- functions: ${sym(f.symbols.functions)}
- classes: ${sym(f.symbols.classes)}

### Diff

\`\`\`diff
${patch.body.trim() || '(no diff available)'}
\`\`\`
${patch.truncated ? '\n_(patch truncated)_\n' : ''}

### Full file (with line numbers)

\`\`\`
${content.body.trim() || '(no content available)'}
\`\`\`
${content.truncated ? '\n_(file body truncated)_\n' : ''}
`.trim() + '\n';
}

function emitP2ForFile(f: FileEntry): string {
  // For contracts-between-files we need signatures, relationships, and the
  // CHANGED portions (patch) but not the whole file body.
  const patch = trimContent(f.patch, MAX_PATCH_PER_FILE);
  return `
## \`${f.path}\`

Status: **${f.status}**  +${f.additions} / -${f.deletions}

Exported symbols: ${sym(f.symbols.exports)}
Top-level functions: ${sym(f.symbols.functions)}
Classes: ${sym(f.symbols.classes)}

### Direct internal dependencies (what this file imports)
${fmtInternalImports(f)}

### Callers (what imports this file)
${fmtCallers(f)}

### 2-hop forward reachability (what those imports import)
${fmtHops(f.multiHop.forwardTiers, 1)}

### 2-hop reverse reachability (callers of callers)
${fmtHops(f.multiHop.reverseTiers, 1)}

### Diff (the changed portion)

\`\`\`diff
${patch.body.trim() || '(no diff available)'}
\`\`\`
${patch.truncated ? '\n_(patch truncated)_\n' : ''}
`.trim() + '\n';
}

function emitP4ForFile(f: FileEntry): string {
  // For high-level + external, emphasize patch + external imports + scope.
  const patch = trimContent(f.patch, MAX_PATCH_PER_FILE);
  const content = trimContent(f.fullContent, 20_000); // shorter body for P4
  return `
## \`${f.path}\`

Status: **${f.status}**  +${f.additions} / -${f.deletions}

### External dependencies (third-party libraries, node built-ins)
${fmtExternalImports(f)}

### Diff

\`\`\`diff
${patch.body.trim() || '(no diff available)'}
\`\`\`

### File body (trimmed for high-level view)

\`\`\`
${content.body.trim() || '(no content available)'}
\`\`\`
${content.truncated ? '\n_(file body truncated; see pass1+3 context for full body)_\n' : ''}
`.trim() + '\n';
}

// ---------------------------------------------------------------------------
// Bucket file emitters
// ---------------------------------------------------------------------------
function bucketHeader(
  bucket: BucketDef,
  files: FileEntry[],
  bundle: Bundle,
  passName: string,
): string {
  const otherBuckets: Record<string, string[]> = {};
  for (const f of bundle.files) {
    const b = bucketOf(f.path);
    if (b.id === bucket.id) continue;
    if (!otherBuckets[b.name]) otherBuckets[b.name] = [];
    otherBuckets[b.name]!.push(f.path);
  }
  const otherBucketSummary = Object.entries(otherBuckets)
    .map(([name, paths]) => `- **${name}** (${paths.length} files)`)
    .join('\n');

  return `# Bucket ${bucket.id}: \`${bucket.name}\` — ${passName}

Repo: \`${bundle.meta.repo}\`
Base: \`${bundle.meta.base}\`
This bucket: **${files.length} files**
Total PR: **${bundle.meta.changedFileCount} files changed across ${Object.keys(otherBuckets).length + 1} buckets**

## Files in this bucket
${bulletList(files.map((f) => `\`${f.path}\`  (+${f.additions}/-${f.deletions})`))}

## Other buckets in this PR (for cross-cutting awareness)
${otherBucketSummary || '_(none)_'}
`;
}

function emitBucketP1P3(bucket: BucketDef, files: FileEntry[], bundle: Bundle): string {
  const header = bucketHeader(bucket, files, bundle, 'Pass 1+3 (Intention vs Implementation, Code Quality)');
  return header + '\n' + hr() + '\n' + files.map(emitP1P3ForFile).join('\n' + hr() + '\n');
}

function emitBucketP2(bucket: BucketDef, files: FileEntry[], bundle: Bundle): string {
  const header = bucketHeader(bucket, files, bundle, 'Pass 2 (Inter-file Contracts)');
  return header + '\n' + hr() + '\n' + files.map(emitP2ForFile).join('\n' + hr() + '\n');
}

function emitBucketP4(bucket: BucketDef, files: FileEntry[], bundle: Bundle): string {
  const header = bucketHeader(bucket, files, bundle, 'Pass 4 (High-level Assumptions + External Context)');
  return header + '\n' + hr() + '\n' + files.map(emitP4ForFile).join('\n' + hr() + '\n');
}

// ---------------------------------------------------------------------------
// Shared files
// ---------------------------------------------------------------------------
function emitOverview(bundle: Bundle, assignments: Map<string, FileEntry[]>): string {
  const lines: string[] = [];
  lines.push('# PR Review Context — Overview');
  lines.push('');
  lines.push(`Repo: \`${bundle.meta.repo}\``);
  lines.push(`Base: \`${bundle.meta.base}\``);
  lines.push(`Generated: \`${bundle.meta.generatedAt}\``);
  lines.push(`Diff mode: \`${bundle.meta.diffMode}\``);
  lines.push('');
  lines.push(`## Stats`);
  lines.push(`- Files changed: **${bundle.meta.changedFileCount}**`);
  lines.push(`- Total files indexed: ${bundle.meta.indexedFileCount}`);
  lines.push(`- Graph edges: ${bundle.meta.graphEdgeCount}`);
  lines.push(`- Max hops: ${bundle.meta.maxHops}`);
  lines.push('');
  lines.push(`## PR description`);
  lines.push(`_(working-tree diff — no PR description associated)_`);
  lines.push('');
  lines.push(`## Bucket map`);
  for (const [id, files] of [...assignments.entries()].sort()) {
    const bucket = BUCKETS.find((b) => b.id === id.split('-')[0]);
    if (!bucket) continue;
    const totalAdds = files.reduce((s, f) => s + f.additions, 0);
    const totalDels = files.reduce((s, f) => s + f.deletions, 0);
    lines.push(`### ${id}: \`${bucket.name}\` (${files.length} files, +${totalAdds}/-${totalDels})`);
    for (const f of files) {
      lines.push(`- \`${f.path}\`  (+${f.additions}/-${f.deletions}, ${f.status})`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function emitRulesAndMemory(bundle: Bundle): string {
  const parts: string[] = [];
  parts.push('# Project rules + review memory');
  parts.push('');
  parts.push('_This file is loaded alongside every bucket/pass context. Codex should treat it as binding: the Rules must be followed, the Suppressed patterns must not be commented on, and project conventions (CLAUDE.md, AGENTS.md) override the reviewer\'s defaults._');
  parts.push('');
  if (bundle.memory) {
    parts.push(`## REVIEW_MEMORY.md  (\`${bundle.memory.path}\`)`);
    parts.push('```');
    parts.push(bundle.memory.content.trim());
    parts.push('```');
    parts.push('');
  }
  for (const [name, content] of Object.entries(bundle.rules)) {
    parts.push(`## ${name}`);
    parts.push('```');
    parts.push(content.trim().slice(0, 8000));
    parts.push('```');
    parts.push('');
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Pre-pass: load-bearing invariant + surface map
// ---------------------------------------------------------------------------
/**
 * The pre-pass is a single codex call that reads the diff at a high level
 * and produces two outputs that every later pass consumes:
 *
 *   1. **Load-bearing invariant**: a single sentence describing what the PR
 *      is fundamentally trying to do. The invariant is the rule that, if
 *      broken anywhere, breaks the PR's correctness.
 *
 *   2. **Surface map**: a list of every symbol/table/function/env-var the
 *      PR adds or changes in a load-bearing way.
 *
 * Both are written to /tmp/review-run-X/PRELUDE.md by the codex pre-pass
 * agent. Every subsequent bucket prompt is told to read PRELUDE.md as
 * context.
 */
function emitPreludeContext(bundle: Bundle): string {
  // Compact prelude. Goal: give the prelude pass enough to identify the
  // load-bearing invariant + surface map WITHOUT shipping every hunk of
  // every file. Strategy: file list + AST symbols from bundle + targeted
  // diffs only for high-signal files (migrations, schema, new files).
  const lines: string[] = [];
  lines.push('# PR Prelude — input for the load-bearing-invariant + surface-map pass');
  lines.push('');
  lines.push(`Repo: \`${bundle.meta.repo}\``);
  lines.push(`Base: \`${bundle.meta.base}\``);
  lines.push(`Files changed: ${bundle.meta.changedFileCount}`);
  lines.push('');

  // Group files by status + size
  const added = bundle.files.filter((f) => f.status === 'added');
  const modified = bundle.files.filter((f) => f.status === 'modified');
  const deleted = bundle.files.filter((f) => f.status === 'deleted');
  const renamed = bundle.files.filter((f) => f.status === 'renamed');

  lines.push('## Changed files (grouped)');
  lines.push('');
  lines.push(`### Added (${added.length})`);
  for (const f of added) {
    const syms = (f.symbols.exports.length || 0) + (f.symbols.functions.length || 0);
    lines.push(`- \`${f.path}\` (+${f.additions}, ${syms} new symbols)`);
  }
  lines.push('');
  lines.push(`### Modified (${modified.length})`);
  for (const f of modified) {
    lines.push(`- \`${f.path}\` (+${f.additions}/-${f.deletions})`);
  }
  if (renamed.length > 0) {
    lines.push('');
    lines.push(`### Renamed (${renamed.length})`);
    for (const f of renamed) {
      lines.push(`- \`${f.prevPath}\` → \`${f.path}\``);
    }
  }
  if (deleted.length > 0) {
    lines.push('');
    lines.push(`### Deleted (${deleted.length})`);
    for (const f of deleted) lines.push(`- \`${f.path}\``);
  }
  lines.push('');

  // High-signal files: migrations, schema, new source files. Inline their
  // diffs in full so the prelude pass can extract structural facts.
  const highSignal = bundle.files.filter((f) => {
    if (f.path.includes('/prisma/migrations/')) return true;
    if (f.path.endsWith('schema.prisma')) return true;
    if (f.path.endsWith('.sql')) return true;
    if (f.status === 'added' && SOURCE_EXTS_FOR_PRELUDE.has(extname(f.path))) return true;
    return false;
  });

  if (highSignal.length > 0) {
    lines.push('## High-signal file diffs (migrations, schema, newly added source)');
    lines.push('');
    for (const f of highSignal) {
      if (!f.patch) continue;
      lines.push(`### \`${f.path}\` (${f.status}, +${f.additions}/-${f.deletions})`);
      lines.push('```diff');
      const trimmed = f.patch.length > 8000
        ? f.patch.slice(0, 8000) + '\n... [truncated, full content in bucket]'
        : f.patch;
      lines.push(trimmed);
      lines.push('```');
      lines.push('');
    }
  }

  // For everything else, ship just the AST-extracted symbols (no diffs).
  const otherChanged = bundle.files.filter((f) => !highSignal.includes(f) && f.symbols && (f.symbols.exports.length + f.symbols.functions.length + f.symbols.classes.length) > 0);
  if (otherChanged.length > 0) {
    lines.push('## Other changed files — extracted symbols only (no diffs in prelude)');
    lines.push('');
    for (const f of otherChanged) {
      const ex = f.symbols.exports.slice(0, 8).join(', ');
      const fn = f.symbols.functions.slice(0, 8).join(', ');
      const cl = f.symbols.classes.slice(0, 4).join(', ');
      const parts: string[] = [];
      if (ex) parts.push(`exports: ${ex}`);
      if (fn) parts.push(`functions: ${fn}`);
      if (cl) parts.push(`classes: ${cl}`);
      if (parts.length > 0) {
        lines.push(`- \`${f.path}\` — ${parts.join('; ')}`);
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('Note: full file bodies and patches for every changed file are available');
  lines.push('in the bucket-context files at `/tmp/review-run-X/buckets/<id>/pass1+3.md`.');
  lines.push('You may also `cat`/`rg` the actual repo at the cwd you were started in.');
  return lines.join('\n');
}

const SOURCE_EXTS_FOR_PRELUDE = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
]);

const PROMPT_CALLSITE_AUDIT = `# Codex instructions — Cross-PR Callsite Audit

You are doing the **callsite audit pass** of a structured PR review. This
pass exists for one reason: bugs that aren't IN the PR's diff but break
the PR's load-bearing invariant. The single most common version: the PR
adds a new "you must do X on every mutation" rule, but there are existing
mutation sites in unchanged files that don't do X.

Your job is to find every such site.

## Inputs

You will be told paths for:

1. \`/tmp/review-run-X/prompts/callsite-audit.md\` (this file)
2. \`/tmp/review-run-X/rules-and-memory.md\` — project rules
3. \`/tmp/review-run-X/PRELUDE.md\` — output of the pre-pass with the
   load-bearing invariant + surface map. Items marked \`[INVARIANT]\` are
   the ones to audit.

You may grep, rg, cat, sed, and follow imports across the entire repo at
the cwd you were started in. You may NOT edit any file other than the
single output markdown file.

## What to do

For EACH item in the surface map marked \`[INVARIANT]\`:

### If the invariant is "every mutation to table T must do X"

1. Identify the prisma/SQL operations that mutate T:
   - \`prisma.<lowerCamelT>.update\`
   - \`prisma.<lowerCamelT>.updateMany\`
   - \`prisma.<lowerCamelT>.upsert\`
   - \`prisma.<lowerCamelT>.create\` (if create-time also matters)
   - Raw SQL: \`UPDATE "T" SET ...\`
2. \`rg\` for each pattern across the **entire repo**.
3. For each callsite, open the file and check whether it does X.
4. Report every site that does NOT do X, with file:line and a one-line
   note about what mutation it's doing.

### If the invariant is "every deletion of T must record a tombstone first"

1. Identify the deletion operations: \`prisma.<lowerCamelT>.delete\`,
   \`.deleteMany\`, raw \`DELETE FROM "T"\`.
2. For each, check whether \`recordExternalDbSync*Deletion\` (or similar
   tombstone mechanism named in the surface map) is called BEFORE the
   delete.
3. Report violations.

### If the invariant is "every call to API X must be idempotent"

1. \`rg\` for callsites of X.
2. For each, check whether an idempotency key is passed.
3. Report violations.

### If the invariant is some other shape

Generalize from the above: identify the operation the invariant
constrains, find every callsite, audit each one.

## Don't audit the changed files themselves

Pass 1+3 already does that. Your job is the OPPOSITE: audit files OUTSIDE
the PR's changed-file list. Skip any file that appears in the changed-files
list (you can see it in PRELUDE.md or 00-overview.md).

That is the entire point of this pass — to find bugs Pass 1+3 cannot
find because Pass 1+3 only sees the diff.

## Output format

Plain markdown grouped by invariant. For each invariant, list every
violation found. Use file:line. Include a brief note showing the
offending code excerpt.

\`\`\`markdown
# Cross-PR Callsite Audit

## Invariant 1: every mutation to a synced table must call \`withExternalDbSyncUpdate\`

### \`ProjectUserRefreshToken\`

Mutation pattern audited: \`prisma.projectUserRefreshToken.update*|upsert\`,
\`UPDATE "ProjectUserRefreshToken"\`.

**Violations found:**

- \`apps/backend/src/lib/tokens.tsx:263\` — \`refreshTokenLastActiveAtUpdater\`
  does \`projectUserRefreshToken.update({ data: { lastActiveAt: now, ... } })\`
  without \`withExternalDbSyncUpdate\`. This is the **highest-frequency
  mutation in the entire app** (every access-token refresh) so the bug
  has maximum blast radius.

  \`\`\`typescript
  // L259 ProjectUser update DOES wrap with withExternalDbSyncUpdate
  // L263 ProjectUserRefreshToken update does NOT — asymmetric
  globalPrismaClient.projectUserRefreshToken.update({ ..., data: { lastActiveAt, ... } })
  \`\`\`

- \`apps/backend/src/oauth/model.tsx:174\` — \`saveToken\` upsert sets
  \`refreshToken\` and \`expiresAt\` without wrapping. expiresAt is synced.

### \`Team\`

Mutation pattern audited: \`prisma.team.update*\`, \`UPDATE "Team"\`.

**Violations found:**

- \`apps/backend/src/app/api/latest/users/crud.tsx:1126\` — personal-team
  rename uses bare \`tx.team.updateMany({ data: { displayName } })\`.
  \`displayName\` IS synced.

### \`VerificationCode\`

...

(etc.)

## Invariant 2: every deletion of a synced row must record a tombstone first

(format as above)

## Files audited

Total invariants audited: N
Total callsites checked across the repo: N
Files I read with cat/sed: N
\`\`\`

If you find no violations for an invariant, write
\`_(audited; no violations found)_\` under it.

## Hard rules

- Skip files in the PR's changed-files list. Those are Pass 1+3's job.
- Be exhaustive within the audit. If you say "audited prisma.team.update",
  show that you actually grepped for it (mention the rg invocation).
- If a callsite is borderline (e.g. mutates a non-synced field on a
  synced table), still flag it as a "consistency risk" with lower
  severity — that's the kind of thing that becomes a bug the moment
  someone adds a new synced field.
- Never flag anything matching a Suppressed pattern from the review memory.
`;

const PROMPT_PRELUDE = `# Codex instructions — Pre-pass: load-bearing invariant + surface map

You are doing the FIRST pass of a structured PR review. This pass is
load-bearing for every later pass — they will all read your output and
use it as the lens for finding bugs.

You may grep/cat/rg the actual repo freely.
You may NOT edit any file other than the single output file you're told
to write.

## Your job

Read the PR prelude file (changed files + diff hunks). Then:

### 1. Identify the LOAD-BEARING INVARIANT of this PR

In one sentence, what is the rule that — if broken anywhere — breaks the
correctness of this PR?

Examples of well-formed invariants:
- "Every mutation to a synced row must bump \`shouldUpdateSequenceId =
  true\`."
- "Every deletion of a row in a synced table must record an external-DB
  tombstone before the underlying delete commits."
- "Every Stripe webhook handler must be idempotent on the (eventId,
  customerId) tuple."
- "The \`turnstile_token\` must be verified server-side before any
  password-update or sign-in completion."

The invariant should be specific enough that you can audit individual
callsites against it. Generic statements ("the code should be correct")
do not qualify.

If you can't identify a single invariant, identify TWO at most. If the
PR is doing multiple unrelated things, write one invariant per concern.

### 2. Build the SURFACE MAP

List every load-bearing thing the PR adds or changes:

- **New tables / schema columns** (from migration files + schema.prisma)
- **New functions or methods** (top-level, exported)
- **New env vars / config keys**
- **New API routes / route handlers**
- **New CLI commands**
- **Changed function signatures** (anything where the type or parameter
  list changed in a way callers must adapt to)
- **New data flows** (e.g. "ProjectUserOAuthAccount.providerAccountId
  now flows into oauthAuthMethod via webhook handler")

For each item, give:
- The name + file path
- Whether it's NEW or CHANGED
- A one-line description of what it does or stores
- IF it's a mutation site for a synced table or anything that touches the
  load-bearing invariant, mark it with \`[INVARIANT]\`

### 3. Identify suspicious half-states

Half-state = something the PR adds in one place but doesn't follow
through on in another. Examples:
- Schema columns added for a table the sync impl doesn't actually handle
- Test helpers added but never called
- A new flag wired up in 3 places but missed in a 4th
- A new env var documented in .env.example but never read

List every half-state you can identify from the diff alone.

## Output format

Write to the output path you're told. Plain markdown:

\`\`\`markdown
# PR Prelude (codex output)

## Load-bearing invariant

[ONE sentence. At most TWO if the PR is doing multiple unrelated things.]

## Surface map

### New tables / schema
- \`Team.sequenceId BIGINT\` (NEW, \`apps/backend/prisma/schema.prisma:182\`)
  — sequence-tracking column for external-DB sync
- \`Team.shouldUpdateSequenceId BOOLEAN NOT NULL DEFAULT TRUE\` (NEW, same
  file:183) **[INVARIANT]** — must be bumped on every Team mutation

### New functions
- \`recordExternalDbSyncTeamMemberDeletion\` (NEW,
  \`apps/backend/src/lib/external-db-sync.ts:1234\`) **[INVARIANT]** —
  must be called BEFORE any TeamMember row delete

### New API routes
(none)

### Changed function signatures
- \`syncExternalDatabases()\` (\`external-db-sync.ts:780\`) — error path
  changed: now returns \`false\` on per-DB failure (was \`throw\`).
  Callers may break.

### Suspicious half-states
- \`SessionReplay.sequenceId\` columns added (migration + schema), and
  the sequencer in \`sequencer/route.ts:340\` has a SessionReplay block,
  and \`waitForSyncedSessionReplay\` exists in the e2e test helper at
  \`external-db-sync-utils.ts:358\`, BUT \`db-sync-mappings.ts\` has no
  SessionReplay entry and \`clickhouse-migrations.ts\` has no
  SESSION_REPLAYS_TABLE_BASE_SQL. Either revert all SessionReplay parts
  or finish the mapping.

## Audit hints for later passes

For pass 1+3 / 2 / 4 to do their best work, here are the things they
should specifically check across the bucket they're given:

- For every mutation site of a [INVARIANT]-tagged table, check whether
  it bumps the flag (use rg).
- For every deletion site, check whether \`recordExternalDbSync*Deletion\`
  is called BEFORE the prisma delete.
- For every new mapping in db-sync-mappings.ts, compare against the
  closest legacy mapping (\`users\`) for shape consistency.
\`\`\`

## Hard rules

- Be SPECIFIC. Vague invariants help no one. If you write
  "the code should sync correctly" you have failed.
- Don't try to find every bug — that's later passes' job. Your job is
  to set them up to find every bug.
- Prefer fewer, more precise invariants over many vague ones.
`;

// ---------------------------------------------------------------------------
// Pass prompt templates (these are what tells codex which lens to apply)
// ---------------------------------------------------------------------------
const PROMPT_P1P3 = `# Codex instructions — Pass 1 (Intention vs Implementation) + Pass 3 (Code Quality)

You are performing passes **1 and 3** of a structured senior-engineer PR review.
These two passes share the same primary input (full file bodies) but apply
different lenses; do them together.

**Voice**: Do not use the N2D4/nams1570 reviewer persona. Synthesis into voice
happens in a later pass. Your job is RAW FINDINGS that the synthesis pass
will rewrite. Be terse on small stuff, but be willing to write a multi-sentence
walkthrough for serious bugs (see "Walkthroughs" below).

## You are encouraged to read the actual repo

The bucket context contains every file in this bucket inlined with line
numbers. But you are FREE — and ENCOURAGED — to:

- \`grep\`/\`rg\` the entire repo to verify hypotheses, find callsites,
  trace where a function is used, check whether a column is referenced
  somewhere else
- \`cat\`/\`sed\` files OUTSIDE the bucket if you need to understand a
  caller, a legacy pattern, or a contract
- Read existing tests to understand expected behavior
- Check git log if you need history context

**However:** never edit any file other than the output markdown file you
are told to write. No commits, no \`pnpm install\`, no test runs, no git
mutations, no formatter runs.

The project's review memory + rules will tell you the cwd that maps to the
worktree under review.

## Pass 1: Intention vs Implementation

For EACH file in the bucket:

1. State the file's intention in one short sentence — what is it SUPPOSED
   to do? If you cannot articulate the intention from the code alone, that
   is itself a finding (log as \`intent-unclear\`).
2. Walk the logic. Look for the gap between intention and implementation.
3. Hunt for:
   - **Logic errors** (off-by-one, wrong boolean, missing branch).
   - **Faulty assumptions** (things assumed unique, ordered, non-null, sync,
     atomic that aren't guaranteed to be).
   - **Load-bearing-invariant violations** — if the load-bearing invariant
     of the PR is given in the bucket context, check whether this file
     respects it. Grep for related callsites IN OTHER FILES (use \`rg\`)
     and audit them too.
   - **Symmetry** — if branch A does X, does branch B do the equivalent?
     If create-side does Y, does delete-side do the equivalent?
   - **Things that "should be fine here" but aren't fine elsewhere** the
     function is called from.

## Pass 3: Code Quality

For EACH file, ALSO evaluate:

- **Naming**: do function/variable names tell you exactly what they do?
- **Single responsibility**: does each function do ONE obvious thing?
- **Self-containment**: does it depend on global state or hidden side effects?
- **AI code smell**: fancy patterns for no reason, arcane runarounds,
  defensive fallbacks on paths that should have ONE valid outcome, generic
  error handling that swallows everything, comments that paraphrase the
  next line instead of explaining WHY.
- **Fallbacks where there should be one valid path** — flag aggressively.
  A function that "tries X, falls back to Y, falls back to Z" usually means
  the author didn't know the right behavior and hedged.
- **Type punching** — \`as any\`, \`as unknown as Foo\`, casts that bypass
  invariants the type system was supposed to enforce.

## Walkthroughs (the most valuable comment shape)

When you find a bug whose impact isn't obvious from the line itself,
write a multi-step hypothetical walkthrough showing how it manifests.
Pattern:

> **Bug walkthrough**: \`file.ts:LINE\`
>
> Lets say a customer has X. Then Y happens. Then this code runs:
> \`\`\`
> ...the offending lines...
> \`\`\`
> Because Z is not guaranteed, on the next iteration the value of W is
> stale/wrong/missing. The user-visible effect is ____.

These are the highest-value findings. Write them whenever a bug is real
but not surface-level.

## Concrete code suggestions

When the fix is obvious, include a code suggestion block:

\`\`\`suggestion
// the fixed line(s)
\`\`\`

Or for larger rewrites, a fenced code block showing the new shape. Don't
just describe the fix in prose if you can show it.

## Cross-callsite audit

Whenever you flag a finding that's an instance of a pattern (e.g.
"this update missing the flag bump"), grep the repo for OTHER instances of
the same pattern and report all the additional sites you find. The skill
specifically calls out doing this kind of sweep — it's where the
highest-impact bugs hide.

## Output format

Plain markdown grouped by file path (use the exact path from the bucket
context as a heading). Bullets for short findings, walkthroughs for
serious ones, suggestion blocks where the fix is obvious. Sort findings
within a file by line number.

\`\`\`
## apps/backend/src/lib/payments/refunds.ts

- Intention: handles refund processing for Stripe subscriptions
- L42: assumes \`endedAt < refundedAt\` but Stripe webhooks can arrive out
  of order. **Walkthrough**: customer cancels in week 1 → endedAt = T0.
  Refund posts asynchronously → refundedAt = T0 + 5min. Webhook for
  refund arrives BEFORE webhook for cancellation in 0.3% of cases (see
  Stripe docs). The block at L48 then runs \`state.activePurchases.delete(
  sourceKey)\` without the source actually being closed. Net effect:
  refund event silently no-ops.
- L58: catch-all swallows errors — should use \`instanceof\` to filter
  known error types and re-raise the rest. \`\`\`suggestion
  } catch (e) {
    if (e instanceof KnownStripeError) return Result.error(e);
    throw e;
  }
  \`\`\`
- L71: parameter \`context\` unused. Remove or use.
- naming: \`handleIt\` is vague — rename to \`processRefundForSource\`.

## CROSS-CALLSITE AUDIT

While reviewing this bucket I greped for other call sites of
\`recordExternalDbSyncDeletion\` because of the pattern at L37 and found:

- \`apps/backend/src/route-handlers/verification-code-handler.tsx:273\` —
  same backwards order (record deletion before \`verificationCode.delete\`)
- \`apps/backend/src/lib/permissions.tsx:434\` — INVERSE problem: deletion
  done without recording at all
\`\`\`

If a file has zero findings, write \`- _(no findings)_\` under it.

Always do at least ONE cross-callsite audit per pattern you flag, and put
the results in a CROSS-CALLSITE AUDIT section at the bottom of your
output.

## Hard rules

- Follow the project rules file (CLAUDE.md, AGENTS.md) loaded with this prompt.
- Never flag anything matching a Suppressed pattern from the review memory.
- Never recommend adding docstrings/logs/comments unless something is wrong.
- Never use "MUST", "ALWAYS", "NEVER" in all caps in your findings.
`;

const PROMPT_P2 = `# Codex instructions — Pass 2 (Inter-file Contracts)

You are performing **Pass 2** of a structured senior-engineer PR review.
This pass finds bugs that only become visible when you look at how files
TALK TO EACH OTHER — schema vs query contracts, caller-callee assumptions,
type shape mismatches across boundaries.

**Voice**: raw findings only. Synthesis happens later.

## You are encouraged to read the actual repo

Same as Pass 1+3 — \`grep\`/\`rg\`/\`cat\` are FREE. Use them to:
- Compare schemas in one file to queries in another
- Find every consumer of a function the bucket changes
- Trace a JSON shape from where it's serialized to where it's consumed
- Look up legacy patterns (the closest existing analog) and compare

Never edit files outside the single output markdown file.

## What to look for

### A. Schema vs query mismatches (highest yield)

For every database mapping, schema definition, or DDL statement in the
bucket, find the SQL queries that READ or WRITE the corresponding columns
and check:

- Is every column the query references actually in the schema?
- Is every NOT NULL column in the schema always provided by the query
  (in every branch — including tombstone/deletion branches)?
- Do enum values match? (e.g. internal enum \`'EMAIL'\` cast to text vs
  external schema expecting lowercase \`'email'\`)
- Are dedup keys complete? (e.g. ClickHouse \`ORDER BY (project_id, id)\`
  missing \`tenancy_id\` → cross-tenancy collision)
- For ReplacingMergeTree/MergeTree/CollapsingMergeTree tables — does the
  ORDER BY match the actual unique key?

### B. Caller-callee contracts

For each pair of files where one imports the other:

1. Does function \`b\` make assumptions about the *shape*, *ordering*,
   *uniqueness*, or *completeness* of what function \`a\` returns?
2. Does \`b\`'s success path handle every variant \`a\` can return? Does
   \`b\`'s error path handle every error mode \`a\` can throw?
3. Implicit contracts like "the caller is expected to have already
   validated X" — are they documented or enforced?
4. Cross-file state invariants — who owns the invariant? If \`a\` sets a
   flag and \`b\` reads it, what happens if a third caller bypasses \`a\`?
5. Type shape mismatches — is the shape on one side what the other side
   expects? (Especially for things crossing JSON/SQL/HTTP boundaries.)

### C. Load-bearing-invariant audit

If the load-bearing invariant is supplied in the bucket context, walk
the bucket files looking for places where this invariant could be broken
across a file boundary. Then \`rg\` the entire repo for additional sites
where the invariant is at risk and report them.

### D. Security at the seam

- Input validation at the wrong layer (frontend instead of backend)
- Leaked info between trust boundaries (CRUD types in client lib, internal
  enums leaked to public schema)
- Missing authorization checks where one module assumed another already
  checked

## Output format

Plain markdown grouped by file. Cite the *other* file path when a finding
is about a contract between two files. Walkthroughs encouraged when the
bug needs explanation.

\`\`\`
## packages/stack-shared/src/config/db-sync-mappings.ts

### Schema vs query mismatches

- L332: \`contact_channels.type\` is copied from internal enum text
  ('EMAIL') via \`::text\`, but the public schema (also in this file at
  L405) only accepts lowercase 'email'. Any consumer filtering on
  \`type = 'email'\` (as documented in the SDK) will miss everything.
- L857: ClickHouse \`team_permissions\` ORDER BY = (project_id, branch_id,
  team_id, user_id) — missing \`tenancy_id\`. Two tenancies with the same
  (team_id, user_id) will collide on dedup. Same issue at L902, L948.
- L1141 (in \`external-db-sync.ts\`): \`CLICKHOUSE_COLUMN_NORMALIZERS.email_outboxes\`
  references \`rendered_is_transactional\`, but the CH schema in this file
  at L580 calls it \`is_transactional\`. Insert will skip normalization.

### Caller-callee contracts

- The \`team_invitations\` mapping at L450 selects \`recipient_email\` via
  \`"VerificationCode"."method"->>'email'\`, which is NULLABLE — but the
  PG external schema declares the column NOT NULL. Constraint violation
  on any verification code without an email key.
\`\`\`

If a bucket has only one file, do the schema/query check anyway — single
files often contain both schema definitions and queries against them.

Always include a section header for any bug class you find (Schema vs
query, Caller-callee, Load-bearing invariant, Security).

## Hard rules

- Follow the project rules file.
- Never flag anything matching a Suppressed pattern.
- Never recommend adding docstrings unless something is actively wrong.
`;

const PROMPT_P4 = `# Codex instructions — Pass 4 (High-level + Concurrency + External Context)

You are performing **Pass 4** — the bird's-eye-view pass. Step all the
way back and ask: does this PR make sense given the world it's deployed
into? At Stack Auth scale, with concurrent users, with the third-party
APIs actually behaving the way they actually behave?

**Voice**: raw findings only.

## You are encouraged to read the actual repo + external docs

\`grep\`/\`rg\`/\`cat\`/\`git log\` are all FREE for understanding the
broader codebase. Use them. You may also lean on web searches or pulled
documentation if you need to verify a third-party API's actual behavior
(don't guess from training data).

Never edit files outside the single output markdown file.

## What to look for

### A. Concurrency (the highest-yield category)

Walk every function in the bucket that could be called concurrently and
construct a hypothetical "what if 2 of these run at the same time" story.

- **Module-level mutable state** in shared modules — catastrophic.
- **Watermark / sequence races** — anything using \`nextval()\` or a
  timestamp as a "high water mark" needs to consider the case where T1
  is in flight when T2 commits. Postgres sequences are gap-free + unique
  but NOT in commit order. Reader using "latest seen" can permanently
  skip a row that was written but not yet committed when the read ran.
- **Two-system state sync** — what if call A to Stripe succeeds and call
  B to the DB fails? Or vice versa? Is there a sentry log + reconciliation
  path?
- **Missing idempotency** — external API calls that aren't keyed.
- **Module-level dedup keys** — does the dedup actually prevent double
  execution, or only double queueing?
- **Per-tenancy locks** — does anything need an advisory lock to
  serialize per-tenancy work?
- **Cron + worker overlap** — if this runs every 50ms and the previous
  iteration is still running, can the two collide?

For each concurrency concern, write a multi-step **walkthrough** showing
exactly how the bug manifests:

> **Walkthrough — sequenceId watermark race**:
>
> 1. T1 starts, calls \`nextval('global_seq_id')\` → 1000, holds row lock,
>    hasn't committed.
> 2. T2 starts, calls \`nextval('global_seq_id')\` → 1001, immediately
>    commits.
> 3. Sync worker queries
>    \`SELECT * FROM ... WHERE sequence_id > $lastSeen ORDER BY sequence_id\`,
>    sees only T2's row 1001 (T1 not yet visible). Pushes 1001 to CH and
>    advances watermark to 1001.
> 4. T1 commits.
> 5. Next iteration queries \`WHERE sequence_id > 1001\`. Row 1000 is
>    PERMANENTLY excluded.
>
> Effect: row silently never reaches CH. No alarm, no retry. Mitigations:
> per-tenancy advisory lock, or "safe lower bound" via
> \`pg_snapshot_xmin(pg_current_snapshot())\`.

### B. External dependency reality-check

For every third-party reference (Stripe, ClickHouse client, Postgres
driver, Cloudflare/Turnstile, OAuth providers, fetch calls), verify
against ACTUAL documented behavior, not the model's training memory:

- Does it throw on duplicate calls or swallow them?
- Does it retry automatically? With what backoff?
- What does it return on partial failure?
- Is there a documented rate limit being ignored?
- Is there a documented edge case (e.g. webhook arrival order, idempotency
  key TTL, BIGINT precision in the JS client, query timeout default of 0
  meaning "wait forever") that the PR doesn't account for?

If you're uncertain about a third-party behavior, say so explicitly with
"verify against $LIB docs" — don't guess.

### C. Data shape + volume

- Is this code in a hot path (every request) or cold (admin tooling)?
- 10 rows or 10 million?
- Big-O of any new query against the volume Stack Auth runs at?
- Frontend-only validation for things that should be backend-validated?

### D. Trust boundaries

- Anything validated client-only is a bug.
- Are CRUD types (snake_case) leaking to client lib (camelCase)?
- Do you see internal enum representations escaping to public schema?

### E. Observability

When this fails in production, will we know?
- Is there a Sentry call with rich enough context to fix without reproducing?
- Does the error type carry the request inputs, the response body, the
  status code?
- Does the failure path silently return a default vs failing loud?

### F. DB migrations (if any in the bucket)

- Transactional safety (\`CREATE INDEX CONCURRENTLY\` requires running
  outside a transaction — verify the sentinel).
- \`CREATE INDEX CONCURRENTLY IF NOT EXISTS\` is an UNSAFE pairing — if
  the build is interrupted, an invalid index is left behind and the
  IF NOT EXISTS silently skips it on rerun. Flag every instance.
- Locking hot tables.
- Backfill correctness — is the default value semantically right?
- \`ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT X\` rewrites the
  whole table on PG <11 — confirm PG version assumption.
- Are there CHECK constraints at the DB level for invariants the schema
  layer enforces? DB is source of truth.
- Constraint creation pattern: \`ADD CONSTRAINT ... NOT VALID\` followed
  by \`VALIDATE CONSTRAINT\` in a separate migration.

### G. Backwards compat

- Is this changing a public API/SDK signature in a breaking way?
- Is the migration path documented?
- Is there a feature flag / opt-out for the breaking case?

### H. Cross-PR awareness

Look at the "Other buckets in this PR" list at the top of the bucket
context. Does this bucket make sense given what else is changing? Are
there changes IN OTHER buckets that this bucket should react to but
doesn't? (e.g. schema added in db-migrations bucket, but the
corresponding mapping not added in shared-packages bucket — that's a
half-state.)

## Output format

Plain markdown grouped by file. Use the section letter (A-H) as the
finding category prefix. Bullets for short findings, walkthroughs for
serious ones, suggestion blocks where the fix is obvious.

\`\`\`
## apps/backend/src/lib/external-db-sync.ts

### A. Concurrency

- L1268: \`getClickhouseLastSyncedSequenceId\` reads
  \`_stack_sync_metadata\` via \`ORDER BY updated_at DESC LIMIT 1\` against
  a ReplacingMergeTree(updated_at) table. With unmerged parts this can
  return a STALE row, so the watermark can rewind. The status route
  (\`status/route.ts:632\`) does the same read via \`argMax(...,
  updated_at)\` which is correct. Standardize on argMax.

- **Walkthrough — sequenceId watermark race**:
  ... [as above]

### B. External

- L120: \`new pg.Client({ connectionString })\` constructed without
  \`connectionTimeoutMillis\`, \`query_timeout\`, or \`statement_timeout\`.
  A hung remote DB blocks the iteration until OS-level TCP timeout
  (minutes). Add tight bounds.
- L1141: \`Number(value)\` for a Postgres BIGINT — silently loses precision
  above 2^53. Sequence IDs are globally shared across ~13 tables, so this
  is reachable in not-that-many years of high write volume.

### F. DB migrations

(none in this bucket)

### H. Cross-PR awareness

- Bucket 03 (backend-lib) adds the SessionReplay sequencer block + CRUD
  bumps + a \`waitForSyncedSessionReplay\` test helper, but bucket 07
  (shared-packages) doesn't add a SessionReplay entry to
  \`db-sync-mappings.ts\` and bucket 03 doesn't add SessionReplay to
  \`clickhouse-migrations.ts\`. Half-state — either revert or finish.
\`\`\`

If a file has zero high-level issues, write \`- _(no findings)_\`.

## Hard rules

- Follow the project rules file.
- Never flag anything matching a Suppressed pattern.
- Don't invent issues to fill space — saying "no findings" is fine.
`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // CLI: split.ts <bundle.json> <outDir> [<worktreePath>]
  // worktreePath: absolute path to the git worktree being reviewed.
  // Without it, codex inherits the parent shell cwd and might read the
  // wrong branch's files.
  const bundlePath = process.argv[2] ?? '/tmp/ctx-v7-ne.json';
  const outDir = process.argv[3] ?? '/tmp/review-run';
  const worktreePath = process.argv[4] ?? '';

  const bundle: Bundle = JSON.parse(await readFile(bundlePath, 'utf8'));

  // Clean output directory
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await mkdir(join(outDir, 'buckets'), { recursive: true });
  await mkdir(join(outDir, 'prompts'), { recursive: true });
  await mkdir(join(outDir, 'outputs'), { recursive: true });

  // Assign files to buckets
  const assignments = new Map<string, FileEntry[]>();
  for (const f of bundle.files) {
    const b = bucketOf(f.path);
    const key = `${b.id}-${b.name}`;
    if (!assignments.has(key)) assignments.set(key, []);
    assignments.get(key)!.push(f);
  }

  // Emit overview + rules
  await writeFile(join(outDir, '00-overview.md'), emitOverview(bundle, assignments));
  await writeFile(join(outDir, 'rules-and-memory.md'), emitRulesAndMemory(bundle));

  // Emit pre-pass prelude (the input to the load-bearing-invariant codex call)
  await writeFile(join(outDir, 'prelude-context.md'), emitPreludeContext(bundle));

  // Build a worktree-cd preamble that gets injected at the top of every
  // prompt. Codex inherits the parent shell cwd, which is often wrong; the
  // preamble forces it to cd into the right tree before doing any reads.
  const cdHeader = worktreePath
    ? `## cwd setup (do this first, every time)

Before reading any file or running any \`rg\`/\`grep\`/\`sed\`/\`cat\`,
run:

\`\`\`bash
cd "${worktreePath}"
pwd
\`\`\`

Verify the \`pwd\` output matches \`${worktreePath}\`. ALL relative file
paths in your inputs and outputs are interpreted against THAT worktree.
If you find yourself reading files from a DIFFERENT worktree (especially
\`/Users/barreloflube/Desktop/stack-auth.nosync /4\`), STOP — you're in
the wrong cwd. cd back into \`${worktreePath}\` and retry.

Files in \`/tmp/review-run-*/\` are absolute and don't depend on cwd.

---

`
    : '';

  // Emit pass prompts
  await writeFile(join(outDir, 'prompts', 'prelude.md'), cdHeader + PROMPT_PRELUDE);
  await writeFile(join(outDir, 'prompts', 'callsite-audit.md'), cdHeader + PROMPT_CALLSITE_AUDIT);
  await writeFile(join(outDir, 'prompts', 'pass1+3.md'), cdHeader + PROMPT_P1P3);
  await writeFile(join(outDir, 'prompts', 'pass2.md'), cdHeader + PROMPT_P2);
  await writeFile(join(outDir, 'prompts', 'pass4.md'), cdHeader + PROMPT_P4);

  // Emit per-bucket per-pass files
  let bucketCount = 0;
  let fileCount = 0;
  for (const [key, files] of [...assignments.entries()].sort()) {
    const bucketId = key.split('-')[0]!;
    const bucket = BUCKETS.find((b) => b.id === bucketId);
    if (!bucket) continue;
    const bucketDir = join(outDir, 'buckets', key);
    await mkdir(bucketDir, { recursive: true });

    await writeFile(join(bucketDir, 'pass1+3.md'), emitBucketP1P3(bucket, files, bundle));
    await writeFile(join(bucketDir, 'pass2.md'), emitBucketP2(bucket, files, bundle));
    await writeFile(join(bucketDir, 'pass4.md'), emitBucketP4(bucket, files, bundle));
    bucketCount++;
    fileCount += files.length;
  }

  console.log(`[split] wrote ${bucketCount} buckets covering ${fileCount} files to ${outDir}`);
  console.log(`[split]   overview:    ${join(outDir, '00-overview.md')}`);
  console.log(`[split]   rules:       ${join(outDir, 'rules-and-memory.md')}`);
  console.log(`[split]   bucket dirs: ${join(outDir, 'buckets', '<id-name>')}`);
  console.log(`[split]   prompts:     ${join(outDir, 'prompts', 'pass[1+3|2|4].md')}`);
  console.log();
  console.log('To run a single codex review:');
  console.log('  cat /tmp/review-run/prompts/pass1+3.md /tmp/review-run/rules-and-memory.md \\');
  console.log('      /tmp/review-run/buckets/01-backend-metrics/pass1+3.md | codex ...');
}

main().catch((err: unknown) => {
  console.error((err as Error).stack ?? err);
  process.exit(1);
});
