# Claude Review Gate (VS Code extension)

A human-in-the-loop **review gate** for AI-generated code changes, built as a VS
Code extension and wired into Claude Code over **MCP**. When the agent finishes a
change it calls a tool that **blocks**; you review the change with **native inline
comments** in VS Code (the VS Code Comments API — the same UI as GitHub PR review),
then Approve or Request changes; your feedback comes back to Claude as a precise
"revise only this" instruction. Loop until you approve.

This is the VS Code sibling of the `~/llm-reviewer/reviewgate` web-UI gate. Same
contract (diff → inline comments + verdict → revision prompt), native editor UI.

```
Claude edits → calls request_review (MCP) ──blocks──▶ VS Code: inline comments + Approve/Request
       ▲                                                            │
       └──────────── revision prompt (tool result) ◀───────────────┘
   Claude revises → request_review again → … → you Approve → done
```

## Why MCP (not a hook)

A review gate must **block for human input** and feed structured text back. An MCP
tool does this natively: the call blocks, the timeout is configurable, and the
tool's return value becomes the `tool_result` Claude reasons over — so the revise
loop is automatic. (A `Stop`-hook alternative is sketched below, but its stdin/
stdout JSON is version-sensitive; MCP is the recommended path.)

## Layout

| Path | Role |
|---|---|
| `src/extension.ts` | VS Code extension: starts the gate server, renders the review with the Comments API, Approve/Request status-bar actions |
| `src/gate/gateServer.ts` | Local HTTP gate (create review, long-poll verdict) — no vscode deps |
| `src/gate/diff.ts` | unified-diff parsing + `code_context` extraction |
| `src/gate/feedbackPrompt.ts` | render verdict + comments → "revise only this" prompt |
| `src/mcp/server.ts` | MCP stdio server: `request_review` tool → gate → block → revision prompt |
| `src/test/run.ts` | Node tests for the non-UI core |
| `.mcp.json.example` | project-scoped MCP registration |

## Build & test

```bash
npm install
npm run compile      # tsc → dist/
npm test             # 13 checks: diff, code_context, prompt, gate HTTP loop
node scripts/mcp_e2e.mjs   # full MCP → gate → feedback bridge (no editor needed)
```

## Run the extension

> ⚠️ Requires VS Code + the Extension Development Host. There's no `code` CLI on
> this machine, so the in-editor UI is **not yet exercised here** — these are the
> steps to run it; the non-UI core and the MCP bridge are verified (above).

1. Open this folder in VS Code.
2. Press **F5** ("Run Extension") → an Extension Development Host window launches
   with the gate active (listening on `127.0.0.1:7879`).
3. Open your *target project* in that host window (or a second folder).

## Wire it into Claude Code

Register the MCP bridge (project scope writes `.mcp.json`; user scope is global):

```bash
claude mcp add --transport stdio --scope project \
  --env REVIEW_GATE_PORT=7879 \
  review-gate -- node /Users/jaewoo.park/claude-review-gate/dist/mcp/server.js
```

…or copy `.mcp.json.example` to your project's `.mcp.json`.

Then tell Claude to use it (put in the project's `CLAUDE.md`):

```md
After making code edits and before finishing, call the `request_review` MCP tool
(server: review-gate) with `cwd` set to the repo root. If it requests changes,
address ONLY the listed comments, then call `request_review` again passing
`parent_review_id` with the id it returned. Only finish once it returns APPROVED.
```

Now: Claude edits → `request_review` blocks → you review in VS Code → Approve/Request
→ Claude revises or finishes. The headless `claude -p` honors the same MCP config,
so this works in scripted runs too (the tool just blocks until you decide).

### Optional: Stop-hook alternative (sketch — verify field names)

Instead of (or in addition to) the tool, a `Stop` hook can auto-gate turn
completion. The hook reads the working-tree diff, POSTs to the gate
(`/reviews`), long-polls `/reviews/<id>/feedback?wait=true`, and returns the
revision prompt to Claude. The exact hook stdout schema (`hookSpecificOutput`,
`additionalContext`, exit-code 2) is version-sensitive — confirm against
`https://code.claude.com/docs/en/hooks.md` for your Claude Code version before
relying on it.

## Status

- [x] Core (diff, code_context, feedback prompt, gate HTTP long-poll) — compiled + tested
- [x] MCP `request_review` bridge — boots, lists tool, full e2e verified
- [x] Extension authored against the Comments API (compiles)
- [ ] **In-editor UI not yet run** (needs VS Code on this machine)
- [ ] Package as `.vsix` (`vsce package`) for install without F5
