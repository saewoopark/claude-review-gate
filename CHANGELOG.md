# Changelog

## 0.11.0

First publish-ready release.

- **Human-in-the-loop review gate** for Claude Code changes, rendered as native
  side-by-side diffs with inline comments (VS Code Comments API).
- **One decision — Approve.** Per-file Approve (auto-closes the diff tab) and Approve
  all. The verdict is comment-driven: any inline comments → *request changes* (sent
  back for the agent to resolve); none → *approve*. `⌘↵ / Ctrl+↵` approves the focused
  file.
- **Harness-enforced** via a `Stop` hook the extension self-registers into
  `~/.claude/settings.json` on a one-click consent — no repo on disk, no manual wiring.
  **Enable / Disable** commands included.
- **Scoped reviews** — only the files Claude touched are reviewed (tracked via a
  `PostToolUse` hook), with a whole-tree fallback.
- **Security** — token-authenticated local gate (`~/.claude/review-gate.token`, mode
  `0600`), loopback-only `Host` allowlist, request-body cap; verdicts are submitted
  in-process only (no HTTP approve).
