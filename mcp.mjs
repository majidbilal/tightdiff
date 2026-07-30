#!/usr/bin/env node
// tightdiff MCP server — lets an AI agent check its own work before claiming it is done.
//
// Add to Claude Code / Cursor / Claude Desktop / Codex:
//   { "mcpServers": { "tightdiff": { "command": "npx", "args": ["-y", "-p", "tightdiff", "tightdiff-mcp"] } } }
//
// ── STATELESS BY DESIGN ───────────────────────────────────────────────────────────────────────
// Nothing is held between requests. `analyze` and `auditFiles` are pure functions over their inputs,
// so any process can serve any call and the server is safe to kill at any moment. Where a path is
// needed it is an explicit argument — the server never infers state from its own working directory.
//
// ── PROTOCOL ─────────────────────────────────────────────────────────────────────────────────
// JSON-RPC 2.0 over stdio, one message per line. Zero dependencies.
// Supports the pre-2026 `initialize` handshake AND the 2026-07-28 handshake-free model with
// `server/discover`, because shipping clients still use the former.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname, extname } from "node:path";
import { analyze, auditFiles, formatReport, RULES, WHOLE_FILE_RULES, DEFAULT_LIMITS } from "./index.mjs";

const NAME = "tightdiff";
const VERSION = "0.2.0";
const SUPPORTED = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const CAPABILITIES = { tools: { listChanged: false } };

const ALL_RULES = [...RULES, ...WHOLE_FILE_RULES];

const TOOLS = [
  {
    name: "check_diff",
    title: "Check a diff for slop",
    description:
      "Check a unified diff (git diff output) for problems that pass tests but should never ship: " +
      "debug logging, skipped tests, @ts-ignore, placeholder code, hardcoded secrets, committed build " +
      "output, and files outside an allowed scope. Run this on your own changes BEFORE reporting a " +
      "task complete. Returns blocking issues (must fix) and warnings (judgement).",
    inputSchema: {
      type: "object",
      properties: {
        diff: { type: "string", description: "Unified diff text, e.g. the output of `git diff`." },
        writeScope: {
          type: "array",
          items: { type: "string" },
          description: "Globs this change is allowed to touch, e.g. ['src/**']. Files outside them block.",
        },
        allow: {
          type: "array",
          items: { type: "string" },
          description: "Rule ids to downgrade to warnings. Recorded in the report, never hidden.",
        },
        maxChangedLines: { type: "integer", description: `Changed-line budget (default ${DEFAULT_LIMITS.maxChangedLines}).` },
      },
      required: ["diff"],
    },
  },
  {
    name: "check_files",
    title: "Check whole files for slop",
    description:
      "Check complete file contents rather than a diff. Use this when you have just written or " +
      "rewritten files and have no diff yet. Also enables checks a diff cannot support: unused " +
      "imports, and imports of files that do not exist (a hallucinated path).",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          description: "The files to check.",
          items: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path, used for language and location reporting." },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
        allow: { type: "array", items: { type: "string" }, description: "Rule ids to downgrade to warnings." },
      },
      required: ["files"],
    },
  },
  {
    name: "audit_repo",
    title: "Audit a whole project",
    description:
      "Scan an entire project directory for existing slop. Use this to understand a codebase you did " +
      "not write, or to check the result of a large change. Reports per-rule and per-axis counts.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Absolute path to the project directory." },
        allow: { type: "array", items: { type: "string" }, description: "Rule ids to downgrade to warnings." },
        maxFiles: { type: "integer", description: "Safety cap on files scanned (default 5000)." },
      },
      required: ["root"],
    },
  },
  {
    name: "list_rules",
    title: "List every rule",
    description:
      "List all rules with their severity, axis (noise / lies / taste), and the reason each exists. " +
      "Useful for understanding what will be checked before you write code.",
    inputSchema: { type: "object", properties: {} },
  },
];

// --- tool implementations -------------------------------------------------------------------

const text = (s) => ({ content: [{ type: "text", text: String(s) }] });
const failure = (s) => ({ content: [{ type: "text", text: String(s) }], isError: true });

/**
 * Render a result for an agent: the verdict first, so it can decide without parsing prose, then the
 * detail. `isError` is deliberately NOT set for a blocking result — findings are a successful answer
 * to the question asked, and marking them as errors invites hosts to hide them.
 */
function report(result) {
  const axis = Object.entries(result.stats.axisCounts ?? {}).map(([k, v]) => `${k}=${v}`).join(" ");
  const head = [
    result.ok ? "VERDICT: clean" : `VERDICT: ${result.blocking.length} blocking issue(s) — must fix`,
    `${result.stats.files} file(s), ${result.stats.changed} line(s)`,
    result.warnings.length ? `${result.warnings.length} warning(s)` : null,
    axis || null,
  ].filter(Boolean).join(" | ");
  return text(`${head}\n\n${formatReport(result)}`);
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", "vendor", ".next", ".nuxt", ".cache", ".venv", "__pycache__"]);
const SCAN_EXT = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".yml", ".yaml"]);

function collectFiles(root, maxFiles) {
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
        if (statSync(full).size > 1024 * 1024) continue;
        out.push({ path: relative(root, full).replace(/\\/g, "/"), content: readFileSync(full, "utf8") });
      } catch { /* unreadable file: skip rather than fail the audit */ }
    }
  };
  walk(root);
  return out;
}

/** Resolve relative imports against the real filesystem, powering the missing-module check. */
function makeFileExists(root) {
  const EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
  return (fromPath, specifier) => {
    const base = resolve(root, dirname(fromPath), specifier);
    for (const ext of EXTS) if (existsSync(base + ext)) return true;
    for (const ext of EXTS.slice(1)) if (existsSync(join(base, `index${ext}`))) return true;
    return false;
  };
}

const HANDLERS = {
  check_diff(args) {
    if (typeof args.diff !== "string") return failure("check_diff requires `diff` as a string (the output of `git diff`).");
    if (!args.diff.trim()) return text("VERDICT: clean | nothing to check (empty diff)");
    const limits = {};
    if (Number.isFinite(args.maxChangedLines)) limits.maxChangedLines = args.maxChangedLines;
    return report(analyze(args.diff, {
      limits,
      writeScope: Array.isArray(args.writeScope) && args.writeScope.length ? args.writeScope : null,
      allow: Array.isArray(args.allow) ? args.allow : [],
    }));
  },

  check_files(args) {
    if (!Array.isArray(args.files) || !args.files.length) return failure("check_files requires a non-empty `files` array of { path, content }.");
    const bad = args.files.find((f) => !f || typeof f.path !== "string" || typeof f.content !== "string");
    if (bad) return failure("Every entry in `files` needs a string `path` and string `content`.");
    // No fileExists: without a real project on disk, missing-module cannot be judged, and guessing
    // would produce false "hallucinated import" reports.
    return report(auditFiles(args.files, { allow: Array.isArray(args.allow) ? args.allow : [] }));
  },

  audit_repo(args) {
    if (typeof args.root !== "string" || !args.root) return failure("audit_repo requires `root`, an absolute path to the project.");
    if (!existsSync(args.root)) return failure(`No such directory: ${args.root}`);
    const files = collectFiles(args.root, Number.isFinite(args.maxFiles) ? args.maxFiles : 5000);
    if (!files.length) return text("VERDICT: clean | no scannable source files found");
    return report(auditFiles(files, {
      fileExists: makeFileExists(args.root),
      allow: Array.isArray(args.allow) ? args.allow : [],
    }));
  },

  list_rules() {
    const lines = ALL_RULES.map((r) => `${r.severity.toUpperCase().padEnd(5)} ${r.axis.padEnd(6)} ${r.id.padEnd(22)} ${r.why}`);
    return text(
      "Severity: BLOCK must be fixed, WARN is judgement.\n" +
      "Axis: noise = adds nothing, lies = looks finished but is not, taste = works but should not exist in this shape.\n\n" +
      `${lines.join("\n")}\n\n` +
      "Suppress with a stated reason on the line:  // tightdiff-allow <rule> — why\n" +
      "Suppressions appear in every report; one that silences nothing is reported as stale.",
    );
  },
};

// --- JSON-RPC ------------------------------------------------------------------------------

const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

/** Echo the client's protocol version when we support it, else advertise our newest. */
const negotiate = (requested) => (SUPPORTED.includes(requested) ? requested : SUPPORTED[0]);
const identity = { name: NAME, version: VERSION };

function handle(msg) {
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined || id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const error = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    // Pre-2026-07-28 handshake. Retained because every shipping client still uses it.
    case "initialize":
      return reply({ protocolVersion: negotiate(params.protocolVersion), capabilities: CAPABILITIES, serverInfo: identity });

    // Required by 2026-07-28, and used by clients as a stdio compatibility probe.
    case "server/discover":
      return reply({ protocolVersions: SUPPORTED, capabilities: CAPABILITIES, serverInfo: identity });

    case "ping":
      return reply({});

    case "tools/list":
      return reply({ tools: TOOLS });

    case "tools/call": {
      const handler = HANDLERS[params.name];
      if (!handler) return error(RPC.INVALID_PARAMS, `Unknown tool: ${params.name}`);
      try {
        return reply(handler(params.arguments ?? {}));
      } catch (e) {
        // A tool failing is a RESULT, not a transport error: the agent should see it and adapt,
        // and the server must stay up either way.
        return reply(failure(`tightdiff ${params.name} failed: ${e.message}`));
      }
    }

    // Empty lists rather than METHOD_NOT_FOUND: some clients probe these and log noisily.
    case "resources/list":
      return reply({ resources: [] });
    case "prompts/list":
      return reply({ prompts: [] });

    default:
      if (isNotification) return null;
      return error(RPC.METHOD_NOT_FOUND, `Unknown method: ${method}`);
  }
}

// --- stdio transport -----------------------------------------------------------------------

let buffer = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: RPC.PARSE_ERROR, message: "Invalid JSON" } });
      continue;
    }

    if (msg?.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      send({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: RPC.INVALID_REQUEST, message: "Not a JSON-RPC 2.0 request" } });
      continue;
    }

    try {
      const out = handle(msg);
      if (out) send(out);
    } catch (e) {
      send({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: RPC.INTERNAL, message: e.message } });
    }
  }
});

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// stdin closing means the host has detached. Deliberately NO `process.exit()` here: it does not wait
// for stdout to drain, so a large response gets truncated mid-message and the client receives
// unparseable JSON. With stdin ended and no work pending, Node exits on its own once stdout has flushed.
process.stdin.on("end", () => {
  process.exitCode = 0;
});
