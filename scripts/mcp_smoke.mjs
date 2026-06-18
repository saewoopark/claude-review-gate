// Minimal MCP stdio handshake to confirm the server boots and lists its tool.
import { spawn } from "node:child_process";

const p = spawn("node", ["dist/mcp/server.js"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
p.stdout.on("data", (d) => (buf += d.toString()));

const send = (o) => p.stdin.write(JSON.stringify(o) + "\n");
send({ jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

setTimeout(() => {
  p.kill();
  const okInit = buf.includes('"serverInfo"') || buf.includes('"protocolVersion"');
  const okTool = buf.includes("request_review");
  console.log("initialize responded:", okInit);
  console.log("request_review tool listed:", okTool);
  console.log(okInit && okTool ? "MCP SMOKE: PASS" : "MCP SMOKE: FAIL");
  process.exit(okInit && okTool ? 0 : 1);
}, 1500);
