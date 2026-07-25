#!/usr/bin/env node
// Ported pattern from claude-supermemory's scripts/build.js: esbuild each
// hook/CLI entry point into a single minified, dependency-free `.cjs` with
// a `#!/usr/bin/env node` banner. Node >=18 on PATH is the only runtime
// requirement — no `npm install` needed for the plugin cache itself.
//
// The one deviation from the supermemory precedent (T3.1's packaging risk):
// `better-sqlite3` / `fastembed` (+ its `onnxruntime-node` native addon)
// and `ws`'s optional native accelerators (`bufferutil`/`utf-8-validate`,
// pulled in transitively via ethers/0g-ts-sdk's websocket provider) are
// marked `external` — esbuild cannot inline a platform-specific `.node`
// binding into a single JS file. They're resolved at runtime via
// `lib/native-bootstrap.ts`'s `Module.globalPaths` splice
// (better-sqlite3/fastembed) or simply left unresolved-but-uncalled
// (bufferutil/utf-8-validate — `ws` already try/catches these and falls
// back to pure JS masking when absent).

const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, '..', '..', 'claude-dmemo', 'plugin', 'scripts');

const ENTRIES = [
  'hooks/session-start.ts',
  'hooks/user-prompt-submit.ts',
  'hooks/stop.ts',
  'hooks/pre-compact.ts',
  'hooks/recall-approve.ts',
  'cli/search-memory.ts',
  'cli/save-memory.ts',
  'cli/status.ts',
  'codex/install.ts',
];

// Native modules that cannot be esbuild-inlined (see header comment).
const NATIVE_EXTERNAL = ['better-sqlite3', 'fastembed', 'onnxruntime-node', 'bufferutil', 'utf-8-validate', 'pg-native'];

// mem0ai/oss's `VectorStoreFactory`/`EmbedderFactory`/`LLMFactory` lazily
// `import()` every optional backend it supports (Qdrant, Pinecone, Ollama,
// every cloud LLM SDK, ...) even though dMemo only ever configures
// 'memory'/'fastembed'/the unused-by-design 'openai' llm slot (see
// core/src/session.ts's buildMemoryConfig comment). None of these branches
// are ever reached, but esbuild still needs to know not to try to
// statically resolve+bundle them (they aren't installed — reaching one at
// runtime would `throw` inside mem0ai's own factory, exactly as it would
// unbundled). Exhaustive list taken from every `import("...")` in
// mem0ai@3.1.1's dist/oss/index.mjs.
const OSS_OPTIONAL_BACKENDS = [
  '@anthropic-ai/sdk',
  '@aws-sdk/client-bedrock-runtime',
  '@aws-sdk/client-neptune-graph',
  '@aws-sdk/client-s3vectors',
  '@azure/identity',
  '@azure/search-documents',
  '@databricks/sql',
  '@elastic/elasticsearch',
  '@google-cloud/aiplatform',
  '@google/genai',
  '@huggingface/transformers',
  '@langchain/core/documents',
  '@langchain/core/messages',
  '@mistralai/mistralai',
  '@mochow/mochow-sdk-node',
  '@opensearch-project/opensearch',
  '@pinecone-database/pinecone',
  '@qdrant/js-client-rest',
  '@supabase/supabase-js',
  '@turbopuffer/turbopuffer',
  '@upstash/vector',
  'cassandra-driver',
  'chromadb',
  'cloudflare',
  'cohere-ai',
  'groq-sdk',
  'iovalkey',
  'mongodb',
  'mysql2/promise',
  'ollama',
  'redis',
  'weaviate-client',
  'zeroentropy',
];

const EXTERNAL = [...NATIVE_EXTERNAL, ...OSS_OPTIONAL_BACKENDS];

async function build() {
  console.log('Building dMemo Node adapter hooks...\n');
  fs.mkdirSync(OUT, { recursive: true });

  const OUTPUT_NAMES = { 'codex/install.ts': 'install-codex-hooks' };

  for (const entry of ENTRIES) {
    const entryPath = path.join(SRC, entry);
    const name = OUTPUT_NAMES[entry] ?? path.basename(entry, '.ts');
    const outfile = path.join(OUT, `${name}.cjs`);

    try {
      await esbuild.build({
        entryPoints: [entryPath],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        outfile,
        minify: true,
        // @dmemo/core's session.ts does `createRequire(import.meta.url)`
        // (to best-effort read mem0ai's installed version — wrapped in its
        // own try/catch, but the createRequire() call itself is not, so a
        // bare `undefined` here would throw at module-eval time and crash
        // the whole bundle). esbuild cannot preserve `import.meta.url` in
        // `format: 'cjs'` output (it silently becomes `undefined`) — so
        // `define` it to a banner-injected const computed from the real
        // CJS `__filename` of *this* bundled file instead. This is a
        // build-time-only workaround; @dmemo/core's own source is
        // unmodified (per T3.1's "do not modify packages/core").
        define: { 'import.meta.url': 'DMEMO_IMPORT_META_URL' },
        // No manual shebang here: every entry point's own source already
        // starts with `#!/usr/bin/env node`, and esbuild auto-preserves a
        // source hashbang at the very top of the bundle — adding it again
        // via `banner` would duplicate the line and produce invalid JS.
        banner: {
          js: 'const DMEMO_IMPORT_META_URL = require("url").pathToFileURL(__filename).href;',
        },
        external: EXTERNAL,
        logLevel: 'warning',
      });
      fs.chmodSync(outfile, 0o755);
      const stats = fs.statSync(outfile);
      console.log(`  ${name}.cjs (${(stats.size / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.error(`Failed to build ${name}:`, err.message);
      process.exitCode = 1;
      return;
    }
  }

  // codex/install.ts loads hooks-template.json relative to its own
  // compiled location at runtime (fs.readFileSync, not a bundled import) —
  // copy it alongside the other .cjs artifacts.
  fs.copyFileSync(path.join(SRC, 'codex', 'hooks-template.json'), path.join(OUT, 'hooks-template.json'));
  console.log('  hooks-template.json (copied)');

  console.log('\nBuild complete ->', OUT);
}

build();
