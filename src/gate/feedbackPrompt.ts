// Render structured feedback into a "revise only this" instruction for the LLM.
// Mirrors reviewgate/feedback_prompt.py.

import { Feedback } from "./types.js";

export function renderRevisionPrompt(fb: Feedback): string {
  if (fb.verdict === "approve") {
    let msg = "The human reviewer APPROVED this change. No revisions requested.";
    if (fb.summary) msg += `\n\nReviewer note:\n${fb.summary}`;
    return msg;
  }

  const parts: string[] = [
    "A human reviewer requested changes.",
    "Revise the change to address ONLY the comments below. Do not make " +
      "unrelated edits, refactors, or cleanups — address each comment and " +
      "nothing more.",
  ];
  if (fb.summary) parts.push(`\nReviewer summary:\n${fb.summary}`);

  parts.push("\nInline comments:");
  fb.comments.forEach((c, i) => {
    parts.push(`\n${i + 1}. ${c.file}:${c.line} (${c.side} side)`);
    if (c.code_context) parts.push(c.code_context);
    parts.push(`   → ${c.body}`);
  });
  if (fb.comments.length === 0) {
    parts.push("\n(no inline comments — see the reviewer summary above.)");
  }
  return parts.join("\n");
}
