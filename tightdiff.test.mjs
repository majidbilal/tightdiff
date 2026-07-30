import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiff, analyze, matchesGlob, formatReport, toJson, RULES, SEVERITY, AXIS, REINVENTED, codeView, parseSuppression, auditFiles } from "./index.mjs";

/** Build a unified diff for one file from its added lines. */
function diffFor(path, added = [], removed = []) {
  return [
    `diff --git a/${path} b/${path}`,
    "index 1111111..2222222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${Math.max(removed.length, 1)} +1,${Math.max(added.length, 1)} @@`,
    ...removed.map((l) => `-${l}`),
    ...added.map((l) => `+${l}`),
  ].join("\n");
}

const rulesHit = (res) => [...new Set(res.findings.map((f) => f.rule))];

test("parseDiff extracts files, added lines, and real line numbers", () => {
  const files = parseDiff(diffFor("src/app.ts", ["const a = 1;", "const b = 2;"], ["const old = 0;"]));
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/app.ts");
  assert.equal(files[0].added.length, 2);
  assert.equal(files[0].removed.length, 1);
  assert.equal(files[0].added[0].line, 1);
  assert.equal(files[0].added[1].line, 2);
});

test("parseDiff tolerates renames, new files, binaries, and odd markers without throwing", () => {
  const odd = [
    "diff --git a/old.png b/new.png",
    "similarity index 90%",
    "rename from old.png",
    "rename to new.png",
    "Binary files a/old.png and b/new.png differ",
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,1 @@",
    "+export const x = 1;",
    "\\ No newline at end of file",
  ].join("\n");
  assert.doesNotThrow(() => parseDiff(odd));
  const files = parseDiff(odd);
  assert.equal(files.length, 2);
  assert.equal(files[0].binary, true);
  assert.equal(files[1].isNew, true);
  assert.equal(files[1].added.length, 1);
});

test("parseDiff on empty or garbage input returns no files", () => {
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff("not a diff at all"), []);
  assert.deepEqual(parseDiff(null), []);
});

// --- blocking rules -------------------------------------------------------------------------

test("debug leftovers BLOCK in source but are allowed in tests", () => {
  const src = analyze(diffFor("src/app.ts", ["  console.log('here');"]));
  assert.equal(src.ok, false);
  assert.ok(rulesHit(src).includes("debug-leftover"));

  const spec = analyze(diffFor("tests/app.test.ts", ["  console.log('debugging a test');"]));
  assert.ok(!rulesHit(spec).includes("debug-leftover"), "tests legitimately log");
});

test("a disabled or focused test BLOCKS", () => {
  for (const line of ["it.skip('x', () => {});", "describe.only('y', () => {});", "xit('z', () => {});"]) {
    const res = analyze(diffFor("tests/a.test.ts", [line]));
    assert.equal(res.ok, false, line);
    assert.ok(rulesHit(res).includes("disabled-test"), line);
  }
});

test("weakened checks BLOCK — this is the slop that makes CI lie", () => {
  const cases = [
    ["ci.yml", "    continue-on-error: true"],
    ["ci.yml", "        run: npm test || true"],
    ["src/a.ts", "// @ts-ignore"],
    ["hooks/pre-commit", "git commit --no-verify"],
  ];
  for (const [path, line] of cases) {
    const res = analyze(diffFor(path, [line]));
    assert.equal(res.ok, false, `${path}: ${line}`);
    assert.ok(rulesHit(res).includes("weakened-check"), `${path}: ${line}`);
  }
});

test("placeholders BLOCK, because they are how false completion happens", () => {
  for (const line of [
    "  const copy = 'Lorem ipsum dolor sit amet';",
    "  // TODO: implement the real calculation",
    "  throw new Error('not implemented');",
    "  raise NotImplementedError",
    "  const key = 'YOUR_API_KEY_HERE';",
  ]) {
    const res = analyze(diffFor("src/a.ts", [line]));
    assert.equal(res.ok, false, line);
    assert.ok(rulesHit(res).includes("placeholder"), line);
  }
});

test("out-of-scope files BLOCK when a write scope is declared", () => {
  const diff = diffFor("src/server/db.ts", ["const x = 1;"]);
  const scoped = analyze(diff, { writeScope: ["src/client/**", "src/ui/**"] });
  assert.equal(scoped.ok, false);
  const f = scoped.findings.find((x) => x.rule === "out-of-scope");
  assert.match(f.why, /parallel run/i, "the reason must explain why it matters");
  assert.match(f.evidence, /src\/client/);

  const inScope = analyze(diffFor("src/client/app.ts", ["const x = 1;"]), { writeScope: ["src/client/**"] });
  assert.equal(inScope.ok, true);
});

test("committed build output BLOCKS, but lockfiles are fine", () => {
  assert.equal(analyze(diffFor("dist/bundle.js", ["var a=1;"])).ok, false);
  assert.equal(analyze(diffFor("vendor/lib.min.js", ["var a=1;"])).ok, false);
  assert.equal(analyze(diffFor("package-lock.json", ['    "resolved": "https://x"'])).ok, true);
});

// --- warnings (must NOT block, so the gate stays trustworthy) --------------------------------

test("warnings never block", () => {
  const res = analyze(diffFor("src/a.ts", [
    "// const old = compute();",
    "  const v: any = payload;",
    "  try { risky(); } catch {}",
    "  const padded = 1;   ",
  ]));
  assert.equal(res.ok, true, "none of these are certain enough to block");
  const hit = rulesHit(res);
  for (const r of ["commented-code", "any-escape", "empty-catch", "trailing-whitespace"]) {
    assert.ok(hit.includes(r), `expected ${r}`);
  }
  assert.equal(res.blocking.length, 0);
  assert.ok(res.warnings.length >= 4);
});

test("prose comments are not mistaken for commented-out code", () => {
  const res = analyze(diffFor("src/a.ts", [
    "// This explains why the retry budget is three attempts",
    "# a plain sentence in a config file",
  ]));
  assert.ok(!rulesHit(res).includes("commented-code"), "explanatory comments are the good kind");
});

test("reformat churn is detected from whitespace-only rewrites", () => {
  const original = Array.from({ length: 8 }, (_, i) => `const value${i} = ${i};`);
  const reformatted = original.map((l) => `    ${l}`);
  const res = analyze(diffFor("src/a.ts", reformatted, original));
  assert.ok(rulesHit(res).includes("reformat-churn"));
});

test("added dependencies are flagged for justification", () => {
  const res = analyze(diffFor("package.json", ['    "left-pad": "^1.3.0",']));
  assert.ok(rulesHit(res).includes("dependency-added"));
  assert.equal(res.ok, true, "adding a dependency is a warning, not a block");
});

test("oversized changes and file sprawl are flagged", () => {
  const many = Array.from({ length: 500 }, (_, i) => `const x${i} = ${i};`);
  const res = analyze(diffFor("src/a.ts", many), { limits: { maxChangedLines: 100, maxAddedLinesPerFile: 100 } });
  const hit = rulesHit(res);
  assert.ok(hit.includes("oversized-change"));
  assert.ok(hit.includes("file-too-large"));
});

test("copy-pasted blocks are flagged across files", () => {
  const block = Array.from({ length: 8 }, (_, i) => `  const step${i} = doThing(${i});`);
  const res = analyze([diffFor("src/a.ts", block), diffFor("src/b.ts", block)].join("\n"));
  assert.ok(rulesHit(res).includes("duplicate-block"));
});

// --- configuration and reporting ------------------------------------------------------------

test("allowlisting downgrades a block to a warning and records that it did", () => {
  const diff = diffFor("src/a.ts", ["console.log('x');"]);
  assert.equal(analyze(diff).ok, false);
  const allowed = analyze(diff, { allow: ["debug-leftover"] });
  assert.equal(allowed.ok, true);
  const f = allowed.findings.find((x) => x.rule === "debug-leftover");
  assert.equal(f.severity, SEVERITY.WARN);
  assert.equal(f.allowlisted, true, "the escape hatch must be visible in the report");
});

test("stats describe the change honestly", () => {
  const res = analyze(diffFor("src/a.ts", ["a", "b", "c"], ["z"]));
  assert.equal(res.stats.added, 3);
  assert.equal(res.stats.removed, 1);
  assert.equal(res.stats.changed, 4);
  assert.equal(res.stats.files, 1);
});

test("a clean change passes with a clear summary", () => {
  const res = analyze(diffFor("src/a.ts", ["export const add = (a, b) => a + b;"]));
  assert.equal(res.ok, true);
  assert.match(res.summary, /clean/);
  assert.match(formatReport(res), /✓/);
});

test("the report names the rule, the file, the line, and why it matters", () => {
  const res = analyze(diffFor("src/a.ts", ["console.log('x');"]));
  const out = formatReport(res);
  assert.match(out, /src\/a\.ts/);
  assert.match(out, /BLOCK/);
  assert.match(out, /debug-leftover/);
  assert.match(out, /Debug output left in shipped code/);
  assert.match(out, /do not silence the check/i, "the fix must not be 'disable the rule'");
});

test("json output is machine-readable for CI", () => {
  const parsed = JSON.parse(toJson(analyze(diffFor("src/a.ts", ["console.log('x');"]))));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.findings[0].rule, "debug-leftover");
  assert.ok(parsed.stats.changed >= 1);
});

test("glob matching handles the patterns write scopes actually use", () => {
  assert.ok(matchesGlob("src/client/app.tsx", "src/client/**"));
  assert.ok(matchesGlob("src/a.test.ts", "**/*.test.ts"));
  assert.ok(matchesGlob("index.html", "index.html"));
  assert.ok(matchesGlob("src\\win\\path.ts", "src/win/**"), "windows separators must normalise");
  assert.ok(!matchesGlob("src/server/db.ts", "src/client/**"));
  assert.ok(!matchesGlob("src/deep/nested/a.ts", "src/*.ts"), "* must not cross a separator");
});

test("every rule declares an id, a severity, and a reason", () => {
  for (const r of RULES) {
    assert.ok(r.id && typeof r.test === "function", `${r.id} is malformed`);
    assert.ok([SEVERITY.BLOCK, SEVERITY.WARN].includes(r.severity), `${r.id} severity`);
    assert.ok(r.why?.length > 20, `${r.id} must explain why it matters, not just what it found`);
  }
});

// --- the three axes, and the "does it need to exist?" dimension ------------------------------

test("every rule declares which axis of slop it targets", () => {
  for (const r of RULES) {
    assert.ok(Object.values(AXIS).includes(r.axis), `${r.id} must declare a valid axis`);
  }
  // All three axes must be covered — a tool that only catches noise passes confidently-wrong code.
  const covered = new Set(RULES.map((r) => r.axis));
  for (const a of Object.values(AXIS)) assert.ok(covered.has(a), `no rule covers the "${a}" axis`);
});

test("findings and stats report the axis, so the KIND of slop is visible", () => {
  const res = analyze(diffFor("src/a.ts", [
    "  console.log('x');",          // noise
    "  // @ts-ignore",              // lies
    "function deepClone(o) {",      // taste
  ]));
  assert.ok(res.findings.every((f) => f.axis || f.rule.includes("-")), "line rules must carry an axis");
  assert.ok(res.stats.axisCounts.noise >= 1, JSON.stringify(res.stats.axisCounts));
  assert.ok(res.stats.axisCounts.lies >= 1);
  assert.ok(res.stats.axisCounts.taste >= 1);
});

test("reinvented platform features are caught with the built-in named", () => {
  const cases = [
    ["function deepClone(obj) {", /structuredClone/],
    ["function generateId() {", /randomUUID/],
    ["const EMAIL_REGEX = /^.+@.+$/;", /famously wrong/],
    ["function parseQueryString(s) {", /URLSearchParams/],
    ["function groupBy(arr, key) {", /groupBy/],
  ];
  for (const [line, expected] of cases) {
    const res = analyze(diffFor("src/util.ts", [line]));
    const f = res.findings.find((x) => x.rule === "reinvented-platform");
    assert.ok(f, `not detected: ${line}`);
    assert.match(f.why, expected, line);
    assert.equal(f.severity, SEVERITY.WARN, "over-building is a warning, not a block");
  }
});

test("reinvented-platform is not raised in tests or docs", () => {
  assert.ok(!rulesHit(analyze(diffFor("tests/u.test.ts", ["function deepClone(o) {"]))).includes("reinvented-platform"));
  assert.ok(!rulesHit(analyze(diffFor("README.md", ["function deepClone(o) {"]))).includes("reinvented-platform"));
});

test("a comment that restates the code below it is flagged", () => {
  const res = analyze(diffFor("src/a.ts", [
    "// get the user by id",
    "function getUserById(id) {",
  ]));
  assert.ok(rulesHit(res).includes("redundant-comment"));
});

test("a comment that explains WHY is not flagged", () => {
  const res = analyze(diffFor("src/a.ts", [
    "// Retry three times because the upstream rate-limits bursts of four",
    "function fetchUser(id) {",
  ]));
  assert.ok(!rulesHit(res).includes("redundant-comment"), "explanatory comments are the good kind");
});

test("hedging comments are flagged as unverified work", () => {
  for (const line of [
    "// this should work for most cases",
    "// probably fine, not sure about timezones",
    "// hacky but it works for now",
  ]) {
    assert.ok(rulesHit(analyze(diffFor("src/a.ts", [line]))).includes("hedging-comment"), line);
  }
});

test("a catch that only logs and rethrows is flagged", () => {
  const res = analyze(diffFor("src/a.ts", [
    "  } catch (err) {",
    "    console.error(err);",
    "    throw err;",
    "  }",
  ]));
  assert.ok(rulesHit(res).includes("pointless-catch"));
});

test("a catch that actually handles the failure is not flagged", () => {
  const res = analyze(diffFor("src/a.ts", [
    "  } catch (err) {",
    "    console.error(err);",
    "    return fallbackValue;",
    "  }",
  ]));
  assert.ok(!rulesHit(res).includes("pointless-catch"));
});

test("async with no await is flagged, but real async is not", () => {
  const pointless = analyze(diffFor("src/a.ts", [
    "async function loadConfig() {",
    "  return JSON.parse(raw);",
    "}",
  ]));
  assert.ok(rulesHit(pointless).includes("async-no-await"));

  const real = analyze(diffFor("src/a.ts", [
    "async function loadConfig() {",
    "  const raw = await readFile(path);",
    "  return JSON.parse(raw);",
    "}",
  ]));
  assert.ok(!rulesHit(real).includes("async-no-await"));
});

test("clean, well-written code triggers none of the new rules", () => {
  const res = analyze(diffFor("src/billing.ts", [
    "// Charges are idempotent because the provider retries on 5xx.",
    "export async function charge(orderId, amountCents) {",
    "  const key = `order:${orderId}`;",
    "  const existing = await store.get(key);",
    "  if (existing) return existing;",
    "  const receipt = await provider.charge({ amountCents, idempotencyKey: key });",
    "  await store.set(key, receipt);",
    "  return receipt;",
    "}",
  ]));
  assert.equal(res.ok, true, res.summary);
  assert.deepEqual(res.findings, [], `expected no findings, got ${rulesHit(res).join(", ")}`);
});

// --- false-positive reduction: the highest-value correctness work ---------------------------
// Empirical work finds FP rates above ~20-30% cause teams to abandon a tool. A rule that fires on
// prose inside a string is not a small annoyance — it is how the gate gets switched off.

test("codeView blanks string contents and drops trailing comments", () => {
  assert.equal(codeView(`const a = "hello";`).includes("hello"), false);
  assert.equal(codeView(`const a = 1; // console.log here`).includes("console.log"), false);
  assert.equal(codeView(`const a = 1;`), "const a = 1;");
  assert.ok(codeView(`const msg = "x";`).startsWith("const msg = "), "structure must survive");
  assert.equal(codeView(`this.#count = 1;`).includes("#count"), true, "a JS private field is not a comment");
  assert.equal(codeView(null), "");
});

test("debug patterns inside strings and comments are NOT flagged", () => {
  const res = analyze(diffFor("src/help.ts", [
    `const usage = "add console.log(x) to debug";`,
    `// remember to remove console.log calls before shipping`,
    `const tip = 'run with debugger attached';`,
  ]));
  assert.ok(!rulesHit(res).includes("debug-leftover"), `false positive: ${JSON.stringify(res.findings)}`);
  assert.equal(res.ok, true);
});

test("real debug calls are still caught alongside those strings", () => {
  const res = analyze(diffFor("src/help.ts", [
    `const usage = "add console.log(x) to debug";`,
    `console.log(usage);`,
  ]));
  const hits = res.findings.filter((f) => f.rule === "debug-leftover");
  assert.equal(hits.length, 1, "exactly the real one");
  assert.equal(hits[0].line, 2);
});

test("a doc string mentioning a silenced check is not a weakened check", () => {
  const res = analyze(diffFor("docs/policy.md", ["Never add @ts-ignore or continue-on-error: true."]));
  assert.equal(res.ok, true, "documentation about the rule must not trip the rule");
});

test("test-name strings containing skip patterns are not disabled tests", () => {
  const res = analyze(diffFor("tests/a.test.ts", [
    `it("does not use it.skip anywhere", () => {`,
  ]));
  assert.ok(!rulesHit(res).includes("disabled-test"), "the pattern is inside a string");
});

// --- secrets --------------------------------------------------------------------------------

test("hardcoded credentials BLOCK", () => {
  for (const line of [
    `const key = "AKIAIOSFODNN7EXAMPLE";`,
    `token = "ghp_aBcD1234567890aBcD1234567890aBcD"`,
    `apiKey: "sk-abc123def456ghi789jkl012mno345"`,
    `password = "Tr0ub4dor&3xample"`,
  ]) {
    const res = analyze(diffFor("src/config.ts", [line]));
    assert.equal(res.ok, false, line);
    assert.ok(rulesHit(res).includes("hardcoded-secret"), line);
  }
});

test("the secret finding says rotation is required, not just removal", () => {
  const res = analyze(diffFor("src/c.ts", [`const password = "Tr0ub4dor&3xample";`]));
  const f = res.findings.find((x) => x.rule === "hardcoded-secret");
  assert.match(f.why, /rotated/i, "a committed secret is compromised, not merely present");
});

test("placeholders, env lookups, and templates are NOT secrets", () => {
  for (const line of [
    `const key = process.env.API_KEY;`,
    `const key = "YOUR_API_KEY_HERE_XXXX";`,
    `apiKey: "<your-key-here>"`,
    `password = "changeme-placeholder"`,
    `token = "\${GITHUB_TOKEN}"`,
    `secret: "test-dummy-value"`,
  ]) {
    const res = analyze(diffFor("src/config.ts", [line]));
    assert.ok(!rulesHit(res).includes("hardcoded-secret"), `false positive: ${line}`);
  }
});

// --- suppressions ---------------------------------------------------------------------------

test("a suppression needs a real reason to count", () => {
  assert.equal(parseSuppression("// tightdiff-allow debug-leftover"), null, "no reason given");
  assert.equal(parseSuppression("// tightdiff-allow debug-leftover — meh"), null, "reason too short");
  const ok = parseSuppression("// tightdiff-allow debug-leftover — intentional CLI output for --verbose");
  assert.deepEqual(ok.rules, ["debug-leftover"]);
  assert.match(ok.reason, /intentional CLI output/);
  assert.ok(parseSuppression("// tightdiff-allow a, b: this is a stated reason").rules.length === 2);
});

test("a justified suppression silences the finding but is REPORTED", () => {
  const res = analyze(diffFor("src/banner.ts", [
    `console.log(banner); // tightdiff-allow debug-leftover — this is the CLI's actual output`,
  ]));
  assert.equal(res.ok, true, "the block is lifted");
  assert.equal(res.findings.length, 0);
  assert.equal(res.suppressed.length, 1);
  assert.equal(res.suppressed[0].rule, "debug-leftover");
  assert.match(res.suppressed[0].reason, /CLI's actual output/);
  assert.match(formatReport(res), /suppressed with a stated reason/, "it must never be invisible");
});

test("a suppression on the line above also applies", () => {
  const res = analyze(diffFor("src/banner.ts", [
    `// tightdiff-allow debug-leftover — deliberate CLI output on the next line`,
    `console.log(banner);`,
  ]));
  assert.equal(res.ok, true);
  assert.equal(res.suppressed.length, 1);
});

test("a suppression only silences the rules it names", () => {
  const res = analyze(diffFor("src/a.ts", [
    `console.log(x); // tightdiff-allow trailing-whitespace — unrelated rule named on purpose`,
  ]));
  assert.equal(res.ok, false, "debug-leftover was not suppressed");
  assert.ok(rulesHit(res).includes("debug-leftover"));
});

test("a suppression that silences nothing is reported as STALE", () => {
  // Over half of suppressions in real projects suppress no warning (FSE 2025). A stale suppression
  // creates a false sense of coverage, so it is surfaced rather than ignored.
  const res = analyze(diffFor("src/a.ts", [
    `const clean = 1; // tightdiff-allow debug-leftover — nothing actually fires on this line`,
  ]));
  assert.equal(res.staleSuppressions.length, 1);
  assert.deepEqual(res.staleSuppressions[0].rules, ["debug-leftover"]);
  assert.match(formatReport(res), /STALE suppression/);
  assert.match(formatReport(res), /should be deleted/);
});

test("json output carries suppressions for CI auditing", () => {
  const parsed = JSON.parse(toJson(analyze(diffFor("src/banner.ts", [
    `console.log(x); // tightdiff-allow debug-leftover — deliberate CLI output here`,
  ]))));
  assert.equal(parsed.suppressed.length, 1);
  assert.ok(Array.isArray(parsed.staleSuppressions));
});

test("missing-module actually detects a nonexistent relative import", () => {
  // Regression: this rule extracted the specifier from the CODE VIEW, which blanks string contents,
  // so the path was always whitespace and the rule silently never fired. It was disabled for its
  // entire existence until an MCP-level test noticed the finding was absent. Reading the specifier
  // from the raw line — while still confirming it is code, not a comment — is the fix.
  const files = [
    { path: "src/a.mjs", content: `import { real } from "./real.mjs";\nimport { ghost } from "./ghost.mjs";\n` },
  ];
  const exists = (from, spec) => spec === "./real.mjs";

  const res = auditFiles(files, { fileExists: exists });
  const hits = res.findings.filter((f) => f.rule === "missing-module");
  assert.equal(hits.length, 1, `expected exactly one missing module, got ${hits.length}`);
  assert.match(hits[0].why, /ghost\.mjs/);
  assert.equal(hits[0].line, 2);
  assert.equal(res.ok, false, "a hallucinated import must block");
});

test("missing-module ignores an import path mentioned in a comment", () => {
  const files = [{ path: "src/a.mjs", content: `// we removed: import { x } from "./gone.mjs"\nexport const v = 1;\n` }];
  const res = auditFiles(files, { fileExists: () => false });
  assert.equal(res.findings.filter((f) => f.rule === "missing-module").length, 0);
});

test("missing-module stays silent when no resolver is supplied", () => {
  // Without a filesystem there is no way to know, and guessing would invent hallucination reports.
  const files = [{ path: "src/a.mjs", content: `import { x } from "./nowhere.mjs";\n` }];
  const res = auditFiles(files, {});
  assert.equal(res.findings.filter((f) => f.rule === "missing-module").length, 0);
});
