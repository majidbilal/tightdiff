# tightdiff

[![npm](https://img.shields.io/npm/v/tightdiff)](https://www.npmjs.com/package/tightdiff)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![license](https://img.shields.io/npm/l/tightdiff)](./LICENSE)
[![CI](https://github.com/majidbilal/tightdiff/actions/workflows/ci.yml/badge.svg)](https://github.com/majidbilal/tightdiff/actions/workflows/ci.yml)

**Keep changes tight.** A linter for AI code slop. Zero dependencies, Node ≥18.

```bash
npx tightdiff              # no install needed — analyzes your staged changes
npm i -D tightdiff         # as a dev dependency / pre-commit hook
```

**24 rules across three axes** — noise, lies, and taste — that **exit non-zero**. A gate, not a suggestion.

## The problem

Coding agents rarely fail by writing *wrong* code. They fail by writing **too much**: a drive-by
reformat, a stray `console.log`, a block commented out "just in case", a `@ts-ignore` to quiet the
compiler, a `.skip` on the test that broke, a dependency nobody asked for.

Each is small. Together they are how a codebase rots — and **every one of them passes CI.**

## Why this is not "keep diffs small" advice

Advice is ignored. tightdiff parses the actual diff, names each violation with its file and line, and
**exits non-zero**. It is a gate.

```bash
$ npx tightdiff
app.ts
  warn  commented-code:2  Commented-out code is dead weight the next reader must decode.
        // const oldAdd = (a,b) => a+b;
  BLOCK debug-leftover:3  Debug output left in shipped code.
        console.log('adding');
  BLOCK weakened-check:4  This disables a safety check rather than satisfying it.
        // @ts-ignore
  BLOCK placeholder:6  Placeholder content presented as finished work.
        throw new Error('not implemented');

dist/bundle.js
  BLOCK generated-committed  Build output committed. Generate it, do not track it.

✗ tightdiff: 4 blocking issue(s) in 8 changed lines.

Fix the blocking items, or escalate the underlying failure — do not silence the check.
$ echo $?
1
```

## Rules

**Blocking** — patterns that are essentially never justified in finished work:

| Rule | Catches |
|---|---|
| `debug-leftover` | `console.log`, `debugger`, `dbg!`, `binding.pry`, `var_dump` in shipped source |
| `disabled-test` | `.only`, `.skip`, `xit`, `xdescribe`, `@pytest.mark.skip` — a hidden failure |
| `weakened-check` | `\|\| true`, `continue-on-error`, `--no-verify`, `@ts-ignore`, blanket `eslint-disable`, `push --force` |
| `placeholder` | lorem ipsum, `TODO: implement`, `NotImplementedError`, `YOUR_KEY_HERE` |
| `out-of-scope` | a file outside the declared write scope — how parallel agents overwrite each other |
| `generated-committed` | `dist/`, `build/`, `vendor/`, `.min.js` tracked instead of generated (lockfiles exempt) |

**Warnings** — defensible in some contexts, so they never block: `commented-code`, `any-escape`,
`empty-catch`, `trailing-whitespace`, `reformat-churn`, `dependency-added`, `duplicate-block`,
`file-too-large`, `oversized-change`, `too-many-files`.

That split is deliberate. **A gate that cries wolf gets disabled, which is worse than having none.**

## CLI

```bash
npx tightdiff                          # staged changes (pre-commit)
npx tightdiff --all                    # working tree vs HEAD
npx tightdiff --base origin/main       # branch vs a base
git diff | npx tightdiff               # any diff on stdin
npx tightdiff --scope "src/client/**"  # declare an allowed write scope
npx tightdiff --json                   # machine-readable, for CI
```

Exit codes: **0** clean · **1** blocking issues · **2** usage/environment error.

### As a pre-commit hook

```sh
#!/bin/sh
npx tightdiff || exit 1
```

### Project config — `tightdiff.json`

```json
{
  "limits": { "maxChangedLines": 400, "maxFilesTouched": 25 },
  "writeScope": ["src/**", "tests/**"],
  "allow": ["trailing-whitespace"]
}
```

Allowlisting downgrades a rule to a warning and **records that it was allowlisted in the report**, so
the escape hatch stays visible rather than silently weakening the gate.

## Library

```js
import { analyze, parseDiff, formatReport, toJson } from "tightdiff";

const result = analyze(diffText, { writeScope: ["src/**"], limits: { maxChangedLines: 200 } });
result.ok;        // false
result.blocking;  // [{ rule, file, line, why, evidence }]
result.stats;     // { files, added, removed, changed, ruleCounts }
console.log(formatReport(result, { color: true }));
```

## Design rules

- **Pure core.** `analyze()` and `parseDiff()` touch no filesystem and shell out to nothing; only the
  CLI calls `git`.
- **Tolerant parser.** Renames, binaries, new/deleted files, and `\ No newline` are handled. A parser
  that crashes on an unusual diff is a gate that silently stopped protecting you.
- **Added lines only.** Removing slop is always welcome.
- **Every finding explains *why it matters*,** not just what it found.
- **Zero dependencies.**

## License

MIT
