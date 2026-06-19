import * as vscode from "vscode";
import { buildDiffLineMap, DiffLineLoc } from "./gate/diffDoc.js";
import { GateServer, RawComment } from "./gate/gateServer.js";
import { ReviewRequest } from "./gate/types.js";

const SCHEME = "reviewgate";

interface ActiveReview {
  id: string;
  round: number;
  cwd: string;
  diffUri: vscode.Uri;
  lineMap: (DiffLineLoc | null)[];
  threads: vscode.CommentThread[];
}

class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.emitter.event;
  set(uri: vscode.Uri, text: string): void {
    this.docs.set(uri.toString(), text);
    this.emitter.fire(uri);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }
}

let server: GateServer | undefined;
let controller: vscode.CommentController | undefined;
let diffProvider: DiffContentProvider;
let active: ActiveReview | undefined;
let approveItem: vscode.StatusBarItem;
let requestItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const port = vscode.workspace.getConfiguration("claudeReviewGate").get<number>("port", 7879);

  diffProvider = new DiffContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, diffProvider),
  );

  controller = vscode.comments.createCommentController("claudeReviewGate", "Claude Review Gate");
  controller.commentingRangeProvider = {
    provideCommentingRanges(document: vscode.TextDocument) {
      if (document.uri.scheme !== SCHEME) return [];
      // Allow comments only on lines that map to real code (skip headers/hunks).
      const map = buildDiffLineMap(document.getText());
      const ranges: vscode.Range[] = [];
      for (let i = 0; i < map.length; i++) {
        if (map[i]) ranges.push(new vscode.Range(i, 0, i, 0));
      }
      return ranges;
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
        active ? `Reviewing round ${active.round} — comment on the diff, then choose a verdict.`
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
  clearActive();
  const safe = (req.title || "review").replace(/[^\w.-]+/g, "_").slice(0, 48) || "review";
  const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${safe}.diff`, query: id });
  diffProvider.set(uri, req.diff);

  active = { id, round, cwd: req.cwd, diffUri: uri, lineMap: buildDiffLineMap(req.diff), threads: [] };

  // Open the diff as a reviewable document (rendered with VS Code's `diff`
  // colorization). The reviewer comments on its lines; each maps back to a
  // real (file, side, line).
  vscode.workspace.openTextDocument(uri).then(async (doc) => {
    await vscode.languages.setTextDocumentLanguage(doc, "diff");
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  showButtons(round);

  vscode.window
    .showInformationMessage(
      `Review requested: ${req.title || "(untitled change)"} (round ${round}). ` +
        `Comment on lines in the diff, then Approve / Request changes.`,
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
  reply.thread.label = "Review comment";
  if (active && !active.threads.includes(reply.thread)) active.threads.push(reply.thread);
}

async function finalize(verdict: "approve" | "request_changes"): Promise<void> {
  if (!active || !server) return;

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
    const ln = thread.range ? thread.range.start.line : 0;
    const loc = active.lineMap[ln];
    if (!loc) continue;
    for (const c of thread.comments) {
      if (c.author?.name === "You") {
        comments.push({ file: loc.file, line: loc.line, side: loc.side, body: bodyText(c.body) });
      }
    }
  }

  const ok = server.submitVerdict(active.id, verdict, summary, comments);
  if (ok) {
    vscode.window.setStatusBarMessage(
      `Review Gate: ${verdict === "approve" ? "approved" : "changes requested"} ` +
        `(${comments.length} comment(s)) — sent to the agent.`,
      5000,
    );
  }
  clearActive();
}

function bodyText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}

function showButtons(round: number): void {
  approveItem.text = "$(check) Approve review";
  approveItem.tooltip = `Approve this change (round ${round})`;
  requestItem.text = "$(comment-discussion) Request changes";
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
