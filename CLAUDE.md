# CLAUDE.md — Claude Review Gate

## Review gate is enforced automatically (Stop hook)

Every code change in this repo is gated for human review. Enforcement is a **`Stop`
hook** (`scripts/reviewGateStopHook.mjs`, registered in `.claude/settings.json`) — the
**harness** runs it at the end of every turn, so the gate cannot be skipped or
forgotten. On each turn end the hook:

1. Computes the working-tree diff (incl. untracked files, honoring `.gitignore`).
   No changes, or a diff already approved this session → the turn ends normally.
2. Otherwise POSTs the diff to the gate and **blocks** until you review it in VS Code.
   - **Approved** → records the diff hash and lets the turn end.
   - **Changes requested** → feeds the inline comments back as a "revise only this"
     instruction; address ONLY those comments — the next turn-end re-gates. Loop
     until approved.

By default the review is scoped to the files Claude touched this cycle (a `PostToolUse`
hook records `Edit`/`Write` paths in `.git/review-gate-touched`); it falls back to the
whole working-tree diff if that tracker is absent.

### Knobs (env)
- `REVIEW_GATE_PORT` — gate port (default `7879`; must match the extension's setting).
- `REVIEW_GATE_REQUIRED=1` — fail **closed**: if the gate is unreachable, block the
  turn until VS Code is up. Default fails **open** with a warning so a missing
  extension never bricks a session.

> If you see the "gate not reachable" warning, the VS Code extension isn't running —
> open this project in VS Code (the extension auto-starts the gate) so changes get
> reviewed.
