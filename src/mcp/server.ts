#!/usr/bin/env node
// MCP stdio server: bridges Claude Code → the VS Code Review Gate.
// Claude calls `request_review`; this forwards the diff to the extension's local
// gate server, BLOCKS until the human decides, and returns the revision prompt as
// the tool result so Claude can revise and call again.
//
// The MCP SDK is ESM-only; we dynamic-import it so this file can compile/run as
// CommonJS (Node >= 22 for require/dynamic-import of ESM).

import { execFileSync } from "child_process";
import { z } from "zod";
import { renderRevisionPrompt } from "../gate/feedbackPrompt.js";
import { Feedback } from "../gate/types.js";

const PORT = parseInt(process.env.REVIEW_GATE_PORT || "7879", 10);
const BASE = `http://127.0.0.1:${PORT}`;
const OVERALL_TIMEOUT_MS = 60 * 60 * 1000; // 1h hard cap

async function postReview(
  diff: string, cwd: string, title?: string, parentId?: string,
): Promise<{ id: string; round: number }> {
  const res = await fetch(`${BASE}/reviews`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ diff, cwd, title, parentId }),
  });
  if (!res.ok) throw new Error(`gate POST /reviews -> ${res.status}`);
  return (await res.json()) as { id: string; round: number };
}

async function pollFeedback(id: string): Promise<Feedback> {
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/reviews/${id}/feedback?wait=true`);
    if (res.status === 200) return (await res.json()) as Feedback;
    // 202 == still pending (server long-polled ~25s); loop.
  }
  throw new Error("timed out waiting for human review");
}

async function gateReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

  const server = new McpServer({ name: "claude-review-gate", version: "0.1.0" });

  server.registerTool(
    "request_review",
    {
      description:
        "Open the proposed code change in the VS Code Review Gate for HUMAN review and BLOCK " +
        "until the human approves or requests changes. Call this after you finish editing and " +
        "before considering the task done. Returns the reviewer's verdict and inline comments; " +
        "if changes are requested, address ONLY those comments and call request_review again, " +
        "passing parent_review_id with the id from this call.",
      inputSchema: {
        cwd: z.string().describe("Absolute path to the repo/working directory being changed."),
        diff: z
          .string()
          .optional()
          .describe("Unified diff of the change. If omitted, the gate runs `git diff` in cwd."),
        title: z.string().optional().describe("Short human-readable title for the change."),
        parent_review_id: z
          .string()
          .optional()
          .describe("The review_id from a prior request_review call, when re-submitting after revisions."),
      },
    },
    async (args: { cwd: string; diff?: string; title?: string; parent_review_id?: string }) => {
      if (!(await gateReachable())) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text:
              `The Review Gate isn't running at ${BASE}. Open the project in VS Code with the ` +
              `Claude Review Gate extension active (it starts the gate automatically), or set ` +
              `REVIEW_GATE_PORT to match the extension's configured port.`,
          }],
        };
      }
      let diff = args.diff;
      if (!diff || !diff.trim()) {
        try {
          diff = execFileSync("git", ["-C", args.cwd, "diff"], { encoding: "utf8" });
        } catch (e) {
          return { isError: true, content: [{ type: "text" as const, text: `git diff failed: ${String(e)}` }] };
        }
      }
      if (!diff.trim()) {
        return { content: [{ type: "text" as const, text: "No changes to review (empty diff)." }] };
      }
      const { id } = await postReview(diff, args.cwd, args.title, args.parent_review_id);
      const fb = await pollFeedback(id);
      return { content: [{ type: "text" as const, text: `review_id: ${id}\n\n${renderRevisionPrompt(fb)}` }] };
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error("[claude-review-gate mcp]", e);
  process.exit(1);
});
