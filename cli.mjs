#!/usr/bin/env node
// tightdiff CLI — a gate, not a suggestion.
//
//   npx tightdiff                      # staged changes (pre-commit)
//   npx tightdiff --all                # working tree vs HEAD
//   npx tightdiff --base origin/main   # branch vs a base
//   git diff | npx tightdiff           # anything on stdin
//   npx tightdiff --scope "src/**" --scope "tests/**"
//
// Exit codes: 0 clean (warnings allowed), 1 blocking issues found, 2 usage/environment error.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, extname } from "node:path";
import { analyze, formatReport, toJson, auditFiles, makeBaseline, applyBaseline, DEFAULT_LIMITS } from "./index.mjs";

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const val = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] ?? d : d; };
const all = (n) => argv.reduce((acc, a, i) => (a === `--${n}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);

if (has("help") || has("h")) {
  console.log(`tightdiff — keep changes tight. A linter for AI code slop.

USAGE
  tightdiff [options]              analyze staged changes (default)
  git diff | tightdiff             analyze a diff on stdin
  tightdiff --audit                scan the WHOLE repo, not just a diff

OPTIONS
  --all                  working tree vs HEAD instead of the index
  --base <ref>           diff against a base ref (e.g. origin/main)
  --audit                whole-repo scan; enables unused-import and missing-module checks
  --baseline <file>      fail only on findings NOT in this baseline (default .tightdiff-baseline.json)
  --write-baseline       record current findings as the baseline and exit 0
  --scope <glob>         allowed write scope; repeatable. Files outside it BLOCK.
  --allow <rule>         downgrade a rule to a warning; repeatable (recorded in the report)
  --max-lines <n>        changed-line budget (default ${DEFAULT_LIMITS.maxChangedLines})
  --max-files <n>        file budget (default ${DEFAULT_LIMITS.maxFilesTouched})
  --json                 machine-readable output
  --quiet                print nothing; rely on the exit code
  --help

ADOPTING THIS ON AN EXISTING CODEBASE
  tightdiff --audit --write-baseline     record what is already there
  tightdiff --audit                      from now on, only NEW slop fails
  A baseline also reports findings that have since been FIXED, so it can be tightened
  rather than living forever.

SUPPRESSING A FINDING (a reason is mandatory)
  console.log(banner); // tightdiff-allow debug-leftover — this is the CLI's real output
  Suppressions are printed in every report, and one that silences nothing is reported as STALE.

BLOCKING RULES
  debug-leftover        console.log / debugger / dbg! left in shipped code
  disabled-test         .only / .skip / xit added — a hidden failure
  weakened-check        || true, continue-on-error, --no-verify, @ts-ignore, eslint-disable
  placeholder           lorem ipsum, "TODO: implement", NotImplementedError, YOUR_KEY_HERE
  hardcoded-secret      an API key, token, or password committed in source
  out-of-scope          a file outside --scope (how parallel agents overwrite each other)
  generated-committed   dist/, build/, .min.js, vendor/ tracked instead of generated
  missing-module        (audit) an import of a file that does not exist

WARNINGS
  commented-code, redundant-comment, hedging-comment, pointless-catch, async-no-await,
  reinvented-platform, any-escape, empty-catch, trailing-whitespace, reformat-churn,
  dependency-added, duplicate-block, file-too-large, oversized-change, too-many-files,
  unused-import (audit)

THE THREE AXES
  noise  content that adds nothing      lies  confidently wrong or unfinished
  taste  works, but should not exist in this shape

EXIT CODES
  0 clean   1 blocking issues   2 usage/environment error`);
  process.exit(0);
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  } catch (e) {
    console.error(`tightdiff: git failed: ${e.message.split("\n")[0]}`);
    process.exit(2);
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const BASELINE_DEFAULT = ".tightdiff-baseline.json";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", "vendor", ".next", ".nuxt", ".cache", ".venv", "__pycache__"]);
const SCAN_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".yml", ".yaml"]);

/** Walk the repo for scannable source. Skips dependency and build directories entirely. */
function collectFiles(root, { maxFiles = 5000 } = {}) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      if (!SCAN_EXT.has(extname(e.name).toLowerCase())) continue;
      try {
        // Skip very large files: they are almost always generated, and reading them is wasted work.
        if (statSync(full).size > 1024 * 1024) continue;
        out.push({ path: relative(root, full).replace(/\\/g, "/"), content: readFileSync(full, "utf8") });
      } catch { /* unreadable file: skip rather than fail the whole audit */ }
    }
  };
  walk(root);
  return out;
}

/** Does a relative import resolve to a real file? Powers the `missing-module` check. */
function makeFileExists(root) {
  const EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
  return (fromPath, specifier) => {
    const base = resolve(root, dirname(fromPath), specifier);
    for (const ext of EXTS) if (existsSync(base + ext)) return true;
    for (const ext of EXTS.slice(1)) if (existsSync(join(base, `index${ext}`))) return true;
    return false;
  };
}

// A repo may declare defaults so every contributor and agent is held to the same bar.
let fileConfig = {};
if (existsSync("tightdiff.json")) {
  try { fileConfig = JSON.parse(readFileSync("tightdiff.json", "utf8")); }
  catch (e) { console.error(`tightdiff: tightdiff.json is not valid JSON: ${e.message}`); process.exit(2); }
}

const limits = { ...fileConfig.limits };
if (val("max-lines")) limits.maxChangedLines = Number(val("max-lines"));
if (val("max-files")) limits.maxFilesTouched = Number(val("max-files"));
const allowRules = [...(fileConfig.allow ?? []), ...all("allow")];

// --- audit mode: whole repo -----------------------------------------------------------------
if (has("audit")) {
  const root = process.cwd();
  const files = collectFiles(root);
  if (!files.length) {
    if (!has("quiet")) console.log("tightdiff: no scannable source files found.");
    process.exit(0);
  }

  let result = auditFiles(files, { fileExists: makeFileExists(root), allow: allowRules, limits });

  const baselinePath = val("baseline", fileConfig.baseline ?? BASELINE_DEFAULT);
  if (has("write-baseline")) {
    const baseline = makeBaseline(result, { note: `audit of ${files.length} files` });
    writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    if (!has("quiet")) {
      console.log(`tightdiff: baseline written to ${baselinePath} — ${baseline.total} existing finding(s) recorded.`);
      console.log("From now on only NEW findings will fail. Re-run with --write-baseline after fixing some, to tighten it.");
    }
    process.exit(0);
  }
  if (existsSync(baselinePath)) {
    try { result = applyBaseline(result, JSON.parse(readFileSync(baselinePath, "utf8"))); }
    catch (e) { console.error(`tightdiff: baseline ${baselinePath} is unreadable: ${e.message}`); process.exit(2); }
  }

  if (!has("quiet")) {
    process.stdout.write(`${has("json") ? toJson(result) : formatReport(result, { color: process.stdout.isTTY })}\n`);
  }
  process.exit(result.ok ? 0 : 1);
}

// --- diff mode (default) --------------------------------------------------------------------
let diff = await readStdin();
if (!diff) {
  const base = val("base");
  if (base) diff = git(["diff", "--no-color", `${base}...HEAD`]);
  else if (has("all")) diff = git(["diff", "--no-color", "HEAD"]);
  else diff = git(["diff", "--no-color", "--cached"]);
}

if (!diff.trim()) {
  if (!has("quiet")) console.log("tightdiff: no changes to analyze.");
  process.exit(0);
}

const scope = [...(fileConfig.writeScope ?? []), ...all("scope")];
let result = analyze(diff, {
  limits,
  writeScope: scope.length ? scope : null,
  allow: allowRules,
});

// A baseline applies in diff mode too: adopting the gate mid-project should not fail on slop that was
// already there before anyone opted in.
const diffBaseline = val("baseline", fileConfig.baseline ?? null);
if (diffBaseline && existsSync(diffBaseline)) {
  try { result = applyBaseline(result, JSON.parse(readFileSync(diffBaseline, "utf8"))); }
  catch (e) { console.error(`tightdiff: baseline ${diffBaseline} is unreadable: ${e.message}`); process.exit(2); }
}

if (!has("quiet")) {
  process.stdout.write(`${has("json") ? toJson(result) : formatReport(result, { color: process.stdout.isTTY })}\n`);
}
process.exit(result.ok ? 0 : 1);
