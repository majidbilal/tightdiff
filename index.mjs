// tightdiff — keep changes tight. A linter for AI code slop.
//
// Zero dependencies, pure functions, Node ≥18. Usable standalone (`npx tightdiff`) or as a library.
//
// WHY: coding agents rarely fail by writing wrong code. They fail by writing TOO MUCH — a drive-by
// reformat, a stray `console.log`, a commented-out block "just in case", a `@ts-ignore` to quiet the
// compiler, a `.skip` on the test that broke, a dependency nobody asked for. Each is small. Together
// they are how a codebase rots, and they all pass CI.
//
// WHAT MAKES THIS DIFFERENT from "keep diffs small" advice: advice is ignored. tightdiff parses the
// actual diff, names each violation with its file and line, and EXITS NON-ZERO. It is a gate, not a
// suggestion — so slop cannot reach the branch.
//
// The rules target change that is almost never necessary for the stated task. tightdiff cannot know
// your task, so it does not guess: it flags categories that are unjustifiable on their own.

/** Severity levels. `block` fails the gate; `warn` is reported and does not. */
export const SEVERITY = { BLOCK: "block", WARN: "warn" };

/**
 * The three axes of AI slop. Organising rules this way (rather than as a flat list) makes the gaps
 * visible: a tool that only catches NOISE will happily pass confidently-wrong code.
 *
 * Taxonomy credit: the three-axis framing comes from prior art in the AI-slop tooling space
 * (notably KarpeSlop's Noise / Lies / Soul split). The rules and implementation here are our own.
 *
 *  - NOISE  — content that adds no information: debug output, restated comments, dead code.
 *  - LIES   — content that is confidently wrong or pretends to be finished: placeholders,
 *             silenced checks, swallowed errors, unverified claims in comments.
 *  - TASTE  — content that works but should not exist in this shape: reinvented platform
 *             features, needless complexity, copy-paste.
 */
export const AXIS = { NOISE: "noise", LIES: "lies", TASTE: "taste" };

/** Default limits. Override per project via `analyze(diff, { limits })`. */
export const DEFAULT_LIMITS = {
  maxChangedLines: 400,     // total added+removed across the change
  maxFilesTouched: 25,
  maxAddedLinesPerFile: 300,
  minDuplicateBlock: 6,     // identical added blocks of this many lines are flagged
};

const isTestPath = (p) => /(^|[\\/])(tests?|__tests__|spec|e2e)[\\/]|\.(test|spec|bench)\.[cm]?[jt]sx?$/i.test(p);
const isGeneratedPath = (p) => /(^|[\\/])(dist|build|out|coverage|vendor|node_modules|\.next|\.nuxt)[\\/]|\.min\.(js|css)$|\.map$/i.test(p);
const isMarkupOrDoc = (p) => /\.(md|mdx|markdown|txt|rst|adoc)$/i.test(p);
const isLockfile = (p) => /(^|[\\/])(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock)$/i.test(p);

/**
 * Paths where writing to stdout IS the product, not a debug leftover.
 *
 * Found by auditing this tool against its own repository: 269 of 295 blocking findings were
 * `console.log` in CLI entry points and git hooks — where printing to the terminal is the entire
 * purpose. A rule that fires on a CLI's own output is the textbook trust-destroying false positive.
 */
const isCliPath = (p) => /(^|[\\/])(bin|hooks|scripts)[\\/]|(^|[\\/])cli\.[cm]?[jt]s$|-cli\.[cm]?[jt]s$/i.test(p);

/**
 * The body of a block whose opening line is `head`, using `rest` as the following lines.
 *
 * Returns `null` when the closing brace is not within `rest` — i.e. the body is not fully visible.
 * That distinction is the point: a rule reasoning about "there is no await anywhere in this function"
 * must stay silent rather than guess when it cannot see the whole function.
 */
export function balancedBody(head, rest, { maxLines = 400 } = {}) {
  let depth = (String(head).match(/\{/g) ?? []).length - (String(head).match(/\}/g) ?? []).length;
  if (depth <= 0) return null;
  const body = [];
  for (let i = 0; i < rest.length && i < maxLines; i++) {
    const line = codeView(rest[i]);
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth <= 0) return body.join("\n");
    body.push(line);
  }
  return null;
}

/**
 * A "code only" view of a line: string CONTENTS blanked and trailing comments dropped, with length
 * preserved so reported columns stay meaningful.
 *
 * This is the single highest-value correctness feature in the tool. Matching raw lines means
 * `const help = "run with console.log to debug"` is reported as a debug leftover, and a documentation
 * string mentioning `@ts-ignore` is reported as a silenced check. Empirical work on static analysis
 * finds that false-positive rates above roughly 20–30% lead teams to abandon a tool outright, so a
 * rule that fires on prose is not a minor annoyance — it is how the whole gate gets switched off.
 *
 * An approximation, deliberately: regex literals and block comments spanning several lines are not
 * tracked. Rules that genuinely need the raw text (comment rules, placeholder content, secrets in
 * strings) receive it as `text`, so nothing is lost by this view being conservative.
 */
export function codeView(line) {
  const s = String(line ?? "");
  let out = "";
  let quote = null;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") { out += "  "; i++; continue; }
      if (c === quote) { quote = null; out += c; continue; }
      // Template-literal interpolation is REAL CODE and must survive. Blanking it made every
      // identifier used only inside `${...}` look unused — the cause of 36 false `unused-import`
      // findings when this tool was audited against its own repository.
      if (quote === "`" && c === "$" && s[i + 1] === "{") {
        let depth = 1;
        out += "${";
        i += 2;
        for (; i < s.length && depth > 0; i++) {
          if (s[i] === "{") depth++;
          else if (s[i] === "}") { depth--; if (depth === 0) { out += "}"; break; } }
          out += s[i];
        }
        continue;
      }
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; continue; }
    if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) break;
    // `#` is a comment only at the start of a line: mid-line it is a JS private field (`this.#x`).
    if (c === "#" && !s.slice(0, i).trim()) break;
    out += c;
  }
  return out;
}

/**
 * Parse a unified diff into files with their added/removed lines.
 *
 * Deliberately tolerant: real `git diff` output contains modes, renames, binary markers, and
 * "\ No newline at end of file". Anything unrecognised is ignored rather than throwing, because a
 * parser that crashes on an unusual diff is a gate that silently stops protecting you.
 */
export function parseDiff(text = "") {
  const files = [];
  let file = null;
  let newLine = 0;

  for (const raw of String(text).split(/\r?\n/)) {
    const gitHeader = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (gitHeader) {
      file = { path: gitHeader[2], oldPath: gitHeader[1], added: [], removed: [], binary: false, renamed: false, isNew: false, isDeleted: false };
      files.push(file);
      newLine = 0;
      continue;
    }
    if (!file) continue;

    if (/^Binary files /.test(raw)) { file.binary = true; continue; }
    if (/^similarity index /.test(raw) || /^rename (from|to) /.test(raw)) { file.renamed = true; continue; }
    if (/^new file mode /.test(raw)) { file.isNew = true; continue; }
    if (/^deleted file mode /.test(raw)) { file.isDeleted = true; continue; }
    if (/^(index |old mode |new mode |--- |\+\+\+ |GIT binary patch)/.test(raw)) continue;
    if (/^\\ No newline/.test(raw)) continue;

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { newLine = Number(hunk[1]); continue; }

    if (raw.startsWith("+")) { file.added.push({ line: newLine++, text: raw.slice(1) }); continue; }
    if (raw.startsWith("-")) { file.removed.push({ text: raw.slice(1) }); continue; }
    if (raw.startsWith(" ")) { newLine++; continue; }
  }
  return files;
}

/**
 * The rules. Each inspects ADDED lines only (removing slop is always welcome) and reports findings.
 *
 * A rule earns `block` severity only if the pattern is essentially never justified in a finished
 * change. Anything defensible in some contexts is a `warn`, so the gate stays trustworthy — a gate
 * that cries wolf gets disabled, which is worse than having none.
 */
export const RULES = [
  {
    id: "debug-leftover",
    axis: AXIS.NOISE,
    severity: SEVERITY.BLOCK,
    why: "Debug output left in shipped code. Remove it, or use the project's logger deliberately.",
    // `code` (strings blanked, comments dropped) so a help string mentioning console.log is not flagged.
    test: ({ path, code }) =>
      !isTestPath(path) && !isMarkupOrDoc(path) && !isCliPath(path) &&
      (/\bconsole\.(log|debug|dir|trace)\s*\(/.test(code) ||
       /^\s*debugger\s*;?\s*$/.test(code) ||
       /\bdbg!\s*\(/.test(code) ||
       /\bbinding\.pry\b/.test(code) ||
       /\bvar_dump\s*\(/.test(code)),
  },
  {
    id: "disabled-test",
    axis: AXIS.LIES,
    severity: SEVERITY.BLOCK,
    why: "A skipped or focused test hides a failure and silently narrows the suite. Fix it or delete it, and say so.",
    test: ({ code }) =>
      /\b(it|test|describe|context)\.(only|skip)\s*\(/.test(code) ||
      /\b(xit|xdescribe|xtest|fit|fdescribe)\s*\(/.test(code) ||
      /\bt\.skip\s*\(/.test(code) ||
      /@(pytest\.mark\.)?skip\b/.test(code),
  },
  {
    id: "weakened-check",
    axis: AXIS.LIES,
    severity: SEVERITY.BLOCK,
    why: "This disables a safety check rather than satisfying it. Escalate the failure instead of silencing it.",
    // Raw text on purpose: most of these live in comments and CI directives, which the code view
    // strips. Markup/docs are excluded — prose *describing* a forbidden pattern cannot disable
    // anything, and flagging documentation is exactly the false positive that erodes trust.
    test: ({ path, text }) =>
      !isMarkupOrDoc(path) && (
      /\|\|\s*true\b/.test(text) ||
      /continue-on-error\s*:\s*true/.test(text) ||
      /--no-verify\b/.test(text) ||
      /@ts-(ignore|nocheck)\b/.test(text) ||
      /eslint-disable(?!-next-line\s+\S+\s*--\s*\S)/.test(text) ||
      /#\s*noqa(?!:)/.test(text) ||
      /\bpush\s+--force\b(?!-with-lease)/.test(text)),
  },
  {
    id: "placeholder",
    axis: AXIS.LIES,
    severity: SEVERITY.BLOCK,
    why: "Placeholder content presented as finished work. Implement it, or report the stub explicitly.",
    test: ({ path, text }) =>
      /lorem ipsum/i.test(text) ||
      (!isMarkupOrDoc(path) && /\b(TODO|FIXME)\b\s*:?\s*(implement|actually|real|proper|later|handle)/i.test(text)) ||
      /throw new Error\(\s*['"`](not implemented|unimplemented|TODO)/i.test(text) ||
      /\braise NotImplementedError\b/.test(text) ||
      /\bYOUR_[A-Z_]+_HERE\b/.test(text) ||
      /\bexample\.com\/api\b/.test(text),
  },
  {
    id: "commented-code",
    axis: AXIS.NOISE,
    severity: SEVERITY.WARN,
    why: "Commented-out code is dead weight the next reader must decode. Version control already remembers it.",
    test: ({ path, text }) => {
      if (isMarkupOrDoc(path)) return false;
      const m = /^\s*(?:\/\/|#)\s*(.+)$/.exec(text);
      if (!m) return false;
      const body = m[1].trim();
      // Looks like code, not prose: ends in a statement terminator or contains code punctuation.
      return body.length > 3 && /[;{}]$|\)\s*[;{]?$|^\s*(if|for|while|return|const|let|var|function|def|class|import|export)\b/.test(body);
    },
  },
  {
    id: "any-escape",
    axis: AXIS.LIES,
    severity: SEVERITY.WARN,
    why: "An `any` escape hatch removes the type safety the project chose to pay for.",
    test: ({ path, text }) => /\.[cm]?tsx?$/i.test(path) && /:\s*any\b|\bas\s+any\b/.test(text),
  },
  {
    id: "empty-catch",
    axis: AXIS.LIES,
    severity: SEVERITY.WARN,
    why: "A swallowed error turns a failure into silent wrong behaviour — the hardest kind to diagnose.",
    test: ({ text }) => /catch\s*(\([^)]*\))?\s*\{\s*\}/.test(text) || /except\s*:\s*pass\b/.test(text),
  },
  {
    id: "trailing-whitespace",
    axis: AXIS.NOISE,
    severity: SEVERITY.WARN,
    why: "Trailing whitespace creates diff noise in every later change to the same line.",
    test: ({ path, text }) => !isMarkupOrDoc(path) && /\S[ \t]+$/.test(text),
  },
  {
    id: "redundant-comment",
    axis: AXIS.NOISE,
    severity: SEVERITY.WARN,
    why: "The comment restates the code beneath it. A comment should say WHY, not repeat WHAT.",
    // Needs the following line, so this is a block rule: compare the comment's words against the
    // identifiers on the next line. Heavy overlap means it carries no new information.
    test: ({ path, text, next }) => {
      if (isMarkupOrDoc(path) || !next) return false;
      const m = /^\s*(?:\/\/|#|\*)\s*(.+)$/.exec(text);
      if (!m) return false;
      const words = m[1].toLowerCase().match(/[a-z]{3,}/g) ?? [];
      if (words.length < 2 || words.length > 10) return false;
      const ids = (next.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
        .flatMap((t) => t.split(/_|(?=[A-Z])/))
        .map((t) => t.toLowerCase())
        .filter((t) => t.length >= 3);
      if (!ids.length) return false;
      const overlap = words.filter((w) => ids.includes(w)).length;
      return overlap / words.length >= 0.6;
    },
  },
  {
    id: "hedging-comment",
    axis: AXIS.LIES,
    severity: SEVERITY.WARN,
    why: "A hedging comment admits the code is unverified. Verify it and state the reason, or escalate the uncertainty.",
    test: ({ path, text }) =>
      /^\s*(?:\/\/|#|\*)/.test(text) && !isMarkupOrDoc(path) &&
      /\b(should work|probably|not sure|hopefully|i think|might need|for now|assuming this|hacky|magic number)\b/i.test(text),
  },
  {
    id: "pointless-catch",
    axis: AXIS.LIES,
    severity: SEVERITY.WARN,
    why: "This catch only logs and rethrows, adding a stack layer and a duplicate log without handling anything.",
    test: ({ text, block }) => {
      if (!/\bcatch\s*(\([^)]*\))?\s*\{/.test(text)) return false;
      const body = (block ?? []).join("\n");
      const logs = /console\.(error|warn|log)\s*\(|logger?\.\w+\s*\(/.test(body);
      const rethrows = /\bthrow\b/.test(body);
      const doesMore = /\b(return|await|retry|fallback|recover|res\.|reply\.)/.test(body.replace(/\bthrow\b.*/g, ""));
      return logs && rethrows && !doesMore;
    },
  },
  {
    id: "async-no-await",
    axis: AXIS.TASTE,
    severity: SEVERITY.WARN,
    why: "An async function with no await returns a needless promise — a sign the signature was copied rather than chosen.",
    // Only fires when the ENTIRE body is visible and brace-balanced. With a fixed lookahead window
    // this rule flagged every long async function whose first await came later — 30 false positives
    // when audited against this repository. An unproven suspicion must stay silent.
    test: ({ text, blockLong }) => {
      if (!/\basync\b/.test(text)) return false;
      if (!/\{\s*$/.test(text)) return false;
      const body = balancedBody(text, blockLong ?? []);
      if (body === null) return false;          // body not fully visible: say nothing
      if (!body.trim()) return false;
      if (/\bfor\s+await\b|\byield\b|\bawait\b/.test(body)) return false;
      return true;
    },
  },
  {
    id: "reinvented-platform",
    axis: AXIS.TASTE,
    severity: SEVERITY.WARN,
    // This is the "does it need to exist?" dimension. A hand-rolled utility the platform already
    // provides is the commonest form of AI over-building, and it passes every hygiene check because
    // the code itself is perfectly clean.
    why: "This reimplements something the platform already provides. Use the built-in: less code to own, test, and get wrong.",
    test: ({ path, code }) => {
      if (isMarkupOrDoc(path) || isTestPath(path)) return false;
      return REINVENTED.some((r) => r.pattern.test(code));
    },
    detail: ({ code }) => REINVENTED.find((r) => r.pattern.test(code))?.use ?? null,
  },
  {
    id: "hardcoded-secret",
    axis: AXIS.LIES,
    severity: SEVERITY.BLOCK,
    // Uses the RAW line: a secret lives inside a string literal, which the code view blanks.
    why: "A credential appears to be hardcoded. Move it to the environment or a secret store — committed secrets must be rotated, not just deleted.",
    test: ({ path, text }) => {
      if (isMarkupOrDoc(path)) return false;
      // Obvious provider-issued key shapes, plus assignment of a long opaque literal to a
      // secret-ish name. Placeholders are excluded so examples and templates do not fire.
      if (/\b(AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/.test(text)) return true;
      const m = /\b(api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*['"`]([^'"`]{12,})['"`]/i.exec(text);
      if (!m) return false;
      const value = m[2];
      if (/^(your|example|changeme|placeholder|xxx+|\.\.\.|<.*>|\$\{|process\.env|null|undefined|test|dummy|fake|redacted)/i.test(value)) return false;
      if (/^[A-Z_]+$/.test(value)) return false;           // looks like an env var name
      return /[0-9]/.test(value) && /[a-z]/i.test(value);   // opaque enough to be real
    },
  },
];

/**
 * Curated list of platform features people hand-roll. Deliberately short and high-confidence: a
 * false positive here is merely annoying, but a noisy rule gets the whole gate switched off.
 */
export const REINVENTED = [
  { pattern: /function\s+(deepClone|deepCopy)\b|const\s+(deepClone|deepCopy)\s*=/i, use: "structuredClone()" },
  { pattern: /function\s+(uuid|uuidv4|generateId|makeId|randomId)\b/i, use: "crypto.randomUUID()" },
  { pattern: /EMAIL_(RE|REGEX|PATTERN)\s*=\s*\//i, use: "a maintained validator — hand-written email regexes are famously wrong" },
  { pattern: /function\s+(parseQuery|parseQueryString|queryStringToObject)\b/i, use: "new URLSearchParams()" },
  { pattern: /function\s+(groupBy)\b/i, use: "Object.groupBy() / Map.groupBy()" },
  { pattern: /function\s+(flattenArray|flattenDeep)\b/i, use: "Array.prototype.flat()" },
  { pattern: /function\s+(isArray|isNull|isUndefined)\b/i, use: "Array.isArray() / a direct comparison" },
];

/**
 * Minimal glob matcher (`**`, `*`, `?`) so write-scope checking needs no dependency.
 *
 * Built as a SINGLE PASS over the pattern. A chain of `.replace()` calls is the obvious approach and
 * it is subtly wrong: the regex fragments one rule inserts (`.*`) get re-processed by the next rule
 * (`*` → `[^/]*`), silently corrupting the pattern. `**\/*.test.ts` stopped matching because of it.
 */
export function matchesGlob(path, pattern) {
  const p = String(path).replace(/\\/g, "/");
  const g = String(pattern).replace(/\\/g, "/");
  let rx = "";

  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === "*") {
      if (g[i + 1] === "*") {
        // `**/` matches any number of leading directories (including none); bare `**` matches all.
        if (g[i + 2] === "/") { rx += "(?:[^/]+/)*"; i += 2; }
        else { rx += ".*"; i += 1; }
      } else {
        rx += "[^/]*";
      }
      continue;
    }
    if (ch === "?") { rx += "[^/]"; continue; }
    rx += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${rx}$`).test(p);
}

/** Whitespace-only change: same content once whitespace is collapsed. */
const squash = (s) => s.replace(/\s+/g, "");

/**
 * True when `index` falls inside a string literal on this line.
 *
 * Needed because suppression syntax legitimately appears *as data* — in this tool's own tests, in its
 * help text, and in any documentation describing the feature. Treating those as real suppressions
 * produced nine false "stale suppression" reports when auditing this repository.
 */
export function insideStringLiteral(line, index) {
  const s = String(line ?? "");
  let quote = null;
  for (let i = 0; i < index && i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "/" && (s[i + 1] === "/" || s[i + 1] === "*")) return false; // a real comment starts here
  }
  return quote !== null;
}

/**
 * Parse an inline suppression: `// tightdiff-allow rule-id, other-rule — reason`
 *
 * A REASON IS MANDATORY. tightdiff blocks blanket `eslint-disable`, so it owes the codebase a
 * principled alternative rather than no escape hatch at all — but an unexplained suppression is how a
 * gate quietly rots. Google's experience with Tricorder is the cautionary case: unrestricted
 * customisation silenced feedback and hid real linter bugs, and only investigating the complaints
 * surfaced them. So a suppression here must say why, it is reported rather than hidden, and one that
 * silences nothing is reported as stale.
 *
 * Accepts `—`, `--`, or `:` as the separator before the reason.
 */
export function parseSuppression(line) {
  const s = String(line ?? "");
  const at = s.search(/tightdiff-allow/i);
  if (at < 0) return null;
  // Suppression syntax quoted as data (tests, docs, help text) is not a suppression.
  if (insideStringLiteral(s, at)) return null;

  const m = /tightdiff-allow\s+([a-z0-9-,*\s]+?)\s*(?:—|--|:)\s*(.+)$/i.exec(s);
  if (!m) return null;
  const reason = m[2].trim();
  if (reason.length < 8) return null; // "because" is not a reason
  return {
    rules: m[1].split(/[,\s]+/).map((r) => r.trim()).filter(Boolean),
    reason,
  };
}

/**
 * Analyze a unified diff.
 *
 * @param {string} diffText output of `git diff` (any unified diff)
 * @param {object} opts
 *  - limits     override DEFAULT_LIMITS
 *  - writeScope array of globs this change is allowed to touch (e.g. a persona's lanes)
 *  - allow      rule ids to downgrade to warn (project escape hatch, recorded in the report)
 * @returns {{ ok, findings, stats, blocking, warnings, summary }}
 */
export function analyze(diffText, { limits = {}, writeScope = null, allow = [] } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const allowed = new Set(allow);
  const files = parseDiff(diffText);
  const findings = [];

  const add = (f) => {
    const severity = allowed.has(f.rule) ? SEVERITY.WARN : f.severity;
    findings.push({ ...f, severity, allowlisted: allowed.has(f.rule) });
  };

  let addedTotal = 0;
  let removedTotal = 0;
  const addedBlocks = new Map();
  const suppressed = [];
  const staleSuppressions = [];
  const usedSuppressions = new Set();

  for (const file of files) {
    addedTotal += file.added.length;
    removedTotal += file.removed.length;

    if (file.binary || file.isDeleted) continue;

    // --- whole-file checks -----------------------------------------------------------------
    if (writeScope?.length && !writeScope.some((g) => matchesGlob(file.path, g))) {
      add({
        rule: "out-of-scope", severity: SEVERITY.BLOCK, file: file.path, line: null,
        why: `Outside the declared write scope. In a parallel run this is how agents overwrite each other.`,
        evidence: `allowed: ${writeScope.join(", ")}`,
      });
    }
    if (isGeneratedPath(file.path) && !isLockfile(file.path)) {
      add({
        rule: "generated-committed", severity: SEVERITY.BLOCK, file: file.path, line: null,
        why: "Build output or vendored code committed. Generate it, do not track it.", evidence: null,
      });
    }
    if (file.added.length > lim.maxAddedLinesPerFile) {
      add({
        rule: "file-too-large", severity: SEVERITY.WARN, file: file.path, line: null,
        why: `${file.added.length} lines added to one file (limit ${lim.maxAddedLinesPerFile}). Consider splitting the change.`,
        evidence: null,
      });
    }

    // Reformat churn: lines that changed only in whitespace.
    const removedSquashed = new Set(file.removed.map((r) => squash(r.text)).filter(Boolean));
    let churn = 0;
    for (const a of file.added) {
      const s = squash(a.text);
      if (s && removedSquashed.has(s) && !file.removed.some((r) => r.text === a.text)) churn++;
    }
    if (churn >= 5) {
      add({
        rule: "reformat-churn", severity: SEVERITY.WARN, file: file.path, line: null,
        why: `${churn} lines changed only in whitespace/formatting. Drive-by reformatting hides the real change.`,
        evidence: null,
      });
    }

    if (/(^|[\\/])package\.json$/.test(file.path)) {
      for (const a of file.added) {
        if (/^\s*"[^"]+"\s*:\s*"[~^]?\d|^\s*"[^"]+"\s*:\s*"(?:npm|git|file|workspace):/.test(a.text)) {
          add({
            rule: "dependency-added", severity: SEVERITY.WARN, file: file.path, line: a.line,
            why: "A dependency was added. Confirm the platform cannot already do this.",
            evidence: a.text.trim().slice(0, 120),
          });
        }
      }
    }

    // --- per-line rules --------------------------------------------------------------------
    // Some rules need context beyond one line: `next` is the following added line (for comments
    // that restate the code below), and `block` is the following window (for catch bodies and
    // function bodies). Both come from ADDED lines only, so a rule can never be fooled by
    // surrounding code it cannot see in the diff.
    const addedText = file.added.map((a) => a.text);
    const addedCode = addedText.map(codeView);
    for (const [i, a] of file.added.entries()) {
      const ctx = {
        path: file.path,
        text: a.text,
        code: addedCode[i],
        next: addedText[i + 1] ?? null,
        block: addedText.slice(i + 1, i + 8),
        blockLong: addedText.slice(i + 1, i + 400),
      };
      // A justified inline suppression on this line or the one above it.
      const suppression = parseSuppression(a.text) ?? parseSuppression(addedText[i - 1] ?? "");
      for (const rule of RULES) {
        if (!rule.test(ctx)) continue;
        const extra = rule.detail?.(ctx) ?? null;

        if (suppression && (suppression.rules.includes(rule.id) || suppression.rules.includes("*"))) {
          usedSuppressions.add(`${file.path}:${a.line}:${rule.id}`);
          suppressed.push({
            rule: rule.id, axis: rule.axis ?? null, file: file.path, line: a.line,
            reason: suppression.reason, evidence: a.text.trim().slice(0, 120),
          });
          continue;
        }

        add({
          rule: rule.id,
          axis: rule.axis ?? null,
          severity: rule.severity,
          file: file.path,
          line: a.line,
          why: extra ? `${rule.why} (${extra})` : rule.why,
          evidence: a.text.trim().slice(0, 120),
        });
      }

      // A suppression that silenced nothing. Empirical work (FSE 2025) found over half of all
      // suppressions in real projects suppress no warning at all — they are stale comments that
      // create a false sense of coverage. Reporting them keeps the escape hatch honest.
      if (suppression && parseSuppression(a.text) && !RULES.some((r) => r.test(ctx) && (suppression.rules.includes(r.id) || suppression.rules.includes("*")))) {
        staleSuppressions.push({ file: file.path, line: a.line, rules: suppression.rules, reason: suppression.reason });
      }
    }

    // Duplicate added blocks (copy-paste), tracked across the whole change.
    const meaningful = file.added.map((a) => a.text).filter((t) => t.trim().length > 8);
    for (let i = 0; i + lim.minDuplicateBlock <= meaningful.length; i++) {
      const key = meaningful.slice(i, i + lim.minDuplicateBlock).map((s) => s.trim()).join("\n");
      const seen = addedBlocks.get(key);
      if (seen && seen.file !== `${file.path}:${i}`) {
        add({
          rule: "duplicate-block", severity: SEVERITY.WARN, file: file.path, line: file.added[i]?.line ?? null,
          why: `A block of ${lim.minDuplicateBlock}+ identical lines also appears in ${seen.path}. Extract it instead of copying.`,
          evidence: null,
        });
        break;
      }
      addedBlocks.set(key, { path: file.path, file: `${file.path}:${i}` });
    }
  }

  // --- whole-change size checks --------------------------------------------------------------
  const changed = addedTotal + removedTotal;
  if (changed > lim.maxChangedLines) {
    add({
      rule: "oversized-change", severity: SEVERITY.WARN, file: null, line: null,
      why: `${changed} lines changed (limit ${lim.maxChangedLines}). A change this large is hard to review and usually bundles unrelated work.`,
      evidence: null,
    });
  }
  if (files.length > lim.maxFilesTouched) {
    add({
      rule: "too-many-files", severity: SEVERITY.WARN, file: null, line: null,
      why: `${files.length} files touched (limit ${lim.maxFilesTouched}).`, evidence: null,
    });
  }

  const blocking = findings.filter((f) => f.severity === SEVERITY.BLOCK);
  const warnings = findings.filter((f) => f.severity === SEVERITY.WARN);
  const stats = {
    files: files.length,
    added: addedTotal,
    removed: removedTotal,
    changed,
    ruleCounts: findings.reduce((acc, f) => ({ ...acc, [f.rule]: (acc[f.rule] ?? 0) + 1 }), {}),
    // Per-axis counts: which KIND of slop this change carries. A change clean on noise but heavy on
    // lies is a very different problem from the reverse, and a flat total hides that.
    axisCounts: findings.reduce((acc, f) => (f.axis ? { ...acc, [f.axis]: (acc[f.axis] ?? 0) + 1 } : acc), {}),
  };

  return {
    ok: blocking.length === 0,
    findings, blocking, warnings, stats,
    // Suppressions are part of the report, never invisible: a silenced finding is a decision someone
    // made, and a suppression that silences nothing is itself a defect.
    suppressed,
    staleSuppressions,
    summary: blocking.length === 0
      ? `tightdiff: clean — ${stats.changed} lines across ${stats.files} file(s)${warnings.length ? `, ${warnings.length} warning(s)` : ""}${suppressed.length ? `, ${suppressed.length} suppressed` : ""}.`
      : `tightdiff: ${blocking.length} blocking issue(s) in ${stats.changed} changed lines — ${[...new Set(blocking.map((b) => b.rule))].join(", ")}.`,
  };
}

/** Human-readable report. Grouped by file so a reviewer can act on it directly. */
export function formatReport(result, { color = false } = {}) {
  if (!result) return "tightdiff: nothing to report";
  const c = (code, s) => (color ? `\u001b[${code}m${s}\u001b[0m` : s);
  const L = [];

  if (!result.findings.length) {
    const lines = [c(32, `✓ ${result.summary}`)];
    appendSuppressionNotes(lines, result, c);
    return lines.join("\n");
  }

  const byFile = new Map();
  for (const f of result.findings) {
    const key = f.file ?? "(whole change)";
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(f);
  }

  for (const [file, items] of byFile) {
    L.push(c(1, file));
    for (const f of items) {
      const tag = f.severity === SEVERITY.BLOCK ? c(31, "BLOCK") : c(33, "warn ");
      const at = f.line ? `:${f.line}` : "";
      L.push(`  ${tag} ${c(36, f.rule)}${at}  ${f.why}${f.allowlisted ? " (allowlisted → warn)" : ""}`);
      if (f.evidence) L.push(`        ${c(90, f.evidence)}`);
    }
    L.push("");
  }

  L.push(result.ok ? c(32, `✓ ${result.summary}`) : c(31, `✗ ${result.summary}`));
  appendSuppressionNotes(L, result, c);
  if (!result.ok) {
    L.push("");
    L.push("Fix the blocking items, or escalate the underlying failure — do not silence the check.");
  }
  return L.join("\n");
}

/**
 * Suppressions and stale suppressions always appear in the report. Hiding them is how a gate decays
 * into decoration: the findings stop appearing and nobody remembers why.
 */
function appendSuppressionNotes(L, result, c) {
  if (result.suppressed?.length) {
    L.push("");
    L.push(c(90, `${result.suppressed.length} finding(s) suppressed with a stated reason:`));
    for (const s of result.suppressed) {
      L.push(c(90, `  ${s.file}:${s.line} ${s.rule} — ${s.reason}`));
    }
  }
  if (result.staleSuppressions?.length) {
    L.push("");
    L.push(c(33, `${result.staleSuppressions.length} STALE suppression(s) — they silence nothing and should be deleted:`));
    for (const s of result.staleSuppressions) {
      L.push(c(33, `  ${s.file}:${s.line} allows ${s.rules.join(", ")} but nothing fired there`));
    }
  }
}

/** Machine-readable report for CI and dashboards. */
export function toJson(result) {
  return JSON.stringify(
    {
      ok: result.ok,
      summary: result.summary,
      stats: result.stats,
      findings: result.findings,
      suppressed: result.suppressed ?? [],
      staleSuppressions: result.staleSuppressions ?? [],
    },
    null,
    2,
  );
}

// --- whole-file analysis (audit mode) -------------------------------------------------------
//
// A diff only shows what changed, so slop that already exists is invisible to it. Audit mode reads
// whole files, which also makes two checks possible that a diff simply cannot support: an import that
// is never used, and an import of a file that does not exist.

/**
 * Rules that need the whole file rather than a line. Kept separate from RULES because they have a
 * different signature and only run in audit mode.
 *
 * `fileExists` is injected so this stays pure and testable — the core never touches the filesystem.
 */
export const WHOLE_FILE_RULES = [
  {
    id: "missing-module",
    axis: AXIS.LIES,
    severity: SEVERITY.BLOCK,
    why: "This imports a file that does not exist. The code cannot run — a hallucinated or stale import path.",
    scan: ({ path, lines, fileExists }) => {
      if (!fileExists || !/\.[cm]?[jt]sx?$/i.test(path)) return [];
      const out = [];
      for (const [i, raw] of lines.entries()) {
        const line = codeView(raw);
        const m = /\b(?:from|require\s*\(|import\s*\()\s*['"](\.[^'"]*)['"]/.exec(line);
        if (!m) continue;
        if (!fileExists(path, m[1])) {
          out.push({ line: i + 1, evidence: raw.trim().slice(0, 120), detail: m[1] });
        }
      }
      return out;
    },
  },
  {
    id: "unused-import",
    axis: AXIS.NOISE,
    severity: SEVERITY.WARN,
    why: "This import is never used — dead weight left behind by a refactor.",
    scan: ({ path, lines }) => {
      if (!/\.[cm]?[jt]sx?$/i.test(path)) return [];
      const code = lines.map(codeView);
      const body = code.join("\n");
      const out = [];

      for (const [i, line] of code.entries()) {
        // Side-effect imports (`import "./styles.css"`) bind no name — nothing to be unused.
        if (/^\s*import\s+['"]/.test(line)) continue;
        const m = /^\s*import\s+(?:type\s+)?(.+?)\s+from\s+['"]/.exec(line);
        if (!m) continue;

        const names = m[1]
          .replace(/[{}]/g, " ")
          .split(",")
          .map((s) => s.trim().split(/\s+as\s+/i).pop().trim())
          .filter((s) => s && s !== "*" && /^[A-Za-z_$][\w$]*$/.test(s));

        for (const name of names) {
          // Count occurrences outside this import line. Re-exports count as usage.
          const rx = new RegExp(`\\b${name.replace(/[$]/g, "\\$")}\\b`, "g");
          const total = (body.match(rx) ?? []).length;
          const onThisLine = (line.match(rx) ?? []).length;
          if (total - onThisLine === 0) {
            out.push({ line: i + 1, evidence: line.trim().slice(0, 120), detail: name });
          }
        }
      }
      return out;
    },
  },
];

/**
 * Audit whole files.
 *
 * @param {Array<{path:string, content:string}>} files
 * @param {object} opts
 *  - fileExists  (fromPath, specifier) => boolean — enables `missing-module`
 *  - allow       rule ids to downgrade to warn
 *  - limits      override DEFAULT_LIMITS
 * @returns the same shape as `analyze`, so every consumer works unchanged
 */
export function auditFiles(files = [], { fileExists = null, allow = [], limits = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const allowed = new Set(allow);
  const findings = [];
  const suppressed = [];
  const staleSuppressions = [];

  const add = (f) => {
    const severity = allowed.has(f.rule) ? SEVERITY.WARN : f.severity;
    findings.push({ ...f, severity, allowlisted: allowed.has(f.rule) });
  };

  let scanned = 0;
  let lineCount = 0;

  for (const file of files) {
    if (!file?.path || typeof file.content !== "string") continue;
    if (isGeneratedPath(file.path) || isLockfile(file.path)) continue;
    scanned++;

    const lines = file.content.split(/\r?\n/);
    const code = lines.map(codeView);
    lineCount += lines.length;

    for (const [i, text] of lines.entries()) {
      const ctx = {
        path: file.path,
        text,
        code: code[i],
        next: lines[i + 1] ?? null,
        block: lines.slice(i + 1, i + 8),
        blockLong: lines.slice(i + 1, i + 400),
      };
      const suppression = parseSuppression(text) ?? parseSuppression(lines[i - 1] ?? "");
      let firedHere = false;

      for (const rule of RULES) {
        if (!rule.test(ctx)) continue;
        firedHere = true;
        const extra = rule.detail?.(ctx) ?? null;
        if (suppression && (suppression.rules.includes(rule.id) || suppression.rules.includes("*"))) {
          suppressed.push({ rule: rule.id, axis: rule.axis ?? null, file: file.path, line: i + 1, reason: suppression.reason, evidence: text.trim().slice(0, 120) });
          continue;
        }
        add({
          rule: rule.id, axis: rule.axis ?? null, severity: rule.severity,
          file: file.path, line: i + 1,
          why: extra ? `${rule.why} (${extra})` : rule.why,
          evidence: text.trim().slice(0, 120),
        });
      }
      if (parseSuppression(text) && !firedHere) {
        staleSuppressions.push({ file: file.path, line: i + 1, rules: suppression.rules, reason: suppression.reason });
      }
    }

    for (const rule of WHOLE_FILE_RULES) {
      for (const hit of rule.scan({ path: file.path, lines, fileExists })) {
        add({
          rule: rule.id, axis: rule.axis, severity: rule.severity,
          file: file.path, line: hit.line,
          why: hit.detail ? `${rule.why} (${hit.detail})` : rule.why,
          evidence: hit.evidence,
        });
      }
    }
  }

  const blocking = findings.filter((f) => f.severity === SEVERITY.BLOCK);
  const warnings = findings.filter((f) => f.severity === SEVERITY.WARN);
  const stats = {
    files: scanned,
    added: lineCount,
    removed: 0,
    changed: lineCount,
    mode: "audit",
    ruleCounts: findings.reduce((acc, f) => ({ ...acc, [f.rule]: (acc[f.rule] ?? 0) + 1 }), {}),
    axisCounts: findings.reduce((acc, f) => (f.axis ? { ...acc, [f.axis]: (acc[f.axis] ?? 0) + 1 } : acc), {}),
  };

  return {
    ok: blocking.length === 0,
    findings, blocking, warnings, stats, suppressed, staleSuppressions,
    summary: blocking.length === 0
      ? `tightdiff audit: clean — ${scanned} file(s), ${lineCount.toLocaleString()} lines${warnings.length ? `, ${warnings.length} warning(s)` : ""}.`
      : `tightdiff audit: ${blocking.length} blocking issue(s) across ${scanned} file(s) — ${[...new Set(blocking.map((b) => b.rule))].join(", ")}.`,
  };
}

// --- baseline -------------------------------------------------------------------------------
//
// The documented failure mode for introducing a gate to an existing codebase: it reports thousands of
// pre-existing findings, nobody can act on them, and the gate gets switched off. The remedy is a
// baseline — record what is already there, then fail only on what is NEW.
//
// The important design choice is the fingerprint. Keying on the line number would invalidate the
// baseline every time someone inserts a line above a finding, which makes it useless within a day.
// So a fingerprint is (file + rule + normalised evidence): stable under line shifts, and still
// distinct enough that a genuinely new occurrence does not match an old one.

/** Stable identity for a finding, independent of its line number. */
export function fingerprint(finding) {
  const evidence = String(finding.evidence ?? "")
    .replace(/\s+/g, " ")
    .replace(/['"`][^'"`]*['"`]/g, "S")   // literal contents vary without changing the defect
    .replace(/\b\d+\b/g, "N")
    .trim();
  return `${finding.file ?? "-"}|${finding.rule}|${evidence}`;
}

/** Build a baseline from a result. Store it in the repo so the whole team shares one. */
export function makeBaseline(result, { note = "" } = {}) {
  const counts = {};
  for (const f of result.findings) {
    const k = fingerprint(f);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    note,
    total: result.findings.length,
    // Counts, not just presence: three copies of a defect baselined then a fourth added is still new.
    fingerprints: counts,
  };
}

/**
 * Filter a result against a baseline. Baselined findings move to `baselined` and stop blocking; only
 * new ones remain. Also reports how many baselined findings have since been FIXED, so the baseline can
 * be tightened rather than living forever.
 */
export function applyBaseline(result, baseline) {
  if (!baseline?.fingerprints) return { ...result, baselined: [], fixedSinceBaseline: 0 };

  const remaining = { ...baseline.fingerprints };
  const isNew = [];
  const baselined = [];

  for (const f of result.findings) {
    const k = fingerprint(f);
    if (remaining[k] > 0) { remaining[k]--; baselined.push(f); }
    else isNew.push(f);
  }

  const fixedSinceBaseline = Object.values(remaining).reduce((n, v) => n + v, 0);
  const blocking = isNew.filter((f) => f.severity === SEVERITY.BLOCK);
  const warnings = isNew.filter((f) => f.severity === SEVERITY.WARN);

  return {
    ...result,
    ok: blocking.length === 0,
    findings: isNew,
    blocking,
    warnings,
    baselined,
    fixedSinceBaseline,
    stats: { ...result.stats, baselined: baselined.length, fixedSinceBaseline },
    summary: blocking.length === 0
      ? `tightdiff: no NEW blocking issues (${baselined.length} baselined${fixedSinceBaseline ? `, ${fixedSinceBaseline} since fixed — tighten the baseline` : ""})${warnings.length ? `, ${warnings.length} new warning(s)` : ""}.`
      : `tightdiff: ${blocking.length} NEW blocking issue(s) — ${[...new Set(blocking.map((b) => b.rule))].join(", ")}. (${baselined.length} pre-existing, not counted.)`,
  };
}
