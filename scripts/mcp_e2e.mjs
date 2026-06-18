// End-to-end: MCP request_review → gate server → (simulated human verdict) →
// revision prompt returned as the tool result. Proves the whole bridge without
// the VS Code UI (a standalone GateServer stands in for the extension).
import { spawn } from "node:child_process";
import { GateServer } from "../dist/gate/gateServer.js";

const PORT = 7879;
const DIFF =
  "--- a/cart.py\n+++ b/cart.py\n@@ -1,2 +1,3 @@\n" +
  " def last_item(items):\n-    return items[-1]\n+    # bug\n+    return items[len(items)]\n";

const gate = new GateServer((id) => {
  // stand in for the human reviewing in VS Code
  setTimeout(
    () => gate.submitVerdict(id, "request_changes", "fix the off-by-one",
      [{ file: "cart.py", line: 3, side: "new", body: "index out of range" }]),
    300,
  );
});
await gate.start(PORT);

const p = spawn("node", ["dist/mcp/server.js"], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, REVIEW_GATE_PORT: String(PORT) },
});
let buf = "";
p.stdout.on("data", (d) => (buf += d.toString()));
const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");

send({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/call",
  params: { name: "request_review", arguments: { cwd: "/tmp", diff: DIFF } } }), 200);

setTimeout(() => {
  p.kill();
  gate.stop();
  const ok = buf.includes("ONLY") && buf.includes("items[len(items)]") && buf.includes("review_id");
  console.log(ok ? "MCP E2E: PASS" : "MCP E2E: FAIL");
  if (!ok) console.log(buf.slice(0, 2500));
  else {
    const m = buf.match(/"text":"([\s\S]*?)"}/);
    if (m) console.log("\n--- tool result Claude would receive ---\n" + JSON.parse('"' + m[1] + '"'));
  }
  process.exit(ok ? 0 : 1);
}, 3000);
