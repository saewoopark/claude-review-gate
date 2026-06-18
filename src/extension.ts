import * as path from "path";
import * as vscode from "vscode";
import { changedFiles } from "./gate/diff.js";
import { GateServer, RawComment } from "./gate/gateServer.js";
import { ReviewRequest, Side } from "./gate/types.js";

interface ActiveReview {
  id: string;
  round: number;
  cwd: string;
  threads: vscode.CommentThread[];
}

let server: GateServer | undefined;
let controller: vscode.CommentController | undefined;
let active: ActiveReview | undefined;
let approveItem: vscode.StatusBarItem;
let requestItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const port = vscode.workspace.getConfiguration("claudeReviewGate").get<number>("port", 7879);

  controller = vscode.comments.createCommentController("claudeReviewGate", "Claude Review Gate");
  controller.commentingRangeProvider = {
    provideCommentingRanges(document: vscode.TextDocument) {
      return [new vscode.Range(0, 0, Math.max(0, document.lineCount - 1), 0)];
    },
  };
  context.subscriptions.push(controller);

  approveItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  approveItem.command = "claudeReviewGate.approve";
  requestItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  requestItem.command = "claudeReviewGate.requestChanges";
  context.subscriptions.push(approveItem, requestItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeReviewGate.approve", () => finalize("approve")),
    vscode.commands.registerCommand("claudeReviewGate.requestChanges", () => finalize("request_changes")),
    vscode.commands.registerCommand("claudeReviewGate.addComment", (reply: vscode.CommentReply) =>
      addComment(reply),
    ),
    vscode.commands.registerCommand("claudeReviewGate.status", () =>
      vscode.window.showInformationMessage(
        active ? `Reviewing ${active.threads.length} file(s) — round ${active.round}.`
               : "Review Gate idle.",
      ),
    ),
  );

  server = new GateServer(onReview);
  try {
    await server.start(port);
    console.log(`[claude-review-gate] listening on 127.0.0.1:${port}`);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Claude Review Gate: could not bind port ${port} (${String(e)}). Set claudeReviewGate.port.`,
    );
  }
  context.subscriptions.push({ dispose: () => server?.stop() });
}

export function deactivate(): void {
  server?.stop();
}

function onReview(id: string, req: ReviewRequest, round: number): void {
  // Sequential gate: clear any prior session UI.
  clearActive();
  const files = changedFiles(req.diff);
  const threads: vscode.CommentThread[] = [];

  for (const f of files) {
    const abs = path.isAbsolute(f.path) ? f.path : path.join(req.cwd, f.path);
    const uri = vscode.Uri.file(abs);
    const anchor = f.newLines.length ? Math.max(0, f.newLines[0] - 1) : 0;
    const thread = controller!.createCommentThread(uri, new vscode.Range(anchor, 0, anchor, 0), [
      {
        body: new vscode.MarkdownString(
          `**Review Gate** · round ${round}. Reply on any line to leave a comment, then **Approve** or **Request changes** in the status bar.`,
        ),
        mode: vscode.CommentMode.Preview,
        author: { name: "Review Gate" },
      },
    ]);
    thread.label = `Review: ${f.path}`;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    threads.push(thread);
  }

  active = { id, round, cwd: req.cwd, threads };
  showButtons(files.length, round);

  // Reveal the first changed file so the reviewer lands on the change.
  if (files.length) {
    const first = files[0];
    const abs = path.isAbsolute(first.path) ? first.path : path.join(req.cwd, first.path);
    vscode.workspace.openTextDocument(vscode.Uri.file(abs)).then(
      (doc) => vscode.window.showTextDocument(doc, { preview: false }),
      () => {/* file may not exist on disk (e.g. pure rename); ignore */},
    );
  }

  vscode.window
    .showInformationMessage(
      `Review requested: ${req.title || "(untitled change)"} — ${files.length} file(s).`,
      "Approve",
      "Request changes",
    )
    .then((choice) => {
      if (choice === "Approve") finalize("approve");
      else if (choice === "Request changes") finalize("request_changes");
    });
}

function addComment(reply: vscode.CommentReply): void {
  const comment: vscode.Comment = {
    body: new vscode.MarkdownString(reply.text),
    mode: vscode.CommentMode.Preview,
    author: { name: "You" },
  };
  reply.thread.comments = [...reply.thread.comments, comment];
  if (active && !active.threads.includes(reply.thread)) active.threads.push(reply.thread);
}

async function finalize(verdict: "approve" | "request_changes"): Promise<void> {
  if (!active || !server) {
    return;
  }
  let summary = "";
  if (verdict === "request_changes") {
    summary =
      (await vscode.window.showInputBox({
        prompt: "Summary / overall guidance for the change (optional)",
        placeHolder: "e.g. fix the off-by-one; otherwise looks good",
      })) || "";
  }

  const comments: RawComment[] = [];
  for (const thread of active.threads) {
    const line = (thread.range ? thread.range.start.line : 0) + 1; // 1-based new-side line
    const file = path.relative(active.cwd, thread.uri.fsPath) || thread.uri.fsPath;
    for (const c of thread.comments) {
      if (c.author?.name === "You") {
        comments.push({ file, line, side: "new" as Side, body: bodyText(c.body) });
      }
    }
  }

  const ok = server.submitVerdict(active.id, verdict, summary, comments);
  if (ok) {
    vscode.window.setStatusBarMessage(
      `Review Gate: ${verdict === "approve" ? "approved" : "changes requested"} (${comments.length} comment(s)) — sent to the agent.`,
      5000,
    );
  }
  clearActive();
}

function bodyText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}

function showButtons(fileCount: number, round: number): void {
  approveItem.text = "$(check) Approve review";
  approveItem.tooltip = `Approve this change (round ${round}, ${fileCount} file(s))`;
  requestItem.text = "$(request-changes) Request changes";
  requestItem.tooltip = "Send your inline comments back to the agent";
  approveItem.show();
  requestItem.show();
}

function clearActive(): void {
  if (active) {
    for (const t of active.threads) t.dispose();
    active = undefined;
  }
  approveItem?.hide();
  requestItem?.hide();
}
