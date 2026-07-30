import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "mcp.mjs");

/** One fresh process per call — if the server were stateful, reuse would hide it. */
function rpc(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve({ replies: out.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)), stderr: err });
      } catch {
        reject(new Error(`unparseable: ${out.slice(0, 300)} / ${err.slice(0, 300)}`));
      }
    });
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
    child.stdin.end();
  });
}

const req = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const call = (id, name, args) => req(id, "tools/call", { name, arguments: args });

const diffFor = (path, added) => [
  `diff --git a/${path} b/${path}`,
  "index 1111111..2222222 100644",
  `--- a/${path}`,
  `+++ b/${path}`,
  `@@ -1,1 +1,${added.length} @@`,
  ...added.map((l) => `+${l}`),
].join("\n");

// --- protocol --------------------------------------------------------------------------------

test("supports both handshake generations", async () => {
  const a = await rpc([req(1, "initialize", { protocolVersion: "2025-06-18" })]);
  assert.equal(a.replies[0].result.protocolVersion, "2025-06-18");
  assert.equal(a.replies[0].result.serverInfo.name, "tightdiff");

  const b = await rpc([req(1, "server/discover")]);
  assert.ok(b.replies[0].result.protocolVersions.includes("2026-07-28"));
});

test("works with no handshake at all", async () => {
  const { replies } = await rpc([call(1, "check_diff", { diff: diffFor("src/a.ts", ["const ok = 1;"]) })]);
  assert.match(replies[0].result.content[0].text, /VERDICT: clean/);
});

test("tools/list advertises every tool with an actionable description", async () => {
  const { replies } = await rpc([req(1, "tools/list")]);
  const tools = replies[0].result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(), ["audit_repo", "check_diff", "check_files", "list_rules"]);
  for (const t of tools) {
    assert.ok(t.description.length > 40, `${t.name} description too thin`);
    assert.equal(t.inputSchema.type, "object");
  }
});

// --- check_diff ------------------------------------------------------------------------------

test("check_diff blocks slop and leads with a verdict", async () => {
  const { replies } = await rpc([call(1, "check_diff", {
    diff: diffFor("src/a.ts", ["console.log('x');", "// @ts-ignore", "throw new Error('not implemented');"]),
  })]);
  const out = replies[0].result.content[0].text;
  assert.match(out, /^VERDICT: \d+ blocking issue\(s\) — must fix/m);
  assert.match(out, /debug-leftover/);
  assert.match(out, /weakened-check/);
  assert.match(out, /placeholder/);
  assert.match(out, /lies=/, "the axis breakdown should be visible");
  // Blocking findings are a successful ANSWER, not a transport failure.
  assert.ok(!replies[0].result.isError, "findings must not be flagged as an error");
});

test("check_diff passes clean code", async () => {
  const { replies } = await rpc([call(1, "check_diff", {
    diff: diffFor("src/a.ts", ["export const add = (a, b) => a + b;"]),
  })]);
  assert.match(replies[0].result.content[0].text, /VERDICT: clean/);
});

test("check_diff enforces a write scope", async () => {
  const { replies } = await rpc([call(1, "check_diff", {
    diff: diffFor("src/server/db.ts", ["const x = 1;"]),
    writeScope: ["src/client/**"],
  })]);
  assert.match(replies[0].result.content[0].text, /out-of-scope/);
});

test("check_diff allowlisting is honoured and visible", async () => {
  const { replies } = await rpc([call(1, "check_diff", {
    diff: diffFor("src/a.ts", ["console.log('x');"]),
    allow: ["debug-leftover"],
  })]);
  const out = replies[0].result.content[0].text;
  assert.match(out, /VERDICT: clean/);
  assert.match(out, /allowlisted/, "an escape hatch must stay visible in the report");
});

test("an empty diff is clean, not an error", async () => {
  const { replies } = await rpc([call(1, "check_diff", { diff: "   " })]);
  assert.match(replies[0].result.content[0].text, /VERDICT: clean/);
  assert.ok(!replies[0].result.isError);
});

// --- check_files -----------------------------------------------------------------------------

test("check_files works without a diff and finds unused imports", async () => {
  const { replies } = await rpc([call(1, "check_files", {
    files: [{ path: "src/a.ts", content: `import { unusedThing } from "./b.ts";\nexport const v = 1;\n` }],
  })]);
  assert.match(replies[0].result.content[0].text, /unused-import/);
});

test("check_files does not invent missing-module findings without a real project", async () => {
  // Judging a relative import needs the filesystem; guessing would produce false hallucination reports.
  const { replies } = await rpc([call(1, "check_files", {
    files: [{ path: "src/a.ts", content: `import { x } from "./nowhere.ts";\nexport const y = x;\n` }],
  })]);
  assert.ok(!/missing-module/.test(replies[0].result.content[0].text));
});

test("check_files validates its input shape", async () => {
  const { replies } = await rpc([
    call(1, "check_files", { files: [] }),
    call(2, "check_files", { files: [{ path: "a.ts" }] }),
  ]);
  assert.equal(replies[0].result.isError, true);
  assert.equal(replies[1].result.isError, true);
  assert.match(replies[1].result.content[0].text, /string `path` and string `content`/);
});

// --- audit_repo ------------------------------------------------------------------------------

test("audit_repo scans a real directory and finds a hallucinated import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "td-mcp-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "real.mjs"), "export const real = 1;\n");
    writeFileSync(join(dir, "src", "a.mjs"), `import { real } from "./real.mjs";\nimport { ghost } from "./ghost.mjs";\nexport const v = real + ghost;\n`);
    const { replies } = await rpc([call(1, "audit_repo", { root: dir })]);
    const out = replies[0].result.content[0].text;
    assert.match(out, /missing-module/);
    assert.match(out, /ghost\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit_repo reports a missing directory instead of throwing", async () => {
  const { replies } = await rpc([call(1, "audit_repo", { root: join(tmpdir(), "definitely-not-here-12345") })]);
  assert.equal(replies[0].result.isError, true);
  assert.match(replies[0].result.content[0].text, /No such directory/);
});

test("audit_repo requires a root", async () => {
  const { replies } = await rpc([call(1, "audit_repo", {})]);
  assert.equal(replies[0].result.isError, true);
});

// --- list_rules ------------------------------------------------------------------------------

test("list_rules explains severity, axis, and how to suppress", async () => {
  const { replies } = await rpc([req(1, "tools/list"), call(2, "list_rules", {})]);
  const out = replies[1].result.content[0].text;
  assert.match(out, /BLOCK/);
  assert.match(out, /noise/);
  assert.match(out, /lies/);
  assert.match(out, /taste/);
  assert.match(out, /debug-leftover/);
  assert.match(out, /tightdiff-allow/);
  assert.match(out, /stale/, "agents should know a useless suppression is reported");
});

// --- statelessness and robustness ------------------------------------------------------------

test("identical calls in separate processes give identical results", async () => {
  const d = diffFor("src/a.ts", ["console.log('x');", "const v: any = 1;"]);
  const a = await rpc([call(1, "check_diff", { diff: d })]);
  const b = await rpc([call(1, "check_diff", { diff: d })]);
  assert.equal(a.replies[0].result.content[0].text, b.replies[0].result.content[0].text);
});

test("errors keep the server serving", async () => {
  const { replies } = await rpc([
    call(1, "check_diff", {}),
    call(2, "nonsense", {}),
    req(3, "tools/list"),
  ]);
  assert.equal(replies[0].result.isError, true);
  assert.equal(replies[1].error.code, -32602);
  assert.equal(replies[2].result.tools.length, 4, "still alive");
});

test("malformed input does not take the server down", async () => {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stdin.write("not json\n");
  child.stdin.write(`${JSON.stringify(req(2, "tools/list"))}\n`);
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  const replies = out.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(replies[0].error.code, -32700);
  assert.equal(replies[1].result.tools.length, 4);
});

test("nothing is written to stderr during normal use", async () => {
  const { stderr } = await rpc([req(1, "tools/list"), call(2, "list_rules", {})]);
  assert.equal(stderr.trim(), "");
});
