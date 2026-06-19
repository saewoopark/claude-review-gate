import * as vscode from "vscode";
import { buildSideBySide, parseHunks } from "./gate/sideBySide.js";
import { GateServer, RawComment } from "./gate/gateServer.js";
import { ReviewRequest, Side } from "./gate/types.js";

const SCHEME = "reviewgate";

interface DocMap {
  file: string;
  side: Side;
  map: (number | null)[]; // pane line index → file line (1-based), null if not commentable
}

interface ActiveReview {
  id: string;
  round: number;
  cwd: string;
  threads: vscode.CommentThread[];
  docMaps: Map<string, DocMap>; // uri.toString() → mapping
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
let provider: DiffContentProvider;
let active: ActiveReview | undefined;
let approveItem: vscode.StatusBarItem;
let requestItem: vscode.StatusBarItem;

function paneUri(id: string, side: "base" | "mod", file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, path: `/${id}/${side}/${file}`, query: id });
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const port = vscode.workspace.getConfiguration("claudeReviewGate").get<number>("port", 7879);

  provider = new DiffContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider),
  );

  controller = vscode.comments.createCommentController("claudeReviewGate", "Claude Review Gate");
  controller.commentingRangeProvider = {
    provideCommentingRanges(document: vscode.TextDocument) {
      const entry = active?.docMaps.get(document.uri.toString());
      if (!entry) return [];
      const ranges: vscode.Range[] = [];
      entry.map.forEach((loc, i) => {
        if (loc !== null) ranges.push(new vscode.Range(i, 0, i, 0));
      });
      return ranges;
    },
  };
  context.subscriptions.push(controller);

  approveItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  approveItem.command = "claudeReviewGate.submitReview";
  requestItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  requestItem.command = "claudeReviewGate.requestChanges";
  context.subscriptions.push(approveItem, requestItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeReviewGate.submitReview", () => submitReview()),
    vscode.commands.registerCommand("claudeReviewGate.approve", () => finalize("approve")),
    vscode.commands.registerCommand("claudeReviewGate.requestChanges", () => finalize("request_changes")),
    vscode.commands.registerCommand("claudeReviewGate.addComment", (reply: vscode.CommentReply) =>
      addComment(reply),
    ),
    vscode.commands.registerCommand("claudeReviewGate.status", () =>
      vscode.window.showInformationMessage(
        active ? `Reviewing round ${active.round} — comment on the diffs, then Submit review.`
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
  const files = parseHunks(req.diff);
  active = { id, round, cwd: req.cwd, threads: [], docMaps: new Map() };

  void (async () => {
    for (const f of files) {
      const sbs = buildSideBySide(f);
      const baseUri = paneUri(id, "base", f.file);
      const modUri = paneUri(id, "mod", f.file);
      provider.set(baseUri, sbs.baseText);
      provider.set(modUri, sbs.modText);
      active!.docMaps.set(baseUri.toString(), { file: f.file, side: "old", map: sbs.baseMap });
      active!.docMaps.set(modUri.toString(), { file: f.file, side: "new", map: sbs.modMap });
      // Native two-pane diff: base (left) ↔ changed (right).
      await vscode.commands.executeCommand(
        "vscode.diff", baseUri, modUri, `${f.file} (review · round ${round})`, { preview: false },
      );
    }
    showButtons(round);
    vscode.window
      .showInformationMessage(
        `Review requested: ${req.title || "(untitled change)"} (round ${round}) — ${files.length} file(s). ` +
          `Comment on either pane, then Submit review.`,
        "Approve",
        "Request changes",
      )
      .then((choice) => {
        if (choice === "Approve") finalize("approve");
        else if (choice === "Request changes") finalize("request_changes");
      });
  })();
}

type VerdictPick = vscode.QuickPickItem & { verdict: "approve" | "request_changes" };

async function submitReview(): Promise<void> {
  if (!active) {
    vscode.window.showInformationMessage("Review Gate: no review is currently open.");
    return;
  }
  const commentCount = active.threads.reduce(
    (n, t) => n + t.comments.filter((c) => c.author?.name === "You").length,
    0,
  );
  const items: VerdictPick[] = [
    { label: "$(check) Approve", description: "finish — let the agent proceed", verdict: "approve" },
    {
      label: "$(comment-discussion) Request changes",
      description: `send ${commentCount} comment(s) back to the agent`,
      verdict: "request_changes",
    },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: `Submit review · round ${active.round}`,
    placeHolder: "Choose a verdict to send back to the agent",
  });
  if (pick) await finalize(pick.verdict);
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
    const entry = active.docMaps.get(thread.uri.toString());
    if (!entry) continue;
    const ln0 = thread.range ? thread.range.start.line : 0;
    const fileLine = entry.map[ln0];
    if (fileLine == null) continue;
    for (const c of thread.comments) {
      if (c.author?.name === "You") {
        comments.push({ file: entry.file, line: fileLine, side: entry.side, body: bodyText(c.body) });
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
  approveItem.text = "$(check-all) Submit review";
  approveItem.tooltip = `Approve / request changes (round ${round})`;
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
