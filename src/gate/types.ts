// Shared types for the review gate. No vscode imports — usable from the MCP
// bridge and unit tests as well as the extension.

export type Side = "old" | "new";
export type Verdict = "approve" | "request_changes";

export interface ReviewRequest {
  diff: string;
  cwd: string;
  title?: string;
}

export interface FeedbackComment {
  file: string;
  line: number;
  side: Side;
  body: string;
  code_context: string;
}

export interface Feedback {
  reviewId: string;
  round: number;
  verdict: Verdict;
  summary: string;
  comments: FeedbackComment[];
}
