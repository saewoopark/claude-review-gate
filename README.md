# Claude Review Gate (VS Code extension)

A human-in-the-loop **review gate** for AI-generated code changes, built as a VS Code
extension and wired into Claude Code. When the agent finishes a change, the diff opens
in VS Code as **native side-by-side panes with inline comments** (the VS Code Comments
API — the same UI as GitHub PR review). You **Approve** — and any inline comments you
left come back to Claude as a precise "revise only this" instruction. Loop until you
approve with no comments.

![Claude Review Gate demo](https://raw.githubusercontent.com/saewoopark/claude-review-gate/main/media/demo.gif)

```
Claude edits ──▶ review gate blocks ──▶ VS Code: inline comments + Approve
      ▲                                                          │
      └────── comments (if any) fed back as revision prompt ◀────┘
   Claude resolves comments → gate again → … → you Approve clean → done
```

The gate is enforced by a **`Stop` hook**: the harness runs it at the end of every
turn, so review can't be skipped or forgotten. The hook talks to the local gate the
extension hosts (`127.0.0.1:7879`).

## Reviewing in VS Code

When a review opens, each changed file appears as a two-pane diff (base ↔ changed).
There's just one decision — **Approve** — and the verdict is decided by what you left:

- **Comment** on either pane — hover a line, click the `+`, type, and submit with the
  **Add review comment** button on the box. Comments anchor to exact file lines.
- **Approve** *(per file)* — marks the focused file done and **closes its diff tab**.
  In the **editor title bar**, or press **⌘↵ / Ctrl+↵** while focused on a diff pane.
  The status bar shows how many files are left.
- **Approve all** — finishes every file at once and **closes all the diff tabs**. In
  the editor title bar and the status bar.

When the review finishes (last file approved, or Approve all), the verdict is automatic:

- **No comments anywhere → `approve`.**
- **Any inline comments → `request changes`**, carrying those comments so the agent
  resolves them — then it re-submits and you review again. Loop until you approve with
  no comments.

No summary prompt, no separate "Request changes" button. There's no popup notification
either: the buttons and the opened diff tabs are the affordances (a brief,
self-dismissing status-bar line announces each new review).

## Layout

| Path | Role |
|---|---|
| `src/extension.ts` | VS Code extension: hosts the gate, renders side-by-side diffs + inline comments, per-file Approve / Approve all (comment-driven verdict) |
| `src/gate/gateServer.ts` | Local HTTP gate (create review, long-poll verdict) — no vscode deps |
| `src/gate/diff.ts` / `sideBySide.ts` | unified-diff parsing, `code_context` extraction, two-pane rendering |
| `src/gate/feedbackPrompt.ts` | render verdict + comments → "revise only this" prompt |
| `scripts/reviewGateStopHook.mjs` | **Stop hook**: gates every turn end over HTTP; self-contained (Node builtins only) |
| `scripts/recordTouched.mjs` | **PostToolUse tracker**: records edited paths so reviews are scoped to touched files |
| `.claude/settings.json` | registers both hooks for this repo (the extension can self-register them globally) |
| `src/test/run.ts` | Node tests for the non-UI core |

## Build & test

```bash
npm install
npm run compile      # tsc → dist/
npm test             # 28 checks: diff, code_context, prompt, gate HTTP loop, auth/host guards
```

## Package & install (`.vsix`)

```bash
npm run package          # → claude-review-gate-0.11.0.vsix
```

Install it in VS Code: **Extensions** view → the **⋯** menu → **Install from VSIX…** →
pick `claude-review-gate-0.11.0.vsix`, then reload the window. (If you have the `code`
CLI: `code --install-extension claude-review-gate-0.11.0.vsix`.)

> The `.vsix` bundles everything it needs — the in-editor gate **and** the hook
> scripts (`scripts/*.mjs`). No `node_modules`, no separate repo on disk.

## Wire it into Claude Code

**Install the extension and click Enable — that's it.** On first activation it asks
*"Enable Claude Review Gate for Claude Code?"*; choosing **Enable** writes the `Stop` +
`PostToolUse` hooks into your user-global `~/.claude/settings.json`, pointing at the
scripts **bundled inside the extension** — no repo on disk, no manual editing. It keeps
that path current across extension updates, and the **Review Gate: Disable for Claude
Code** command removes it cleanly.

> After enabling, run `/hooks` once in an already-open Claude Code session (or restart)
> to activate it — new sessions pick it up automatically. Requires `node` on PATH (the
> hooks shell out to `node …`) and a Claude Code version with `Stop`/`PostToolUse` hooks.

### Manual setup (optional)

To wire it yourself instead — e.g. **project-scoped** in a repo's `.claude/settings.json`
(this repo ships exactly this) — add equivalent hooks pointing at the scripts by path:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Edit|Write|NotebookEdit", "hooks": [ {
        "type": "command",
        "command": "node \"${CLAUDE_PROJECT_DIR}/scripts/recordTouched.mjs\""
      } ] }
    ],
    "Stop": [
      { "hooks": [ {
        "type": "command",
        "command": "node \"${CLAUDE_PROJECT_DIR}/scripts/reviewGateStopHook.mjs\"",
        "timeout": 1800
      } ] }
    ]
  }
}
```

By default the hook reviews **only the files Claude touched** — the `PostToolUse` hook
records each `Edit`/`Write`/`NotebookEdit` path in `.git/review-gate-touched`, and the
Stop hook diffs just those (`git diff -- <paths>`), clearing the list on approval so
each review is scoped to what changed since the last one. If that tracker file is
absent, it falls back to the whole working-tree diff (incl. untracked files, honoring
`.gitignore`) so nothing slips through. Either way it POSTs to the gate and blocks
until you decide; approved diffs are remembered (hashed under `.git/`) so they aren't
re-reviewed.

> Tracking is by tool call, so files changed via Bash (e.g. `sed -i`) aren't scoped in
> — only `Edit`/`Write`/`NotebookEdit` edits are.

Knobs (env, e.g. in `.claude/settings.json` `"env"`):

- `REVIEW_GATE_PORT` — gate port (default `7879`; match the extension's setting).
- `REVIEW_GATE_REQUIRED=1` — fail **closed**: block the turn if the gate is
  unreachable. Default fails **open** with a warning, so a missing extension never
  bricks a session.

> After adding the hooks, open `/hooks` once (reloads config) or restart Claude Code —
> the settings watcher only picks up `.claude/` if a settings file was present at
> startup.

## Security

The gate is a local dev tool, hardened for the local-process threat model:

- **Loopback only** — binds `127.0.0.1`; never exposed to the network.
- **Human-in-the-loop can't be bypassed** — verdicts are submitted in-process from the
  editor (a click), never over HTTP. Nothing external can inject an "approve".
- **Token-authenticated** — the extension writes a per-install secret to
  `~/.claude/review-gate.token` (mode `0600`); `POST /reviews` and the feedback read
  require it (`X-Review-Gate-Token`), so a blind localhost port-probe is rejected.
  `/health` stays open (liveness only).
- **DNS-rebinding guard** — non-loopback `Host` headers are refused (`403`).
- **Body-size cap** (32 MB) guards against local memory-DoS.
- **No shell injection / no untrusted code execution** — hooks call `git` via
  `execFileSync` (array args, no shell); review comments render as untrusted markdown.

Note: enabling writes hooks to your global `~/.claude/settings.json` that run `node …`
each turn — i.e. you're trusting this (user-installed) extension to run code via Claude
Code. The **Disable** command removes that wiring.

## Status

- [x] Core (diff, code_context, feedback prompt, gate HTTP long-poll) — compiled + tested (28 checks)
- [x] Extension UI — side-by-side diffs, inline comments, per-file Approve / Approve all, ⌘↵ shortcut, comment-driven verdict, auto tab-close
- [x] Stop hook — harness-enforced gate, touched-file scoping, fail-open/closed, dedup of approved diffs
- [x] One-click **Enable for Claude Code** — the extension bundles the hook scripts and self-registers them in `~/.claude/settings.json` (no repo on disk, no manual wiring)
- [x] Packaged as `.vsix`
