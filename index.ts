#!/usr/bin/env bun
/**
 * review-context-builder (v3, TypeScript + Bun)
 *
 * Builds a structured JSON context bundle for an LLM code-review agent.
 *
 * Pipeline:
 *   1. Walk repo → list source files (JS/TS/TSX/JSX)
 *   2. Parse each file with Babel AST → exports, functions, classes, imports
 *   3. Resolve imports — relative + absolute + tsconfig path aliases
 *   4. Build forward (imports) and reverse (callers) graph
 *   5. Embed each file via Ollama, cached by content hash
 *   6. Multi-hop BFS in both directions for each changed file
 *   7. Cosine top-K semantic neighbors per changed file
 *   8. Merge in repo rules (CLAUDE.md, AGENTS.md) and
 *      global ~/.claude/skills/REVIEW_MEMORY.md
 *   9. Emit one JSON bundle for the downstream review agent
 *
 * Run:
 *   bun run /tmp/review-ctx/index.ts --base dev --scope apps/dashboard --out ctx.json
 *
 * Memory CRUD (doesn't run the pipeline):
 *   bun run /tmp/review-ctx/index.ts memory show
 *   bun run /tmp/review-ctx/index.ts memory rule "<text>"
 *   bun run /tmp/review-ctx/index.ts memory suppress "<text>"
 *   bun run /tmp/review-ctx/index.ts memory note "<text>"
 *   bun run /tmp/review-ctx/index.ts memory clear-cache
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative, dirname, join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

import * as parser from '@babel/parser';
import _traverse, { type NodePath } from '@babel/traverse';
import type {
  ImportDeclaration,
  ExportNamedDeclaration,
  ExportDefaultDeclaration,
  ExportAllDeclaration,
  CallExpression,
  FunctionDeclaration,
  ClassDeclaration,
  VariableDeclarator,
  Node as BabelNode,
} from '@babel/types';

// Babel traverse is CJS; handle the ESM/CJS default-export interop dance.
const traverse = (
  (_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse
) as typeof _traverse;

const execFileP = promisify(execFile);

// =============================================================================
// Types
// =============================================================================
type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
type ImportType = 'static' | 'cjs' | 'dynamic' | 'reexport' | 'reexport-all';

interface Args {
  subcommand: 'memory' | null;
  subargs: string[];
  base: string;
  root: string;
  scope: string | null;
  out: string | null;
  maxFileBytes: number;
  maxCallers: number;
  maxSiblings: number;
  maxHops: number;
  maxPerParent: number;
  maxNeighbors: number;
  includeContentForDeps: boolean;
  includeWorkspaces: boolean;
  embeddings: boolean;
  ollamaUrl: string;
  embeddingModel: string;
  embedMaxChars: number;
  embedBatchSize: number;
  memoryPath: string;
  cachePath: string;
  useMemory: boolean;
}

interface ChangedFile {
  status: FileStatus;
  path: string;
  prevPath: string | null;
}

interface SymbolSet {
  exports: string[];
  functions: string[];
  classes: string[];
}

interface RawImport {
  specifier: string;
  type: ImportType;
  namedSymbols: string[];
}

interface ForwardEdge {
  specifier: string;
  kind: 'internal' | 'external';
  type: ImportType;
  resolvedPath?: string;
  namedSymbols: string[];
}

interface ReverseEdge {
  path: string;
  importedSymbols: string[];
  type: ImportType;
}

interface HopNode {
  path: string;
  via: string;
  viaSymbols: string[];
  type: ImportType;
}

type OverlapLane = 'forward' | 'reverse';

interface SemanticNeighbor {
  path: string;
  score: number;
  /**
   * If the neighbor also appears in the graph-hop context (direct imports or
   * callers of this file, or their transitive hops), the lanes are listed
   * here. An empty array means the neighbor is pure embedding-only signal.
   * A non-empty array means the reviewer is seeing a hotspot: a file that is
   * BOTH in the dependency graph AND semantically closest — a strong hint of
   * code-clone, shared pattern, or tightly-coupled concern.
   */
  alsoIn: OverlapLane[];
}

interface FileContext {
  path: string;
  prevPath: string | null;
  status: FileStatus;
  additions: number;
  deletions: number;
  patch: string;
  fullContent: string;
  truncated: boolean;
  symbols: SymbolSet;
  directImports: ForwardEdge[];
  directCallers: ReverseEdge[];
  multiHop: { forwardTiers: HopNode[][]; reverseTiers: HopNode[][] };
  semanticNeighbors: SemanticNeighbor[];
  siblings: string[];
  otherChangedFiles: string[];
  dependencyContents?: Record<string, { content: string; truncated: boolean }>;
}

interface Bundle {
  meta: {
    repo: string;
    base: string;
    generatedAt: string;
    changedFileCount: number;
    indexedFileCount: number;
    graphEdgeCount: number;
    maxHops: number;
    embeddings:
      | { model: string; url: string; cacheHits: number; cacheMisses: number }
      | null;
    diffMode: string;
  };
  rules: Record<string, string>;
  memory: { path: string; content: string } | null;
  changedFiles: string[];
  files: FileContext[];
}

interface Tsconfig {
  baseUrl: string;
  paths: Record<string, string[]>;
  dir: string;
  path: string;
}

interface Workspace {
  name: string;   // e.g. "@stackframe/stack-shared"
  dir: string;    // relative to repo root, e.g. "packages/stack-shared"
}

interface EmbeddingCache {
  model: string | null;
  vectors: Record<string, number[]>;
}

interface EmbeddingResult {
  vectors: Map<string, number[]>;
  hits: number;
  misses: number;
  ok: boolean;
}

interface AstAnalysis {
  exports: string[];
  functions: string[];
  classes: string[];
  imports: RawImport[];
}

// =============================================================================
// Constants
// =============================================================================
const SOURCE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.next', '.turbo', 'coverage',
  '.cache', '.vercel', 'out', '.svelte-kit', 'target', '.parcel-cache',
  '.yarn', 'tmp', '.pnpm-store', '.idea', '.vscode',
]);

const RULE_FILES = [
  'CLAUDE.md', 'AGENTS.md', 'AGENT.md',
  '.cursorrules', '.windsurfrules',
  'greptile.json', '.greptile.json',
];

const HOME = homedir();
const CLAUDE_DIR = join(HOME, '.claude');
const DEFAULT_MEMORY_PATH = join(CLAUDE_DIR, 'skills', 'REVIEW_MEMORY.md');
const DEFAULT_CACHE_DIR = join(CLAUDE_DIR, 'review-ctx');
const DEFAULT_EMBEDDING_CACHE = join(DEFAULT_CACHE_DIR, 'embeddings.json');

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_HOST || 'http://localhost:11434';
const DEFAULT_EMBEDDING_MODEL = 'embeddinggemma:latest';

const MEMORY_TEMPLATE = `# Review Memory

Persistent preferences for the code-review agent. The context builder reads
this file on every run and includes it in the review bundle. Edit freely.

Use the CLI to append entries:
  bun run index.ts memory rule "<text>"
  bun run index.ts memory suppress "<text>"
  bun run index.ts memory note "<text>"

## Rules
<!-- Things the reviewer SHOULD do or check -->

## Suppressed patterns
<!-- Things the reviewer should NOT comment on -->

## Notes
<!-- Free-form context, jargon, conventions, project-wide gotchas -->
`;

// =============================================================================
// CLI
// =============================================================================
const HELP = `review-ctx — build LLM context for a code-review agent

Usage:
  bun run index.ts [build options]
  bun run index.ts memory <show|rule|suppress|note|clear-cache> [text]

Build options:
  --base <ref>                  Base git ref to diff against (default: dev)
  --root <dir>                  Repo root (default: cwd)
  --scope <dir>                 Only index files under this dir (relative to root)
  --out <file>                  Write JSON to file (default: stdout)
  --max-file-bytes <n>          Cap each file body at N bytes (default: 60000)
  --max-callers <n>             Cap callers per hop tier (default: 15)
  --max-siblings <n>            Cap siblings shown per file (default: 20)
  --max-hops <n>                Maximum graph hops (default: 2)
  --max-per-parent <n>          Cap descendants contributed per parent at each hop (default: 6)
  --max-neighbors <n>           Top-K semantic neighbors per file (default: 8)
  --include-content-for-deps    Inline source of direct internal deps
  --no-workspaces               Don't auto-walk pnpm/yarn workspace packages

Embedding options:
  --no-embeddings               Skip semantic neighbors
  --ollama-url <url>            Ollama base URL (default: $OLLAMA_HOST or http://localhost:11434)
  --embedding-model <name>      Ollama embedding model (default: ${DEFAULT_EMBEDDING_MODEL})
  --embed-max-chars <n>         Max chars per file sent to embedder (default: 5000)
  --embed-batch-size <n>        Inputs per /api/embed call (default: 16)

Memory / cache:
  --memory-path <path>          Override REVIEW_MEMORY.md location
                                (default: ${DEFAULT_MEMORY_PATH})
  --cache-path <path>           Override embeddings cache location
                                (default: ${DEFAULT_EMBEDDING_CACHE})
  --no-memory                   Don't read or include REVIEW_MEMORY.md

  -h, --help                    Show this help

Memory subcommands:
  memory show                   Print REVIEW_MEMORY.md
  memory rule <text>            Append a rule
  memory suppress <text>        Append a suppression pattern
  memory note <text>            Append a free-form note
  memory clear-cache            Wipe the embeddings cache
`;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    subcommand: null,
    subargs: [],
    base: 'dev',
    root: process.cwd(),
    scope: null,
    out: null,
    maxFileBytes: 60_000,
    maxCallers: 15,
    maxSiblings: 20,
    maxHops: 2,
    maxPerParent: 6,
    maxNeighbors: 8,
    includeContentForDeps: false,
    includeWorkspaces: true,
    embeddings: true,
    ollamaUrl: DEFAULT_OLLAMA_URL,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    embedMaxChars: 5000,
    embedBatchSize: 16,
    memoryPath: DEFAULT_MEMORY_PATH,
    cachePath: DEFAULT_EMBEDDING_CACHE,
    useMemory: true,
  };

  if (argv[0] === 'memory') {
    args.subcommand = 'memory';
    args.subargs = argv.slice(1);
    // pull out --memory-path / --cache-path even in subcommand mode
    for (let i = 0; i < args.subargs.length; i++) {
      const a = args.subargs[i];
      if (a === '--memory-path') {
        args.memoryPath = args.subargs[++i]!;
        args.subargs.splice(i - 1, 2);
        i -= 2;
      } else if (a === '--cache-path') {
        args.cachePath = args.subargs[++i]!;
        args.subargs.splice(i - 1, 2);
        i -= 2;
      }
    }
    return args;
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--base': args.base = argv[++i]!; break;
      case '--root': args.root = resolve(argv[++i]!); break;
      case '--scope': args.scope = argv[++i]!; break;
      case '--out':  args.out = argv[++i]!; break;
      case '--max-file-bytes': args.maxFileBytes = parseInt(argv[++i]!, 10); break;
      case '--max-callers':    args.maxCallers   = parseInt(argv[++i]!, 10); break;
      case '--max-siblings':   args.maxSiblings  = parseInt(argv[++i]!, 10); break;
      case '--max-hops':       args.maxHops      = parseInt(argv[++i]!, 10); break;
      case '--max-per-parent': args.maxPerParent = parseInt(argv[++i]!, 10); break;
      case '--max-neighbors':  args.maxNeighbors = parseInt(argv[++i]!, 10); break;
      case '--include-content-for-deps': args.includeContentForDeps = true; break;
      case '--no-workspaces': args.includeWorkspaces = false; break;
      case '--no-embeddings':  args.embeddings = false; break;
      case '--ollama-url':     args.ollamaUrl = argv[++i]!; break;
      case '--embedding-model': args.embeddingModel = argv[++i]!; break;
      case '--embed-max-chars': args.embedMaxChars = parseInt(argv[++i]!, 10); break;
      case '--embed-batch-size': args.embedBatchSize = parseInt(argv[++i]!, 10); break;
      case '--memory-path':    args.memoryPath = argv[++i]!; break;
      case '--cache-path':     args.cachePath = argv[++i]!; break;
      case '--no-memory':      args.useMemory = false; break;
      case '-h':
      case '--help':
        process.stdout.write(HELP);
        process.exit(0);
      default:
        if (a && a.startsWith('--')) {
          process.stderr.write(`unknown option: ${a}\n`);
          process.exit(2);
        }
    }
  }
  return args;
}

function log(...parts: unknown[]): void {
  process.stderr.write('[ctx] ' + parts.join(' ') + '\n');
}

// =============================================================================
// Memory file (~/.claude/skills/REVIEW_MEMORY.md)
// =============================================================================
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function ensureMemoryFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, MEMORY_TEMPLATE);
  log('created memory file:', path);
}

async function readMemory(path: string): Promise<string> {
  await ensureMemoryFile(path);
  return await readFile(path, 'utf8');
}

async function appendToSection(
  path: string,
  section: string,
  text: string,
): Promise<void> {
  await ensureMemoryFile(path);
  let content = await readFile(path, 'utf8');

  const headerRe = new RegExp(`^##\\s+${escapeRe(section)}\\s*\\r?\\n`, 'm');
  const headerMatch = content.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) {
    if (!content.endsWith('\n')) content += '\n';
    content += `\n## ${section}\n\n- ${text}\n`;
    await writeFile(path, content);
    return;
  }

  const headerEnd = headerMatch.index + headerMatch[0].length;
  const rest = content.slice(headerEnd);
  const nextHeaderMatch = rest.match(/^##\s+/m);
  const sectionEnd =
    nextHeaderMatch && nextHeaderMatch.index !== undefined
      ? headerEnd + nextHeaderMatch.index
      : content.length;

  let body = content.slice(headerEnd, sectionEnd);
  body = body.replace(/\n+$/, '\n');
  if (body.trim() === '') body = '\n';
  if (!body.endsWith('\n')) body += '\n';
  body += `- ${text}\n`;
  if (nextHeaderMatch) body += '\n';

  content = content.slice(0, headerEnd) + body + content.slice(sectionEnd);
  await writeFile(path, content);
}

async function handleMemorySubcommand(args: Args): Promise<void> {
  const [op, ...rest] = args.subargs;
  const text = rest.join(' ').trim();
  switch (op) {
    case 'show':
      process.stdout.write(await readMemory(args.memoryPath));
      return;
    case 'rule':
      if (!text) { process.stderr.write('usage: memory rule <text>\n'); process.exit(2); }
      await appendToSection(args.memoryPath, 'Rules', text);
      log('added rule to', args.memoryPath);
      return;
    case 'suppress':
      if (!text) { process.stderr.write('usage: memory suppress <text>\n'); process.exit(2); }
      await appendToSection(args.memoryPath, 'Suppressed patterns', text);
      log('added suppression to', args.memoryPath);
      return;
    case 'note':
      if (!text) { process.stderr.write('usage: memory note <text>\n'); process.exit(2); }
      await appendToSection(args.memoryPath, 'Notes', text);
      log('added note to', args.memoryPath);
      return;
    case 'clear-cache':
      try {
        await rm(args.cachePath, { force: true });
        log('cleared cache:', args.cachePath);
      } catch (e) {
        log('cache clear failed:', (e as Error).message);
      }
      return;
    default:
      process.stderr.write(
        'memory subcommands: show | rule | suppress | note | clear-cache\n',
      );
      process.exit(2);
  }
}

// =============================================================================
// Git
// =============================================================================
async function git(cwd: string, ...a: string[]): Promise<string> {
  const { stdout } = await execFileP('git', a, {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

async function gitSafe(cwd: string, ...a: string[]): Promise<string> {
  try { return await git(cwd, ...a); } catch { return ''; }
}

async function verifyRef(cwd: string, ref: string): Promise<boolean> {
  try { await git(cwd, 'rev-parse', '--verify', ref); return true; }
  catch { return false; }
}

async function getRepoName(root: string): Promise<string> {
  try {
    const url = (await git(root, 'config', '--get', 'remote.origin.url')).trim();
    const m = url.match(/[/:]([^/:]+\/[^/:]+?)(?:\.git)?$/);
    if (m && m[1]) return m[1];
  } catch {}
  return basename(root);
}

async function getChangedFiles(root: string, base: string): Promise<ChangedFile[]> {
  const out = (await gitSafe(
    root, 'diff', '--name-status', '--find-renames', base,
  )).trim();
  if (!out) return [];
  const STATUS: Record<string, FileStatus> = {
    A: 'added', M: 'modified', D: 'deleted', T: 'modified', C: 'copied',
  };
  return out.split('\n').map((line): ChangedFile => {
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    if (code.startsWith('R')) {
      return { status: 'renamed', path: parts[2]!, prevPath: parts[1]! };
    }
    return { status: STATUS[code[0]!] || 'modified', path: parts[1]!, prevPath: null };
  });
}

async function getPatch(root: string, base: string, file: string): Promise<string> {
  return await gitSafe(root, 'diff', '--unified=3', base, '--', file);
}

async function getNumstat(
  root: string,
  base: string,
  file: string,
): Promise<{ additions: number; deletions: number }> {
  const out = (await gitSafe(root, 'diff', '--numstat', base, '--', file)).trim();
  if (!out) return { additions: 0, deletions: 0 };
  const [add, del] = out.split('\t');
  return {
    additions: parseInt(add || '0', 10) || 0,
    deletions: parseInt(del || '0', 10) || 0,
  };
}

// =============================================================================
// Walk
// =============================================================================
function isSourceFile(name: string): boolean {
  if (!SOURCE_EXTS.has(extname(name))) return false;
  // .d.ts are type-only ambient declarations. Parsing them adds noise to
  // the graph (every type-only import becomes an edge) without any value
  // for a review agent. The changed-file union will still pick them up if
  // they're in the diff.
  if (name.endsWith('.d.ts') || name.endsWith('.d.mts') || name.endsWith('.d.cts')) {
    return false;
  }
  return true;
}

async function walkSourceFiles(
  root: string,
  scope: string | null,
): Promise<string[]> {
  const out: string[] = [];
  const startDir = scope ? resolve(root, scope) : root;
  async function go(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await go(full);
      else if (e.isFile() && isSourceFile(e.name)) {
        out.push(relative(root, full));
      }
    }
  }
  await go(startDir);
  return out;
}

// =============================================================================
// AST parse (Babel)
// =============================================================================
const PARSE_PLUGINS_BASE = [
  'jsx',
  'decorators-legacy',
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'optionalChaining',
  'nullishCoalescingOperator',
  'topLevelAwait',
  'importAssertions',
  'importAttributes',
  'explicitResourceManagement',
] as const;

function parseFile(src: string, filename: string): BabelNode | null {
  const isTs = /\.tsx?$/.test(filename);
  const plugins = [...PARSE_PLUGINS_BASE] as parser.ParserPlugin[];
  if (isTs) plugins.push('typescript');
  try {
    return parser.parse(src, {
      sourceType: 'module',
      errorRecovery: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowUndeclaredExports: true,
      plugins,
    });
  } catch {
    try {
      return parser.parse(src, {
        sourceType: 'unambiguous',
        errorRecovery: true,
        plugins,
      });
    } catch { return null; }
  }
}

function nameOfId(node: BabelNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  return null;
}

function analyzeAst(ast: BabelNode | null): AstAnalysis {
  const empty: AstAnalysis = { exports: [], functions: [], classes: [], imports: [] };
  if (!ast) return empty;

  const exports = new Set<string>();
  const functions = new Set<string>();
  const classes = new Set<string>();
  const imports: RawImport[] = [];

  traverse(ast, {
    ImportDeclaration(p: NodePath<ImportDeclaration>) {
      const spec = p.node.source.value;
      const named: string[] = [];
      for (const s of p.node.specifiers) {
        if (s.type === 'ImportDefaultSpecifier') named.push(s.local.name);
        else if (s.type === 'ImportNamespaceSpecifier') named.push(`* as ${s.local.name}`);
        else if (s.type === 'ImportSpecifier') {
          named.push(nameOfId(s.imported) ?? s.local.name);
        }
      }
      imports.push({ specifier: spec, type: 'static', namedSymbols: named });
    },

    ExportNamedDeclaration(p: NodePath<ExportNamedDeclaration>) {
      if (p.node.source) {
        const named: string[] = [];
        for (const s of p.node.specifiers || []) {
          if (s.type === 'ExportSpecifier') {
            const n = nameOfId(s.exported);
            if (n) named.push(n);
          }
        }
        imports.push({
          specifier: p.node.source.value,
          type: 'reexport',
          namedSymbols: named,
        });
        for (const n of named) exports.add(n);
        return;
      }
      const d = p.node.declaration;
      if (d) {
        if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) {
          exports.add(d.id.name);
          if (d.type === 'FunctionDeclaration') functions.add(d.id.name);
          else classes.add(d.id.name);
        } else if (d.type === 'VariableDeclaration') {
          for (const decl of d.declarations) {
            if (decl.id.type === 'Identifier') {
              exports.add(decl.id.name);
              const init = decl.init;
              if (init && (
                init.type === 'ArrowFunctionExpression' ||
                init.type === 'FunctionExpression'
              )) {
                functions.add(decl.id.name);
              }
            }
          }
        } else if (
          'id' in d && d.id && (
            d.type === 'TSInterfaceDeclaration' ||
            d.type === 'TSTypeAliasDeclaration' ||
            d.type === 'TSEnumDeclaration' ||
            d.type === 'TSModuleDeclaration'
          )
        ) {
          if (d.id.type === 'Identifier') exports.add(d.id.name);
        }
      }
      for (const s of p.node.specifiers || []) {
        if (s.type === 'ExportSpecifier') {
          const n = nameOfId(s.exported);
          if (n) exports.add(n);
        }
      }
    },

    ExportDefaultDeclaration(p: NodePath<ExportDefaultDeclaration>) {
      exports.add('default');
      const d = p.node.declaration;
      if (d?.type === 'FunctionDeclaration' && d.id) functions.add(d.id.name);
      else if (d?.type === 'ClassDeclaration' && d.id) classes.add(d.id.name);
    },

    ExportAllDeclaration(p: NodePath<ExportAllDeclaration>) {
      imports.push({
        specifier: p.node.source.value,
        type: 'reexport-all',
        namedSymbols: [],
      });
    },

    CallExpression(p: NodePath<CallExpression>) {
      const callee = p.node.callee;
      // CJS require("x")
      if (callee.type === 'Identifier' && callee.name === 'require') {
        const arg = p.node.arguments[0];
        if (arg && arg.type === 'StringLiteral') {
          imports.push({ specifier: arg.value, type: 'cjs', namedSymbols: [] });
        }
      }
      // dynamic import("x")
      if (callee.type === 'Import') {
        const arg = p.node.arguments[0];
        if (arg && arg.type === 'StringLiteral') {
          imports.push({ specifier: arg.value, type: 'dynamic', namedSymbols: [] });
        }
      }
    },

    FunctionDeclaration(p: NodePath<FunctionDeclaration>) {
      if (p.parent.type === 'Program' && p.node.id) functions.add(p.node.id.name);
    },

    ClassDeclaration(p: NodePath<ClassDeclaration>) {
      if (p.parent.type === 'Program' && p.node.id) classes.add(p.node.id.name);
    },

    VariableDeclarator(p: NodePath<VariableDeclarator>) {
      const grand = p.parentPath?.parentPath;
      if (grand?.node?.type !== 'Program') return;
      if (p.node.id.type !== 'Identifier') return;
      const init = p.node.init;
      if (init && (
        init.type === 'ArrowFunctionExpression' ||
        init.type === 'FunctionExpression'
      )) {
        functions.add(p.node.id.name);
      }
    },
  });

  return {
    exports: [...exports],
    functions: [...functions],
    classes: [...classes],
    imports,
  };
}

// =============================================================================
// tsconfig path-alias resolution
// =============================================================================
const tsconfigCache = new Map<string, Tsconfig | null>();
const tsconfigFileCache = new Map<string, Record<string, unknown> | null>();

function stripJsonComments(src: string): string {
  // Walk char-by-char so we don't strip "/*", "*/", or "//" that appear
  // inside JSON string literals (e.g. "@/*", "**/*.ts").
  let out = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) { out += next; i += 2; continue; }
      if (ch === stringChar) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      out += ch;
      i++;
      continue;
    }
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
  // Strip trailing commas (outside-string positions only approximated by regex)
  return out.replace(/,(\s*[}\]])/g, '$1');
}

async function readJsonRelaxed(
  path: string,
): Promise<Record<string, unknown> | null> {
  if (tsconfigFileCache.has(path)) return tsconfigFileCache.get(path)!;
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
    tsconfigFileCache.set(path, parsed);
    return parsed;
  } catch {
    tsconfigFileCache.set(path, null);
    return null;
  }
}

/**
 * Load and resolve a tsconfig, recursively following `extends` up to
 * MAX_EXTENDS_DEPTH levels with cycle detection.
 *
 * Inheritance rule: own `baseUrl`/`paths` win. If either is unset, the first
 * ancestor that defines it contributes the value AND its own directory as
 * the `dir` field — since baseUrl/paths are always resolved relative to the
 * tsconfig that defined them, not the leaf.
 */
const MAX_EXTENDS_DEPTH = 8;

async function loadTsconfig(
  tsconfigPath: string,
  seen: Set<string> = new Set(),
): Promise<Tsconfig | null> {
  if (seen.has(tsconfigPath)) return null;
  if (seen.size >= MAX_EXTENDS_DEPTH) return null;
  seen.add(tsconfigPath);

  const json = await readJsonRelaxed(tsconfigPath);
  if (!json) return null;
  const co = (json.compilerOptions as Record<string, unknown> | undefined) ?? {};

  let baseUrl = co.baseUrl as string | undefined;
  let paths = co.paths as Record<string, string[]> | undefined;
  let dir = dirname(tsconfigPath);

  if (json.extends && (baseUrl === undefined || paths === undefined)) {
    const extendsList = Array.isArray(json.extends)
      ? (json.extends as string[])
      : [json.extends as string];
    for (const ext of extendsList) {
      if (typeof ext !== 'string') continue;
      // Only relative paths — bare specifiers (e.g. "@tsconfig/strictest")
      // live in node_modules, which we don't traverse. Skip gracefully.
      if (!ext.startsWith('.')) continue;
      let parentPath = resolve(dirname(tsconfigPath), ext);
      if (!parentPath.endsWith('.json')) parentPath += '.json';
      if (!existsSync(parentPath)) continue;
      const parent = await loadTsconfig(parentPath, seen);
      if (!parent) continue;
      if (baseUrl === undefined && parent.baseUrl) {
        baseUrl = parent.baseUrl;
        dir = parent.dir;
      }
      if (paths === undefined && Object.keys(parent.paths).length > 0) {
        paths = parent.paths;
        dir = parent.dir;
      }
      if (baseUrl !== undefined && paths !== undefined) break;
    }
  }
  return {
    baseUrl: baseUrl || '.',
    paths: paths || {},
    dir,
    path: tsconfigPath,
  };
}

async function getTsconfigForFile(
  filePath: string,
  root: string,
): Promise<Tsconfig | null> {
  let dir = dirname(resolve(root, filePath));
  while (true) {
    if (tsconfigCache.has(dir)) return tsconfigCache.get(dir)!;
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) {
      const cfg = await loadTsconfig(candidate);
      tsconfigCache.set(dir, cfg);
      return cfg;
    }
    if (dir === root || dir === dirname(dir)) {
      tsconfigCache.set(dir, null);
      return null;
    }
    dir = dirname(dir);
  }
}

function tryResolveAlias(specifier: string, tsconfig: Tsconfig | null): string[] {
  if (!tsconfig) return [];
  const out: string[] = [];
  const baseDir = resolve(tsconfig.dir, tsconfig.baseUrl);
  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1); // "@/"
      if (specifier.startsWith(prefix)) {
        const tail = specifier.slice(prefix.length);
        for (const target of targets) {
          const targetTail = target.endsWith('/*') ? target.slice(0, -1) : target;
          out.push(join(baseDir, targetTail + tail));
        }
      }
    } else if (specifier === pattern) {
      for (const target of targets) {
        out.push(join(baseDir, target));
      }
    }
  }
  return out;
}

// =============================================================================
// Workspace packages (pnpm-workspace.yaml / package.json workspaces)
// =============================================================================
/**
 * Parse a minimal subset of pnpm-workspace.yaml — just the `packages:` list.
 * Avoids a YAML dep by only handling the exact shape used in practice.
 */
function parseWorkspaceYaml(src: string): string[] {
  const out: string[] = [];
  const lines = src.split(/\r?\n/);
  let inPackages = false;
  for (const raw of lines) {
    if (/^packages\s*:/.test(raw)) { inPackages = true; continue; }
    if (!inPackages) continue;
    // Exit the block on a new top-level key
    if (/^\S/.test(raw) && !raw.startsWith('-')) break;
    const m = raw.match(/^\s*-\s*['"]?([^'"\s#][^'"#]*?)['"]?\s*(?:#.*)?$/);
    if (m && m[1]) out.push(m[1].trim());
  }
  return out;
}

async function loadWorkspaces(root: string): Promise<Workspace[]> {
  // 1. Collect glob patterns
  let globs: string[] = [];
  const pnpmFile = join(root, 'pnpm-workspace.yaml');
  if (existsSync(pnpmFile)) {
    try { globs = parseWorkspaceYaml(await readFile(pnpmFile, 'utf8')); } catch {}
  }
  if (globs.length === 0) {
    const rootPkg = join(root, 'package.json');
    if (existsSync(rootPkg)) {
      try {
        const json = JSON.parse(await readFile(rootPkg, 'utf8')) as {
          workspaces?: string[] | { packages?: string[] };
        };
        if (Array.isArray(json.workspaces)) globs = json.workspaces;
        else if (json.workspaces?.packages) globs = json.workspaces.packages;
      } catch {}
    }
  }
  if (globs.length === 0) return [];

  // 2. Expand globs (only handle trailing /* and literal paths — plenty for
  //    pnpm workspaces in practice).
  const candidates: string[] = [];
  for (const g of globs) {
    if (g.endsWith('/*')) {
      const parent = g.slice(0, -2);
      const parentAbs = join(root, parent);
      if (!existsSync(parentAbs)) continue;
      try {
        const entries = await readdir(parentAbs, { withFileTypes: true });
        for (const e of entries) {
          if (e.isDirectory()) candidates.push(join(parent, e.name));
        }
      } catch {}
    } else if (g.includes('*')) {
      // Skip more complex globs — not used by the repos we care about.
      continue;
    } else {
      if (existsSync(join(root, g))) candidates.push(g);
    }
  }

  // 3. Read each package.json, keep ones with a name
  const out: Workspace[] = [];
  for (const dir of candidates) {
    const pkgJsonPath = join(root, dir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const json = JSON.parse(await readFile(pkgJsonPath, 'utf8')) as {
        name?: string;
      };
      if (json.name) out.push({ name: json.name, dir });
    } catch {}
  }
  return out;
}

/**
 * Resolve a bare specifier against the workspace package map.
 * Convention: prefer `<pkgDir>/src/...` (the edited source) over the
 * package.json `main` (usually a compiled `dist/` path we don't want to
 * point the reviewer at).
 */
function resolveWorkspaceImport(
  specifier: string,
  workspaces: Workspace[],
  root: string,
  fileSet: Set<string>,
): string | null {
  for (const ws of workspaces) {
    const name = ws.name;
    if (specifier === name) {
      // Bare package import — try src/index.* then <pkgDir>/index.*
      const candidates = [
        join(root, ws.dir, 'src'),
        join(root, ws.dir, 'src', 'index'),
        join(root, ws.dir),
        join(root, ws.dir, 'index'),
      ];
      for (const c of candidates) {
        const r = tryFile(c, root, fileSet);
        if (r) return r;
      }
      continue;
    }
    if (specifier.startsWith(name + '/')) {
      const sub = specifier.slice(name.length + 1);
      // Some consumers still write the legacy `@pkg/dist/foo` import style.
      // Rewrite it to the source path so the reviewer sees the real `.ts`
      // file instead of the compiled `.js` output.
      const subAlt = sub.startsWith('dist/') ? 'src/' + sub.slice(5) : null;
      const candidates: string[] = [];
      // Prefer source-tree paths (walked, parsed, in the graph)
      candidates.push(join(root, ws.dir, 'src', sub));
      if (subAlt) candidates.push(join(root, ws.dir, subAlt));
      // Then the package root (for packages without a src/ convention)
      candidates.push(join(root, ws.dir, sub));
      for (const c of candidates) {
        const r = tryFile(c, root, fileSet);
        if (r) return r;
      }
    }
  }
  return null;
}

// =============================================================================
// Module resolver
// =============================================================================
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_FILES = [
  'index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs',
];

const ASSET_EXTS = [
  '.json', '.css', '.scss', '.sass', '.less', '.svg', '.png', '.jpg', '.jpeg',
  '.gif', '.webp', '.avif', '.ico', '.md', '.mdx', '.yaml', '.yml', '.txt',
  '.wasm', '.html',
];

// TypeScript bundler-style resolution: a `.ts` file can `import "./foo.js"`
// and have it resolve to `foo.ts`. Standard in `moduleResolution: nodenext`
// and `bundler`. Map each JS-ish extension to its TS equivalents so the
// resolver can find the actual source file.
const JS_TO_TS_REWRITE: Array<{ from: string; to: string[] }> = [
  { from: '.js',  to: ['.ts', '.tsx'] },
  { from: '.mjs', to: ['.mts'] },
  { from: '.cjs', to: ['.cts'] },
  { from: '.jsx', to: ['.tsx'] },
];

function tryFile(
  absPath: string,
  root: string,
  fileSet: Set<string>,
): string | null {
  // 0. .js → .ts rewriting (TypeScript bundler convention)
  for (const { from, to } of JS_TO_TS_REWRITE) {
    if (absPath.endsWith(from)) {
      const stem = absPath.slice(0, -from.length);
      for (const ext of to) {
        const p = stem + ext;
        const rel = relative(root, p);
        if (fileSet.has(rel)) return rel;
        if (existsSync(p)) return rel;
      }
    }
  }
  // 1. In-memory source index (fast path, only hits indexed/walked files)
  for (const ext of RESOLVE_EXTS) {
    const rel = relative(root, absPath + ext);
    if (fileSet.has(rel)) return rel;
  }
  for (const idx of INDEX_FILES) {
    const rel = relative(root, join(absPath, idx));
    if (fileSet.has(rel)) return rel;
  }
  // 2. Filesystem fallback for SOURCE files outside the walked scope. The
  //    target won't have symbols/imports parsed, but the edge is still
  //    correctly classified as internal so the review agent knows the
  //    dependency exists on-repo, not in node_modules.
  for (const ext of RESOLVE_EXTS) {
    if (ext === '') continue;
    if (existsSync(absPath + ext)) return relative(root, absPath + ext);
  }
  for (const idx of INDEX_FILES) {
    const p = join(absPath, idx);
    if (existsSync(p)) return relative(root, p);
  }
  // 3. Filesystem fallback for non-source assets (json, css, svg, …)
  for (const ext of ASSET_EXTS) {
    if (existsSync(absPath + ext)) {
      return relative(root, absPath + ext);
    }
  }
  if (existsSync(absPath)) {
    return relative(root, absPath);
  }
  return null;
}

async function resolveImport(
  specifier: string,
  fromFile: string,
  root: string,
  fileSet: Set<string>,
  workspaces: Workspace[],
): Promise<string | null> {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const baseDir = dirname(resolve(root, fromFile));
    const candidate = resolve(baseDir, specifier);
    return tryFile(candidate, root, fileSet);
  }
  // tsconfig path aliases
  const tsconfig = await getTsconfigForFile(fromFile, root);
  for (const aliased of tryResolveAlias(specifier, tsconfig)) {
    const r = tryFile(aliased, root, fileSet);
    if (r) return r;
  }
  // Workspace packages
  if (workspaces.length > 0) {
    const r = resolveWorkspaceImport(specifier, workspaces, root, fileSet);
    if (r) return r;
  }
  return null;
}

// =============================================================================
// Embeddings (Ollama, content-addressed cache)
// =============================================================================
function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function loadEmbeddingCache(cachePath: string): Promise<EmbeddingCache> {
  try {
    const raw = await readFile(cachePath, 'utf8');
    const j = JSON.parse(raw) as Partial<EmbeddingCache>;
    return { model: j.model ?? null, vectors: j.vectors ?? {} };
  } catch { return { model: null, vectors: {} }; }
}

async function saveEmbeddingCache(
  cachePath: string,
  cache: EmbeddingCache,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache));
}

async function ollamaEmbedBatch(
  texts: string[],
  model: string,
  baseUrl: string,
): Promise<number[][]> {
  const r = await fetch(`${baseUrl}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`ollama ${r.status}: ${t.slice(0, 200)}`);
  }
  const j = (await r.json()) as { embeddings?: number[][] };
  if (!Array.isArray(j.embeddings)) throw new Error('ollama returned no embeddings');
  return j.embeddings;
}

interface PendingItem {
  file: string;
  key: string;
  text: string;
}

async function embedAllFiles(opts: {
  files: string[];
  contents: Map<string, string>;
  model: string;
  baseUrl: string;
  cachePath: string;
  embedMaxChars: number;
  batchSize: number;
}): Promise<EmbeddingResult> {
  const cache = await loadEmbeddingCache(opts.cachePath);
  if (cache.model && cache.model !== opts.model) {
    log(`embedding model changed (${cache.model} → ${opts.model}); resetting cache`);
    cache.vectors = {};
  }
  cache.model = opts.model;

  const vectors = new Map<string, number[]>();
  let hits = 0;
  let misses = 0;
  let failures = 0;

  // Probe (also warms the model so subsequent batches are fast)
  try {
    await ollamaEmbedBatch(['probe'], opts.model, opts.baseUrl);
  } catch (e) {
    log('ollama unreachable:', (e as Error).message);
    log('continuing without embeddings');
    return { vectors, hits: 0, misses: 0, ok: false };
  }

  // Build the list of items that actually need embedding. Key + embed input
  // are content-only (model + snippet) so that:
  //   - renaming a file doesn't invalidate its vector
  //   - two files with identical content share a single vector
  //   - cache is location-independent across branches/worktrees
  const pending: PendingItem[] = [];
  for (const file of opts.files) {
    const content = opts.contents.get(file);
    if (!content) continue;
    const snippet = content.slice(0, opts.embedMaxChars);
    const text = snippet;
    const key = sha256(`${opts.model}\0${snippet}`);
    const cached = cache.vectors[key];
    if (cached) { vectors.set(file, cached); hits++; continue; }
    pending.push({ file, key, text });
  }
  log(`embedding: ${hits} cached, ${pending.length} to compute`);

  // Helper: embed a single item with a shrinking-snippet fallback for
  // context-length errors. Returns null on give-up.
  async function embedOne(item: PendingItem): Promise<number[] | null> {
    let text = item.text;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const [vec] = await ollamaEmbedBatch([text], opts.model, opts.baseUrl);
        return vec ?? null;
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('context length') || msg.includes('context_length')) {
          text = text.slice(0, Math.floor(text.length / 2));
          if (text.length < 256) return null;
          continue;
        }
        throw e;
      }
    }
    return null;
  }

  const t0 = Date.now();
  for (let start = 0; start < pending.length; start += opts.batchSize) {
    const batch = pending.slice(start, start + opts.batchSize);
    try {
      const vecs = await ollamaEmbedBatch(
        batch.map((b) => b.text), opts.model, opts.baseUrl,
      );
      if (vecs.length !== batch.length) throw new Error('batch length mismatch');
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i]!;
        const vec = vecs[i]!;
        cache.vectors[item.key] = vec;
        vectors.set(item.file, vec);
        misses++;
      }
    } catch (e) {
      const msg = (e as Error).message;
      // Batch failed — retry each item individually with the shrinking fallback
      if (!msg.includes('context length') && !msg.includes('context_length')) {
        log(`batch at ${start} failed: ${msg} — retrying individually`);
      }
      for (const item of batch) {
        const v = await embedOne(item).catch(() => null);
        if (v) {
          cache.vectors[item.key] = v;
          vectors.set(item.file, v);
          misses++;
        } else {
          failures++;
          if (failures <= 3) log(`embed skipped: ${item.file}`);
        }
      }
    }

    const done = start + batch.length;
    const rate = done / ((Date.now() - t0) / 1000);
    if (start % (opts.batchSize * 4) === 0 || done === pending.length) {
      log(`embedded ${done}/${pending.length} (${rate.toFixed(1)}/s)`);
      await saveEmbeddingCache(opts.cachePath, cache);
    }
  }

  await saveEmbeddingCache(opts.cachePath, cache);
  log(`embeddings done — cache hits: ${hits}, new: ${misses}, failures: ${failures}`);
  return { vectors, hits, misses, ok: true };
}

function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function topKNeighbors(
  targetVec: number[],
  vectors: Map<string, number[]>,
  exclude: Set<string>,
  k: number,
  forwardSet: Set<string>,
  reverseSet: Set<string>,
): SemanticNeighbor[] {
  const scores: SemanticNeighbor[] = [];
  for (const [file, vec] of vectors) {
    if (exclude.has(file)) continue;
    const s = cosine(targetVec, vec);
    if (s <= 0) continue;
    const alsoIn: OverlapLane[] = [];
    if (forwardSet.has(file)) alsoIn.push('forward');
    if (reverseSet.has(file)) alsoIn.push('reverse');
    scores.push({ path: file, score: +s.toFixed(4), alsoIn });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, k);
}

// =============================================================================
// Multi-hop graph traversal (BFS forward + reverse)
// =============================================================================
function traverseGraph(opts: {
  start: string;
  forwardGraph: Map<string, ForwardEdge[]>;
  reverseGraph: Map<string, ReverseEdge[]>;
  maxHops: number;
  perTierCap: number;       // hard cap on total tier size (safety net)
  perParentCap: number;     // cap on descendants contributed per parent
}): { forwardTiers: HopNode[][]; reverseTiers: HopNode[][] } {
  // BFS in both directions. Two caps:
  //   - perParentCap: so a single barrel file (e.g. components/ui/index.tsx
  //     with 50 re-exports) can't monopolize a tier while its hop-1 siblings
  //     get 0 descendants.
  //   - perTierCap: safety net on total tier size (mostly matters when there
  //     are many hop-1 parents with dense fan-out).
  // The stored tier IS the next-hop frontier, so hop-(n+1).via always
  // references a node that's present in hop-n.
  const fwdTiers: HopNode[][] = [];
  const revTiers: HopNode[][] = [];

  // forward (imports of imports of ...)
  {
    const visited = new Set<string>([opts.start]);
    let frontierPaths: string[] = [opts.start];
    for (let hop = 1; hop <= opts.maxHops; hop++) {
      const tier: HopNode[] = [];
      for (const node of frontierPaths) {
        let contributed = 0;
        for (const e of opts.forwardGraph.get(node) ?? []) {
          if (e.kind !== 'internal' || !e.resolvedPath) continue;
          if (visited.has(e.resolvedPath)) continue;
          if (contributed >= opts.perParentCap) break;
          visited.add(e.resolvedPath);
          tier.push({
            path: e.resolvedPath,
            via: node,
            viaSymbols: e.namedSymbols,
            type: e.type,
          });
          contributed++;
        }
      }
      if (tier.length === 0) break;
      const capped = tier.slice(0, opts.perTierCap);
      fwdTiers.push(capped);
      frontierPaths = capped.map((n) => n.path);
    }
  }

  // reverse (callers of callers of ...)
  {
    const visited = new Set<string>([opts.start]);
    let frontierPaths: string[] = [opts.start];
    for (let hop = 1; hop <= opts.maxHops; hop++) {
      const tier: HopNode[] = [];
      for (const node of frontierPaths) {
        let contributed = 0;
        for (const e of opts.reverseGraph.get(node) ?? []) {
          if (visited.has(e.path)) continue;
          if (contributed >= opts.perParentCap) break;
          visited.add(e.path);
          tier.push({
            path: e.path,
            via: node,
            viaSymbols: e.importedSymbols,
            type: e.type,
          });
          contributed++;
        }
      }
      if (tier.length === 0) break;
      const capped = tier.slice(0, opts.perTierCap);
      revTiers.push(capped);
      frontierPaths = capped.map((n) => n.path);
    }
  }

  return { forwardTiers: fwdTiers, reverseTiers: revTiers };
}

// =============================================================================
// Render helpers
// =============================================================================
function withLineNumbers(
  content: string,
  maxBytes: number,
): { numbered: string; truncated: boolean } {
  let truncated = false;
  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    content = content.slice(0, maxBytes);
    truncated = true;
  }
  const lines = content.split('\n');
  const width = String(lines.length).length;
  const numbered = lines
    .map((l, i) => `${String(i + 1).padStart(width, ' ')}: ${l}`)
    .join('\n');
  return { numbered, truncated };
}

async function loadRules(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of RULE_FILES) {
    try { out[name] = await readFile(join(root, name), 'utf8'); } catch {}
  }
  return out;
}

// =============================================================================
// Main
// =============================================================================
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.subcommand === 'memory') {
    await handleMemorySubcommand(args);
    return;
  }

  const { root } = args;
  log(`root=${root}`);
  log(`base=${args.base}`);

  if (!(await verifyRef(root, args.base))) {
    process.stderr.write(`[ctx] error: base ref "${args.base}" does not resolve.\n`);
    process.exit(1);
  }

  const repo = await getRepoName(root);
  const changed = await getChangedFiles(root, args.base);
  log(`changed files vs ${args.base}: ${changed.length}`);

  const rules = await loadRules(root);
  log(`rules detected: ${Object.keys(rules).join(', ') || '(none)'}`);

  let memory: { path: string; content: string } | null = null;
  if (args.useMemory) {
    try {
      memory = { path: args.memoryPath, content: await readMemory(args.memoryPath) };
      log(`memory: ${args.memoryPath} (${memory.content.length} bytes)`);
    } catch (e) { log('memory load failed:', (e as Error).message); }
  }

  log('walking source files...');
  const walked = await walkSourceFiles(root, args.scope);
  const unionSet = new Set(walked);

  // Walk workspace packages unless explicitly disabled. Without this, bare
  // imports like `@stackframe/stack-shared` classify as external and the
  // reverse graph is blind to every caller outside the scoped walk.
  const workspaces = args.includeWorkspaces ? await loadWorkspaces(root) : [];
  let workspaceFilesAdded = 0;
  if (workspaces.length > 0) {
    log(`found ${workspaces.length} workspace packages`);
    for (const ws of workspaces) {
      const before = unionSet.size;
      const wsFiles = await walkSourceFiles(root, ws.dir);
      for (const f of wsFiles) unionSet.add(f);
      workspaceFilesAdded += unionSet.size - before;
    }
  }

  // Changed files must always be parsed, even if outside the walk.
  let changedInScope = 0, changedAdded = 0;
  for (const c of changed) {
    if (c.status === 'deleted') continue;
    if (!SOURCE_EXTS.has(extname(c.path))) continue;
    if (unionSet.has(c.path)) { changedInScope++; continue; }
    if (existsSync(join(root, c.path))) {
      unionSet.add(c.path);
      changedAdded++;
    }
  }
  const allFiles = [...unionSet];
  const fileSet = unionSet;
  log(`indexed ${walked.length} via scope + ${workspaceFilesAdded} workspace files + ${changedAdded} changed (${changedInScope} already in scope)`);

  log('parsing AST for all files...');
  const symbolsByFile = new Map<string, SymbolSet>();
  const importsByFile = new Map<string, RawImport[]>();
  const contentsByFile = new Map<string, string>();
  let parseFails = 0;
  let progress = 0;
  for (const f of allFiles) {
    progress++;
    let src: string;
    try { src = await readFile(join(root, f), 'utf8'); } catch { continue; }
    contentsByFile.set(f, src);
    const ast = parseFile(src, f);
    if (!ast) { parseFails++; continue; }
    const a = analyzeAst(ast);
    symbolsByFile.set(f, { exports: a.exports, functions: a.functions, classes: a.classes });
    importsByFile.set(f, a.imports);
    if (progress % 200 === 0) log(`  parsed ${progress}/${allFiles.length}`);
  }
  log(`AST parse done. failures: ${parseFails}`);

  log('resolving imports + building graph...');
  const forwardGraph = new Map<string, ForwardEdge[]>();
  const reverseGraph = new Map<string, ReverseEdge[]>();
  for (const f of allFiles) {
    const imps = importsByFile.get(f) ?? [];
    const out: ForwardEdge[] = [];
    for (const imp of imps) {
      const resolvedPath = await resolveImport(imp.specifier, f, root, fileSet, workspaces);
      if (resolvedPath) {
        out.push({
          specifier: imp.specifier,
          kind: 'internal',
          type: imp.type,
          resolvedPath,
          namedSymbols: imp.namedSymbols,
        });
        if (!reverseGraph.has(resolvedPath)) reverseGraph.set(resolvedPath, []);
        reverseGraph.get(resolvedPath)!.push({
          path: f,
          importedSymbols: imp.namedSymbols,
          type: imp.type,
        });
      } else {
        out.push({
          specifier: imp.specifier,
          kind: 'external',
          type: imp.type,
          namedSymbols: imp.namedSymbols,
        });
      }
    }
    forwardGraph.set(f, out);
  }
  let internalEdges = 0;
  for (const v of forwardGraph.values()) {
    internalEdges += v.filter((e) => e.kind === 'internal').length;
  }
  log(`graph: ${forwardGraph.size} nodes, ${internalEdges} internal edges`);

  let embedding: EmbeddingResult = {
    vectors: new Map(), ok: false, hits: 0, misses: 0,
  };
  if (args.embeddings) {
    log(`embedding via ollama (${args.embeddingModel} @ ${args.ollamaUrl})...`);
    embedding = await embedAllFiles({
      files: allFiles,
      contents: contentsByFile,
      model: args.embeddingModel,
      baseUrl: args.ollamaUrl,
      cachePath: args.cachePath,
      embedMaxChars: args.embedMaxChars,
      batchSize: args.embedBatchSize,
    });
  }

  log(`assembling ${changed.length} per-file bundles...`);
  const allChangedPaths = changed.map((c) => c.path);
  const filesContext: FileContext[] = [];

  for (const c of changed) {
    const { status, path: filePath, prevPath } = c;

    const [patch, numstat] = await Promise.all([
      getPatch(root, args.base, filePath),
      getNumstat(root, args.base, filePath),
    ]);

    let fullContent = '';
    let truncated = false;
    if (status !== 'deleted') {
      try {
        const raw = await readFile(join(root, filePath), 'utf8');
        const r = withLineNumbers(raw, args.maxFileBytes);
        fullContent = r.numbered;
        truncated = r.truncated;
      } catch {}
    }

    const symbols = symbolsByFile.get(filePath) ?? { exports: [], functions: [], classes: [] };
    const directImports = forwardGraph.get(filePath) ?? [];
    const directCallers = (reverseGraph.get(filePath) ?? []).slice(0, args.maxCallers);

    const { forwardTiers, reverseTiers } = traverseGraph({
      start: filePath,
      forwardGraph,
      reverseGraph,
      maxHops: args.maxHops,
      perTierCap: args.maxCallers,
      perParentCap: args.maxPerParent,
    });

    let semanticNeighbors: SemanticNeighbor[] = [];
    if (embedding.ok) {
      const myVec = embedding.vectors.get(filePath);
      if (myVec) {
        const exclude = new Set<string>([filePath]);
        const forwardSet = new Set<string>();
        const reverseSet = new Set<string>();
        for (const t of forwardTiers) for (const n of t) forwardSet.add(n.path);
        for (const t of reverseTiers) for (const n of t) reverseSet.add(n.path);
        semanticNeighbors = topKNeighbors(
          myVec, embedding.vectors, exclude, args.maxNeighbors,
          forwardSet, reverseSet,
        );
      }
    }

    const dir = dirname(filePath);
    const siblings = allFiles
      .filter((f) => f !== filePath && dirname(f) === dir)
      .slice(0, args.maxSiblings);

    let dependencyContents: Record<string, { content: string; truncated: boolean }> | undefined;
    if (args.includeContentForDeps) {
      dependencyContents = {};
      for (const imp of directImports) {
        if (imp.kind !== 'internal' || !imp.resolvedPath) continue;
        if (dependencyContents[imp.resolvedPath]) continue;
        const raw = contentsByFile.get(imp.resolvedPath);
        if (!raw) continue;
        const r = withLineNumbers(raw, args.maxFileBytes);
        dependencyContents[imp.resolvedPath] = { content: r.numbered, truncated: r.truncated };
      }
    }

    filesContext.push({
      path: filePath,
      prevPath,
      status,
      additions: numstat.additions,
      deletions: numstat.deletions,
      patch,
      fullContent,
      truncated,
      symbols,
      directImports,
      directCallers,
      multiHop: { forwardTiers, reverseTiers },
      semanticNeighbors,
      siblings,
      otherChangedFiles: allChangedPaths.filter((p) => p !== filePath),
      ...(dependencyContents && { dependencyContents }),
    });
  }

  const bundle: Bundle = {
    meta: {
      repo,
      base: args.base,
      generatedAt: new Date().toISOString(),
      changedFileCount: changed.length,
      indexedFileCount: allFiles.length,
      graphEdgeCount: internalEdges,
      maxHops: args.maxHops,
      embeddings: embedding.ok
        ? {
            model: args.embeddingModel,
            url: args.ollamaUrl,
            cacheHits: embedding.hits,
            cacheMisses: embedding.misses,
          }
        : null,
      diffMode: 'working-tree-vs-base',
    },
    rules,
    memory,
    changedFiles: allChangedPaths,
    files: filesContext,
  };

  const json = JSON.stringify(bundle, null, 2);
  if (args.out) {
    await writeFile(args.out, json);
    log(`wrote ${args.out} (${json.length} bytes)`);
  } else {
    process.stdout.write(json + '\n');
  }
}

main().catch((err: unknown) => {
  const e = err as Error;
  process.stderr.write(`[ctx] fatal: ${e?.stack || e}\n`);
  process.exit(1);
});
