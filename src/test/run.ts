// Node tests for the vscode-independent core: diff parsing, code context,
// feedback rendering, and the gate server HTTP + long-poll loop.
// Run with: npm test  (after npm run compile)

import assert from "node:assert";
import { changedFiles, codeContext } from "../gate/diff.js";
import { buildDiffLineMap } from "../gate/diffDoc.js";
import { renderRevisionPrompt } from "../gate/feedbackPrompt.js";
import { GateServer } from "../gate/gateServer.js";
import { Feedback } from "../gate/types.js";

const DIFF = [
  "--- a/cart.py",
  "+++ b/cart.py",
  "@@ -1,2 +1,3 @@",
  " def last_item(items):",
  "-    return items[-1]",
  "+    # bug: off by one",
  "+    return items[len(items)]",
  "",
].join("\n");

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name);
  passed++;
  console.log("  ok -", name);
}

async function main(): Promise<void> {
  // --- diff parsing ---
  const files = changedFiles(DIFF);
  ok("one changed file", files.length === 1 && files[0].path === "cart.py");
  ok("tracks added new-side lines 2 and 3", files[0].newLines.includes(2) && files[0].newLines.includes(3));

  const cc = codeContext(DIFF, "cart.py", 3, "new");
  ok("code context anchors line 3", cc.includes(">     3:") && cc.includes("items[len(items)]"));
  ok("code context empty for unknown line", codeContext(DIFF, "cart.py", 999, "new") === "");

  // --- diff document line mapping (reviewer comments on the rendered diff) ---
  const map = buildDiffLineMap(DIFF);
  ok("line map aligns with diff lines", map.length === DIFF.split("\n").length);
  // DIFF lines: 0 "--- a", 1 "+++ b", 2 "@@", 3 ctx, 4 "-", 5 "+#bug", 6 "+return..."
  ok("header/hunk lines are not commentable", map[0] === null && map[1] === null && map[2] === null);
  ok("'+' line maps to new side", map[6]?.side === "new" && map[6]?.file === "cart.py" && map[6]?.line === 3);
  ok("'-' line maps to old side", map[4]?.side === "old");
  ok("context line maps to new side", map[3]?.side === "new" && map[3]?.line === 1);

  // --- feedback prompt ---
  const fb: Feedback = {
    reviewId: "r1", round: 2, verdict: "request_changes", summary: "fix off-by-one",
    comments: [{ file: "cart.py", line: 3, side: "new", body: "index out of range", code_context: cc }],
  };
  const prompt = renderRevisionPrompt(fb);
  ok("prompt is scoped", prompt.includes("ONLY") && prompt.includes("round 2"));
  ok("prompt anchors comment", prompt.includes("cart.py:3 (new side)") && prompt.includes("index out of range"));
  ok("approve prompt", renderRevisionPrompt({ ...fb, verdict: "approve", comments: [] }).includes("APPROVED"));

  // --- gate server: full HTTP loop ---
  let received: { id: string; round: number } | undefined;
  const server = new GateServer((id, _req, round) => { received = { id, round }; });
  const port = 7900 + Math.floor(Date.now() % 50);
  await server.start(port);
  const base = `http://127.0.0.1:${port}`;

  const health = (await (await fetch(`${base}/health`)).json()) as { ok: boolean };
  ok("health ok", health.ok === true);

  const created = (await (await fetch(`${base}/reviews`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diff: DIFF, cwd: "/repo", title: "t" }),
  })).json()) as { id: string; round: number };
  ok("review created with id", typeof created.id === "string");
  ok("onReview callback fired", received?.id === created.id);

  const pendingRes = await fetch(`${base}/reviews/${created.id}/feedback`);
  ok("feedback pending without wait -> 202", pendingRes.status === 202);

  // resolve the verdict after the long-poll starts
  setTimeout(() => {
    server.submitVerdict(created.id, "request_changes", "fix off-by-one",
      [{ file: "cart.py", line: 3, side: "new", body: "index out of range" }]);
  }, 300);

  const fbRes = await fetch(`${base}/reviews/${created.id}/feedback?wait=true`);
  ok("feedback resolves to 200 after verdict", fbRes.status === 200);
  const got = (await fbRes.json()) as Feedback;
  ok("verdict + comment + code_context returned",
    got.verdict === "request_changes" &&
    got.comments.length === 1 &&
    got.comments[0].code_context.includes("items[len(items)]"));

  server.stop();
  console.log(`\nALL ${passed} CHECKS PASSED`);
}

main().catch((e) => { console.error(e); process.exit(1); });
