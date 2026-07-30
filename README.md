# tightdiff

[![npm](https://img.shields.io/npm/v/tightdiff)](https://www.npmjs.com/package/tightdiff)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](./package.json)
[![license](https://img.shields.io/npm/l/tightdiff)](./LICENSE)
[![CI](https://github.com/majidbilal/tightdiff/actions/workflows/ci.yml/badge.svg)](https://github.com/majidbilal/tightdiff/actions/workflows/ci.yml)

**AI wrote your code. This checks it didn't leave a mess behind.**

```bash
npx tightdiff
```

Run it before you commit. No install, no config.

---

## The problem, in one example

You ask your AI assistant to fix a bug. It does. It also:

- leaves a `console.log` in there from when it was debugging
- adds `// @ts-ignore` because the types complained
- puts `.skip` on the test that was failing
- writes `throw new Error("not implemented")` in a branch it didn't finish
- reformats fifty lines you never asked it to touch

Every one of those **passes your tests**. Every one of those ships. Do it fifty times and the
codebase is a swamp — and you won't know which change did it.

## What tightdiff does

It reads your actual changes and **stops the commit** if it finds any of that:

```
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

✗ tightdiff: 4 blocking issue(s) in 8 changed lines.

Fix the blocking items, or escalate the underlying failure — do not silence the check.
```

It exits with an error code, so it actually **blocks** — it isn't a suggestion you can scroll past.

## Use it with your AI coding assistant

**Step 1 — make it a gate.** Create `.husky/pre-commit`, or `.git/hooks/pre-commit`, containing:

```sh
#!/bin/sh
npx tightdiff || exit 1
```

Now no commit lands with slop in it, whoever or whatever wrote it.

**Step 2 — tell your assistant about it.** Paste this into `CLAUDE.md`, `AGENTS.md`, or
`.cursor/rules/tightdiff.mdc`:

```markdown
## Before you finish a change

Run `npx tightdiff` and fix anything it blocks. It catches leftovers that pass tests but
should never ship: debug logging, skipped tests, @ts-ignore, placeholder code, committed
build output, and hardcoded secrets.

If it blocks something you believe is correct, do NOT silence the rule. Either fix the
underlying problem, or add a suppression WITH a stated reason on that line:

    console.log(banner); // tightdiff-allow debug-leftover — this is the CLI's real output

Suppressions appear in every report, so they stay visible.
```

Works with **Claude Code, Cursor, Codex, Copilot CLI, Aider** — anything that reads a project
instruction file and can run a command.

**Step 3 — put it in CI** so it can't be skipped locally:

```yaml
- run: npx tightdiff --base origin/main
```

### Or connect it as an MCP server

If your tool supports MCP (Claude Code, Claude Desktop, Cursor, Codex), the assistant can check its
own work directly — no shell needed:

```json
{
  "mcpServers": {
    "tightdiff": { "command": "npx", "args": ["-y", "-p", "tightdiff", "tightdiff-mcp"] }
  }
}
```

Four tools: `check_diff` (check a `git diff`), `check_files` (check files you just wrote, before any
diff exists), `audit_repo` (scan a whole project), and `list_rules` (so it knows the bar before it
starts). Every reply leads with a one-line **verdict**, so the assistant can act without parsing prose.

**Completely stateless** — nothing is held between calls, so it's safe to restart at any time.

## Already have a messy codebase?

Don't worry — you won't get 500 errors on day one. Record what's already there, and only *new*
problems will fail:

```bash
npx tightdiff --audit --write-baseline   # once: "this is the existing mess, ignore it"
npx tightdiff --audit                    # from now on, only new mess fails
```

It also tells you when baselined problems have been **fixed**, so you can tighten it over time
instead of carrying the baseline forever.

## What it catches

**Blocks the commit** — things that are basically never right:

| | |
|---|---|
| `debug-leftover` | `console.log`, `debugger`, `dbg!` left in shipped code |
| `disabled-test` | `.skip`, `.only`, `xit` — a hidden failing test |
| `weakened-check` | `\|\| true`, `continue-on-error`, `--no-verify`, `@ts-ignore` |
| `placeholder` | `TODO: implement`, `NotImplementedError`, lorem ipsum, `YOUR_KEY_HERE` |
| `hardcoded-secret` | an API key, token, or password in the source |
| `generated-committed` | `dist/`, `build/`, `.min.js` committed instead of built |
| `out-of-scope` | a file outside the area you said you'd touch |
| `missing-module` | an import of a file that doesn't exist |

**Warns only** — sometimes fine, so it never blocks: `commented-code`, `redundant-comment`,
`hedging-comment` ("this should work"), `pointless-catch`, `async-no-await`,
`reinvented-platform` (hand-writing something JavaScript already has), `any-escape`, `empty-catch`,
`trailing-whitespace`, `reformat-churn`, `dependency-added`, `duplicate-block`, `oversized-change`.

That split is deliberate: **a tool that cries wolf gets switched off**, which is worse than not
having it. Only things that are almost never justified will stop you.

### Three kinds of mess

Rules are grouped by what's actually wrong, and reported per group:

- **noise** — adds nothing (debug logs, dead code, comments restating the code)
- **lies** — looks finished but isn't (placeholders, silenced checks, swallowed errors)
- **taste** — works, but shouldn't exist in that shape (reinvented built-ins, copy-paste)

Most tools only catch *noise*. Confidently-wrong code is the expensive kind.

## All the options

```bash
npx tightdiff --help
```

| Option | What it does |
|---|---|
| *(nothing)* | check your staged changes — use this in a pre-commit hook |
| `--all` | check everything you've changed, staged or not |
| `--base origin/main` | check the whole branch — use this in CI |
| `--audit` | scan the entire project, not just recent changes |
| `--baseline <file>` | only fail on problems not already recorded |
| `--write-baseline` | record current problems as accepted |
| `--scope "src/**"` | fail if files outside this area were touched |
| `--allow <rule>` | downgrade a rule to a warning (shown in the report) |
| `--json` | machine-readable, for CI dashboards |

Project defaults go in `tightdiff.json`:

```json
{
  "limits": { "maxChangedLines": 400 },
  "writeScope": ["src/**", "tests/**"],
  "allow": ["trailing-whitespace"]
}
```

## Using it in code

```js
import { analyze, formatReport } from "tightdiff";

const result = analyze(diffText, { writeScope: ["src/**"] });
result.ok;        // false if anything blocks
result.blocking;  // [{ rule, file, line, why, evidence }]
console.log(formatReport(result));
```

## What it won't do

- It **doesn't judge whether your code is correct** — that's what tests are for. It catches the
  mess around the code.
- It **doesn't rewrite anything.** It tells you what's wrong and where; you decide.
- It reads text, not meaning. It can't tell that a function is badly named or an abstraction is
  wrong.
- It **isn't a formatter.** Use Prettier or ESLint for style; tightdiff only flags formatting when
  it's *churn* — lines reformatted that weren't part of your change.

**See [ROADMAP.md](./ROADMAP.md)** for what's coming next, and what deliberately isn't.

Found a false positive? That's a **bug** — please report it. A tool that cries wolf gets switched
off, which is worse than not having one.


## Why you can trust it in a build

No dependencies at all — nothing to install, nothing that can break. Runs anywhere Node 18+ runs.
Tested on Linux, macOS and Windows across Node 18, 20 and 22.

## License

MIT © Majid Bilal
