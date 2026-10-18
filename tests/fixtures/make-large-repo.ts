/**
 * Generates the large-repository fixture used by tests/integration/large-repo.test.ts.
 *
 * Design intent: synthetic but *shaped like a real project*. A test that runs
 * against a two-file fixture will not notice a parser that mishandles deep paths,
 * a diff budget that never engages, a listing that is fine at three entries and
 * wrong at three hundred, or a highlighter that has never met a file past its own
 * limit. This fixture reproduces all four conditions offline, so the suite stays
 * deterministic and does not depend on network access to a public repository.
 *
 * Shape, chosen to mirror a mature web framework:
 *   - nested directories several levels deep (lib/router/, lib/generated/, lib/edge/)
 *   - a long linear history with a rename partway through
 *   - files with awkward path characters (spaces, plus signs, mixed case)
 *   - one deliberately large generated file that exceeds the highlight limit
 *   - a tag history and a second branch
 *
 * Usage: bun tests/fixtures/make-large-repo.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "express-ish");
const COMMITS = 45;
/**
 * File counts are chosen to exceed 50 tracked files, which is the threshold the
 * suite asserts on. A fixture with 30 files cannot distinguish "the clone worked"
 * from "the clone returned a subset", which is what that assertion is for.
 */
const LIB_FILES = 45;
const TEST_FILES = 20;
/**
 * Entries in the generated bundle, chosen to clear the 2,000-line highlight
 * limit without making every push and clone in the test run slow. Six lines per
 * entry plus overhead: 420 entries is ~2,540 lines.
 */
const BUNDLE_ENTRIES = 420;

function run(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  }
}

const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com"];

/** A plausible module body: long enough to be real, short enough to be fast. */
function moduleSource(name: string, index: number): string {
  return `'use strict';

/**
 * ${name} module.
 *
 * Generated for the large-repository fixture. The body is deliberately shaped
 * like real framework code: a require block, exported functions, a class, and
 * a few comments the highlighter must classify correctly.
 */

const path = require('path');
const { EventEmitter } = require('events');

const DEFAULTS = {
  name: ${JSON.stringify(name)},
  index: ${index},
  retries: 3,
  timeout: 5000,
  flags: ['strict', 'silent', 'verbose'],
};

class ${capitalize(name)}Handler extends EventEmitter {
  constructor(options) {
    super();
    this.options = Object.assign({}, DEFAULTS, options || {});
    this.cache = new Map();
    this.started = Date.now();
  }

  /**
   * Resolves a path relative to the handler root.
   * @param {string} input
   * @returns {string}
   */
  resolve(input) {
    if (typeof input !== 'string') {
      throw new TypeError('resolve expects a string, got ' + typeof input);
    }
    const cached = this.cache.get(input);
    if (cached !== undefined) return cached;
    const resolved = path.resolve(this.options.root || '.', input);
    this.cache.set(input, resolved);
    return resolved;
  }

  async handle(request) {
    const id = request && request.id ? request.id : 'anonymous';
    for (let attempt = 1; attempt <= this.options.retries; attempt++) {
      try {
        this.emit('attempt', { id, attempt });
        const result = await this.process(request);
        return { ok: true, id, attempt, result };
      } catch (error) {
        if (attempt === this.options.retries) {
          this.emit('error', error);
          return { ok: false, id, attempt, message: String(error && error.message) };
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
    return { ok: false, id, attempt: 0, message: 'unreachable' };
  }

  async process(request) {
    if (!request || typeof request !== 'object') {
      throw new Error('process expects an object');
    }
    return {
      name: this.options.name,
      index: this.options.index,
      keys: Object.keys(request),
      length: JSON.stringify(request).length,
      at: new Date().toISOString(),
    };
  }

  stats() {
    return {
      name: this.options.name,
      cached: this.cache.size,
      uptime: Date.now() - this.started,
    };
  }
}

function ${camelize(name)}(options) {
  return new ${capitalize(name)}Handler(options);
}

module.exports = {
  ${camelize(name)},
  ${capitalize(name)}Handler,
  DEFAULTS,
};
`;
}

function capitalize(value: string): string {
  return value.replace(/(^|[-_])(\w)/g, (_m, _p, c: string) => c.toUpperCase()).replace(/[-_]/g, "");
}

function camelize(value: string): string {
  const capped = capitalize(value);
  return capped.charAt(0).toLowerCase() + capped.slice(1);
}

/**
 * A generated bundle past the highlight threshold.
 *
 * Size is a deliberate trade-off. The viewer's limit is 2,000 lines / 200 KiB,
 * so the fixture only needs to *cross* it - and every extra kilobyte here is
 * paid on every push, clone and archive in the test run. An earlier version used
 * 3,600 lines (~120 KiB) and made a single HTTP push take minutes on a loaded
 * machine, which turned a correctness suite into a timeout generator. This is
 * sized to clear the line limit with margin and stop.
 */
function generatedBundle(entries: number): string {
  const lines: string[] = [
    "/* GENERATED FILE - do not edit. Exceeds the viewer's highlight limit on purpose. */",
    "'use strict';",
    "",
  ];
  for (let i = 0; i < entries; i++) {
    lines.push(`// ---- entry ${i} ----`);
    lines.push(`function entry${i}(input) {`);
    lines.push(`  const value = typeof input === 'number' ? input : Number(input) || 0;`);
    lines.push(`  return { index: ${i}, value: value, tag: 'entry-${i}' };`);
    lines.push("}");
    lines.push("");
  }
  lines.push("module.exports = { entries: " + entries + " };");
  return `${lines.join("\n")}\n`;
}

const README = `# Fixture Framework

A synthetic repository used to test GitGood against a realistically shaped
project rather than a two-file toy.

## What makes it useful as a test input

- Nested source directories several levels deep
- A long commit history with a rename partway through
- Files whose paths contain spaces, plus signs and mixed case
- One generated file larger than the viewer's highlight limit
- Tags and a second branch

## Layout

\`\`\`
lib/            source modules
lib/router/     the module used for blame and diff assertions
lib/generated/  the oversized generated bundle
lib/edge/       awkward filenames
test/           test files
\`\`\`

## Usage

\`\`\`js
const { createRouter } = require('./lib/router');
const router = createRouter({ retries: 5 });
\`\`\`
`;

function main(): void {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  run(["init", "-q", "-b", "main"], OUT);

  const write = (relative: string, contents: string): void => {
    const full = join(OUT, relative);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  };

  // --- commit 1: skeleton ---------------------------------------------------
  write("README.md", README);
  write("package.json", `${JSON.stringify({
    name: "fixture-framework",
    version: "0.1.0",
    main: "lib/index.js",
    scripts: { test: "node test/run.js" },
  }, null, 2)}\n`);
  write("lib/index.js", moduleSource("index", 0));
  run(["add", "-A"], OUT);
  run([...identity, "commit", "-q", "-m", "Initial skeleton"], OUT);

  // --- commits 2..N: a module per commit, so blame is genuinely varied ------
  const modules: string[] = [];
  for (let i = 0; i < LIB_FILES; i++) {
    const name = `module-${i}`;
    modules.push(`lib/${name}.js`);
    write(`lib/${name}.js`, moduleSource(name, i));
    run(["add", "-A"], OUT);
    run([...identity, "commit", "-q", "-m", `Add ${name} module`], OUT);
  }

  // --- router package: the file the blame assertions target -----------------
  write("lib/router/index.js", moduleSource("router", 99));
  write("lib/router/helpers.js", moduleSource("router-helpers", 98));
  run(["add", "-A"], OUT);
  run([...identity, "commit", "-q", "-m", "Add the router module"], OUT);
  run(["tag", "-a", "v0.1.0", "-m", "First release"], OUT);

  // --- awkward filenames ----------------------------------------------------
  write("lib/edge/case-sensitive+name.js", moduleSource("edge-case", 1));
  write("lib/edge/with space.js", moduleSource("edge-space", 2));
  write("lib/edge/UPPER.lower.js", moduleSource("edge-upper", 3));
  run(["add", "-A"], OUT);
  run([...identity, "commit", "-q", "-m", "Add edge-case filenames"], OUT);

  // --- a rename, deep in the tree -------------------------------------------
  run(["mv", "lib/module-3.js", "lib/router/legacy-module.js"], OUT);
  run([...identity, "commit", "-q", "-m", "Move module-3 into the router package"], OUT);

  // --- the oversized generated file -----------------------------------------
  // Entries chosen to exceed 2,000 lines: seven lines per entry plus overhead.
  write("lib/generated/bundle.js", generatedBundle(BUNDLE_ENTRIES));
  run(["add", "-A"], OUT);
  run([...identity, "commit", "-q", "-m", "Add the generated bundle"], OUT);

  // --- test files -----------------------------------------------------------
  for (let i = 0; i < TEST_FILES; i++) {
    write(
      `test/${i}-spec.js`,
      `'use strict';\n\ndescribe('suite ${i}', () => {\n  it('passes', () => {\n    expect(${i}).toBe(${i});\n  });\n});\n`,
    );
  }
  run(["add", "-A"], OUT);
  run([...identity, "commit", "-q", "-m", "Add the test suite"], OUT);
  run(["tag", "-a", "v0.2.0", "-m", "Second release"], OUT);

  // --- a second branch so branch listing has something to show --------------
  run(["checkout", "-q", "-b", "next"], OUT);
  write("lib/experimental.js", moduleSource("experimental", 7));
  run(["add", "-A"], OUT);
  run([...identity, "commit", "-q", "-m", "Start experimental work"], OUT);
  run(["checkout", "-q", "main"], OUT);

  // --- filler commits, so history paging has more than one page -------------
  let remaining = COMMITS - 20;
  for (let i = 0; i < remaining; i++) {
    // Touch a README section rather than a large file: enough to be a real
    // commit, small enough to keep the fixture quick to create.
    write("CHANGELOG.md", `# Changelog\n\n${Array.from({ length: i + 1 }, (_, k) => `- change ${k}`).join("\n")}\n`);
    run(["add", "-A"], OUT);
    run([...identity, "commit", "-q", "-m", `Changelog entry ${i}`], OUT);
  }

  const count = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd: OUT }).stdout.toString().trim();
  const files = Bun.spawnSync(["git", "ls-files"], { cwd: OUT }).stdout.toString().trim().split("\n").filter(Boolean);
  const bundleLines = generatedBundle(BUNDLE_ENTRIES).split("\n").length;
  console.log(`created ${OUT}`);
  console.log(`  commits: ${count}`);
  console.log(`  files:   ${files.length}`);
  console.log(`  bundle:  ~${bundleLines} lines in lib/generated/bundle.js`);
  void remaining;
}

main();

