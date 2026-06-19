#!/usr/bin/env node
// Stop-hook enforcer for the Claude Review Gate.
//
// Registered as a `Stop` hook in .claude/settings.json, this runs EVERY time the
// agent tries to finish a turn — the harness invokes it, not the model, so the
// review gate cannot be skipped or "forgotten".
//
//   no changes to review / diff already approved  -> allow the stop (exit 0)
//   changes present, gate APPROVES                -> record + clear, allow the stop
//   changes present, gate REQUESTS CHANGES        -> {"decision":"block", reason} so the
//                                                    revision prompt is fed back to Claude
//
// Scope: by default the review covers only the files Claude TOUCHED — a PostToolUse
// hook records each Edit/Write path in .git/review-gate-touched, and we diff just
// those (`git diff -- <paths>`). The list is cleared on approval, so each review is
// scoped to what changed since the last one. If that tracker file is absent (the
// PostToolUse hook never ran), we fall back to the whole working-tree diff so nothing
// slips through unreviewed.
//
// The diff is hashed and the last-approved hash is remembered under .git/, so an
// already-reviewed tree is NOT re-reviewed on later turns. Self-contained: only Node
// builtins + fetch, no dependency on dist/ or node_modules.
//
// Env:
//   REVIEW_GATE_PORT      gate port (default 7879; must match the extension)
//   REVIEW_GATE_REQUIRED  "1" => fail CLOSED if the gate is unreachable (block the
//                         stop until VS Code is up). Default fails OPEN with a warning.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

const PORT = parseInt(process.env.REVIEW_GATE_PORT || "7879", 10);
const BASE = `http://127.0.0.1:${PORT}`;
const REQUIRED = process.env.REVIEW_GATE_REQUIRED === "1";
const DEADLINE_MS = 30 * 60 * 1000; // give up waiting after 30m (also see hook timeout)

// Shared secret for the local gate. The extension writes it to ~/.claude/review-gate.token
// (mode 0600); env var overrides. Lets the gate reject blind localhost port-probes.
const TOKEN =
  process.env.REVIEW_GATE_TOKEN ||
  (() => {
    try { return readFileSync(join(homedir(), ".claude", "review-gate.token"), "utf8").trim(); }
    catch { return ""; }
  })();
const authHeaders = TOKEN ? { "X-Review-Gate-Token": TOKEN } : {};

/** Allow the stop. Optional non-blocking note shown to the user. */
function allow(note) {
  if (note) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "Stop", systemMessage: note },
    }));
  }
  process.exit(0);
}

/** Block the stop and feed `reason` back to Claude to act on. */
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

/** Absolute path to the repo's .git dir, or null if cwd isn't a git repo. */
function gitDir(cwd) {
  try {
    let g = git(cwd, ["rev-parse", "--git-dir"]).trim();
    if (!isAbsolute(g)) g = join(cwd, g);
    return g;
  } catch {
    return null;
  }
}

/** Repo-relative paths Claude touched this cycle, or null if no tracker file exists. */
function touchedPaths(cwd, gd) {
  let raw;
  try {
    raw = readFileSync(join(gd, "review-gate-touched"), "utf8");
  } catch {
    return null; // tracker absent → caller falls back to the whole tree
  }
  const set = new Set();
  for (const line of raw.split("\n")) {
    const p = line.trim();
    if (!p) continue;
    const rel = isAbsolute(p) ? relative(cwd, p) : p;
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue; // outside the repo
    set.add(rel);
  }
  return [...set];
}

/** The diff to review: scoped to Claude's touched files, else the whole tree. */
function reviewDiff(cwd, gd) {
  const touched = gd ? touchedPaths(cwd, gd) : null;
  if (touched === null) {
    // No tracker (PostToolUse hook never ran) → review everything. Safe default.
    try { git(cwd, ["add", "-N", "."]); } catch { /* not a repo */ }
    try { return git(cwd, ["diff"]); } catch { return ""; }
  }
  if (touched.length === 0) return ""; // tracker present, nothing touched → nothing to review
  try { git(cwd, ["add", "-N", "--", ...touched]); } catch { /* ignore */ }
  try { return git(cwd, ["diff", "--", ...touched]); } catch { return ""; }
}

function readFileOr(path, fallback) {
  try { return readFileSync(path, "utf8").trim(); } catch { return fallback; }
}

async function reachable() {
  try {
    const r = await fetch(`${BASE}/health`);
    return r.ok;
  } catch { return false; }
}

async function postReview(diff, cwd) {
  const r = await fetch(`${BASE}/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ diff, cwd, title: "Review gate (Stop hook)" }),
  });
  if (!r.ok) throw new Error(`gate POST /reviews -> ${r.status}`);
  return r.json();
}

async function pollFeedback(id) {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/reviews/${id}/feedback?wait=true`, { headers: { ...authHeaders } });
    if (r.status === 200) return r.json();
    // 202 == still pending (server long-polled ~25s); loop.
  }
  throw new Error("timed out waiting for human review");
}

/** Render structured feedback into a "revise only this" instruction (mirrors
 * src/gate/feedbackPrompt.ts; inlined to keep the hook dependency-free). */
function renderRevisionPrompt(fb) {
  if (fb.verdict === "approve") {
    let msg = "The human reviewer APPROVED this change. No revisions requested.";
    if (fb.summary) msg += `\n\nReviewer note:\n${fb.summary}`;
    return msg;
  }
  const parts = [
    "A human reviewer requested changes via the Review Gate.",
    "Revise the change to address ONLY the comments below. Do not make unrelated " +
      "edits, refactors, or cleanups — address each comment and nothing more.",
  ];
  if (fb.summary) parts.push(`\nReviewer summary:\n${fb.summary}`);
  parts.push("\nInline comments:");
  (fb.comments || []).forEach((c, i) => {
    parts.push(`\n${i + 1}. ${c.file}:${c.line} (${c.side} side)`);
    if (c.code_context) parts.push(c.code_context);
    parts.push(`   → ${c.body}`);
  });
  if (!fb.comments || fb.comments.length === 0) {
    parts.push("\n(no inline comments — see the reviewer summary above.)");
  }
  return parts.join("\n");
}

async function main() {
  const raw = (() => { try { return readFileSync(0, "utf8"); } catch { return ""; } })();
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch { /* tolerate */ }
  const cwd = input.cwd || process.cwd();
  const gd = gitDir(cwd);

  const diff = reviewDiff(cwd, gd);
  if (!diff.trim()) allow(); // nothing to review

  const hash = createHash("sha256").update(diff).digest("hex");
  const approvedHashFile = gd ? join(gd, "review-gate-approved-hash") : null;
  const touchedFile = gd ? join(gd, "review-gate-touched") : null;
  if (approvedHashFile && readFileOr(approvedHashFile, "") === hash) allow(); // already approved

  if (!(await reachable())) {
    const msg =
      `Review gate not reachable at ${BASE}. Open the project in VS Code with the ` +
      `Claude Review Gate extension active (it starts the gate automatically).`;
    if (REQUIRED) block(`${msg}\n\nReview is REQUIRED — start the gate, then continue.`);
    allow(`⚠ ${msg} Skipping review (set REVIEW_GATE_REQUIRED=1 to enforce).`);
  }

  const { id } = await postReview(diff, cwd);
  const fb = await pollFeedback(id);
  if (fb.verdict === "approve") {
    if (approvedHashFile) { try { writeFileSync(approvedHashFile, hash); } catch { /* best effort */ } }
    // Clear the touched-file scope so the next review covers only newly-changed files.
    if (touchedFile) { try { writeFileSync(touchedFile, ""); } catch { /* best effort */ } }
    allow(`✓ Review gate: approved (${id}).`);
  }
  block(renderRevisionPrompt(fb));
}

main().catch((e) => {
  // Never hard-fail the turn on an internal hook error unless review is required.
  if (REQUIRED) block(`Review-gate hook error: ${String(e?.message || e)}. Review is REQUIRED; resolve and continue.`);
  process.stderr.write(`[review-gate stop hook] ${String(e?.message || e)}\n`);
  process.exit(0); // fail open
});
