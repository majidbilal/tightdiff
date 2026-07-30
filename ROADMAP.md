# Roadmap

What works now, what's coming, and what deliberately isn't. No dates — this is maintained honestly
rather than optimistically.

Caught something it should have flagged, or flagged something it shouldn't?
[Open an issue](https://github.com/majidbilal/tightdiff/issues). **False positives are treated as
bugs**, not as your problem to work around — a tool that cries wolf gets switched off, which is worse
than not having it.

---

## Working now (0.2.x)

| | |
|---|---|
| **Blocks 8 things** | Debug leftovers, skipped tests, silenced checks, placeholders, hardcoded secrets, committed build output, out-of-scope edits, imports of files that don't exist. |
| **Warns on 16 more** | Commented-out code, comments that restate the code, hedging comments, pointless try/catch, `async` with no `await`, hand-writing something JavaScript already has, `any` escapes, and more. |
| **Two modes** | Check a diff (pre-commit, CI) or scan a whole project (`--audit`). |
| **Baselines** | Adopt it on a messy codebase without drowning: record what's there, fail only on what's new. Tells you when old problems get fixed, so you can tighten it. |
| **Suppressions** | Allowed, but a reason is mandatory, and every one appears in the report. A suppression that silences nothing is reported as stale. |
| **MCP server** | Four tools your AI assistant can call directly, so it checks its own work. Stateless. |

---

## Coming next

### `--fix` for the boring ones
Some findings have exactly one correct fix — trailing whitespace, an unused import. You shouldn't have
to do those by hand. Strictly limited to changes that **cannot alter behaviour**; anything requiring
judgement will always be left to you.

### Telling your assistant the rules *before* it writes code
Today tightdiff catches problems after the fact. A `--brief` command will print the rules as
instructions you can paste into `CLAUDE.md` / `AGENTS.md` / `.cursor/rules`, so the assistant avoids
them in the first place. Prevention and enforcement from one source, which nothing else currently does.

### Catching imports of packages you never installed
It already catches imports of *files* that don't exist. Imports of *packages* that were never
installed — a classic AI hallucination — need checking against your `package.json`. That's the
highest-value check still missing.

### More languages
Unused-import and missing-module checks are JavaScript/TypeScript only today. Python and Go next. The
other rules already work on any text.

### Spotting single-use abstractions
A wrapper class or helper used exactly once is the classic over-build. It works, it passes every
check, and it shouldn't exist.

### SARIF output
So findings appear natively in GitHub code scanning and most CI dashboards instead of just in logs.

### Trend tracking
Is slop increasing or decreasing over time? One run can't tell you.

### A published benchmark
Currently the case *for* tightdiff is an argument, not evidence. It needs measuring on real AI-written
changes, published so you can check it.

### One known rough edge
A suppression comment written inside a **multi-line template literal** is still read as real, which
can produce one spurious "stale suppression" note. It's informational and never blocks, so it's
recorded rather than rushed.

---

## Not planned, and why

Saying no clearly is more useful than a vague maybe.

**Judging whether your code is *correct*.** That's what tests are for. tightdiff catches the mess
*around* the code — the things that pass tests and still shouldn't ship.

**Rewriting your code.** Beyond the mechanical fixes above, it reports and you decide. A linter that
silently edits is a linter you stop trusting.

**Style and formatting opinions.** Use Prettier, ESLint, Biome — they're better at it, and tightdiff
deliberately doesn't compete. It only flags formatting when it's *churn*: reformatting lines that
weren't part of your change.

**Understanding meaning.** It reads text, not semantics. It can't tell you a function is badly named
or an abstraction is wrong.

---

## How versions work

`0.x` means the API may still change between minor versions, though breaking changes will be called
out in the release notes. New **blocking** rules are treated as breaking, because they can fail a
build that used to pass; new warnings are not. Anything published is tested on Linux, macOS and
Windows across Node 18, 20 and 22, and every release carries a [provenance
attestation](https://docs.npmjs.com/generating-provenance-statements).
