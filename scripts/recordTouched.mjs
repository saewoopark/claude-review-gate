#!/usr/bin/env node
// PostToolUse tracker for the Claude Review Gate (jq-free, Node builtins only).
//
// Registered as a PostToolUse hook on Edit|Write|NotebookEdit, this records each
// edited file path in <git-dir>/review-gate-touched so the Stop hook can scope the
// review to just the files Claude touched. Reads the hook payload on stdin; never
// fails the tool (any error → silent exit 0).

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (file) {
    const cwd = input.cwd || process.cwd();
    let gitDir = execFileSync("git", ["-C", cwd, "rev-parse", "--git-dir"], { encoding: "utf8" }).trim();
    if (!isAbsolute(gitDir)) gitDir = join(cwd, gitDir);
    appendFileSync(join(gitDir, "review-gate-touched"), `${file}\n`);
  }
} catch {
  /* never break the tool call */
}
process.exit(0);
