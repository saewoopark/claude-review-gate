import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
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
  cwd: string;
  files: string[]; // all files in this review
  approvedFiles: Set<string>; // files the human has approved so far
  fileUris: Map<string, { base: vscode.Uri; mod: vscode.Uri }>;
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
let approveAllItem: vscode.StatusBarItem;

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

  approveAllItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  approveAllItem.command = "claudeReviewGate.approveAll";
  context.subscriptions.push(approveAllItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("claudeReviewGate.approve", () => approveFile()),
    vscode.commands.registerCommand("claudeReviewGate.approveAll", () => approveAll()),
    vscode.commands.registerCommand("claudeReviewGate.addComment", (reply: vscode.CommentReply) =>
      addComment(reply),
    ),
    vscode.commands.registerCommand("claudeReviewGate.status", () =>
      vscode.window.showInformationMessage(
        active
          ? `Reviewing — ${active.approvedFiles.size}/${active.files.length} file(s) approved. ` +
              `Add comments on the diffs, then Approve (per file) or Approve all.`
          : "Review Gate idle.",
      ),
    ),
    vscode.commands.registerCommand("claudeReviewGate.enableInClaudeCode", async () => {
      if (await registerHooks(context)) {
        await context.globalState.update(ENABLED_KEY, true);
        reloadHint();
      }
    }),
    vscode.commands.registerCommand("claudeReviewGate.disableInClaudeCode", async () => {
      await unregisterHooks();
      await context.globalState.update(ENABLED_KEY, false);
      vscode.window.showInformationMessage(
        "Claude Review Gate disabled for Claude Code. Run /hooks (or restart) in Claude Code to apply.",
      );
    }),
  );

  const token = ensureGateToken(context);
  server = new GateServer(onReview, token);
  try {
    await server.start(port);
    console.log(`[claude-review-gate] listening on 127.0.0.1:${port}`);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Claude Review Gate: could not bind port ${port} (${String(e)}). Set claudeReviewGate.port.`,
    );
  }
  context.subscriptions.push({ dispose: () => server?.stop() });

  // Wire the gate into Claude Code (one-click consent the first time; silent path
  // refresh on later activations so extension updates keep the hook command current).
  void maybeOfferEnable(context);
}

export function deactivate(): void {
  server?.stop();
}

// --- Claude Code self-registration -----------------------------------------

const ENABLED_KEY = "claudeReviewGate.enabledInClaudeCode";
const DECLINED_KEY = "claudeReviewGate.declinedEnable";
const TOKEN_KEY = "claudeReviewGate.gateToken";

/** Stable per-install secret for the local gate, published to ~/.claude/review-gate.token
 * (owner-only) so the hooks can authenticate. Blocks blind localhost port-probes. */
function ensureGateToken(context: vscode.ExtensionContext): string {
  let token = context.globalState.get<string>(TOKEN_KEY);
  if (!token) {
    token = crypto.randomBytes(24).toString("hex");
    void context.globalState.update(TOKEN_KEY, token);
  }
  try {
    const file = path.join(os.homedir(), ".claude", "review-gate.token");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token, { mode: 0o600 });
    fs.chmodSync(file, 0o600); // enforce perms even if the file pre-existed
  } catch {
    /* non-fatal: the gate still requires the token, hooks just can't read it */
  }
  return token;
}
// Identifies hook entries this extension owns, across versions (the install path
// changes but the script basenames don't).
const HOOK_MARKER = /reviewGateStopHook\.(mjs|js)|recordTouched\.(mjs|js)/;

function claudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function hookCommands(context: vscode.ExtensionContext): { stop: string; track: string } {
  const port = vscode.workspace.getConfiguration("claudeReviewGate").get<number>("port", 7879);
  const envPrefix = port === 7879 ? "" : `REVIEW_GATE_PORT=${port} `;
  const stopScript = path.join(context.extensionPath, "scripts", "reviewGateStopHook.mjs");
  const trackScript = path.join(context.extensionPath, "scripts", "recordTouched.mjs");
  return {
    stop: `${envPrefix}node "${stopScript}"`,
    track: `node "${trackScript}"`,
  };
}

function ownsGroup(group: { hooks?: Array<{ type?: string; command?: string }> }): boolean {
  return (group?.hooks || []).some((h) => h?.type === "command" && HOOK_MARKER.test(h.command || ""));
}

/** Idempotently add our Stop + PostToolUse hooks to ~/.claude/settings.json. */
async function registerHooks(context: vscode.ExtensionContext): Promise<boolean> {
  const file = claudeSettingsPath();
  let settings: any = {};
  try {
    if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    vscode.window.showErrorMessage(
      `Claude Review Gate: couldn't parse ${file} (${String(e)}). Fix it (or enable the gate manually) and retry.`,
    );
    return false;
  }
  const { stop, track } = hookCommands(context);
  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = (settings.hooks.Stop || []).filter((g: any) => !ownsGroup(g));
  settings.hooks.Stop.push({
    hooks: [{ type: "command", command: stop, timeout: 1800, statusMessage: "Review gate: waiting for human review…" }],
  });
  settings.hooks.PostToolUse = (settings.hooks.PostToolUse || []).filter((g: any) => !ownsGroup(g));
  settings.hooks.PostToolUse.push({
    matcher: "Edit|Write|NotebookEdit",
    hooks: [{ type: "command", command: track }],
  });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    return true;
  } catch (e) {
    vscode.window.showErrorMessage(`Claude Review Gate: couldn't write ${file} (${String(e)}).`);
    return false;
  }
}

/** Remove our hooks from ~/.claude/settings.json, leaving everything else intact. */
async function unregisterHooks(): Promise<void> {
  const file = claudeSettingsPath();
  if (!fs.existsSync(file)) return;
  let settings: any;
  try { settings = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  if (Array.isArray(settings.hooks?.Stop)) settings.hooks.Stop = settings.hooks.Stop.filter((g: any) => !ownsGroup(g));
  if (Array.isArray(settings.hooks?.PostToolUse)) settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter((g: any) => !ownsGroup(g));
  try { fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`); } catch { /* best effort */ }
}

function reloadHint(): void {
  vscode.window.showInformationMessage(
    "Claude Review Gate enabled for Claude Code. In an already-running session run /hooks once " +
      "(or restart) to activate it; new sessions pick it up automatically.",
  );
}

async function maybeOfferEnable(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(ENABLED_KEY)) {
    await registerHooks(context); // refresh the install path silently (handles updates)
    return;
  }
  if (context.globalState.get<boolean>(DECLINED_KEY)) return;
  const choice = await vscode.window.showInformationMessage(
    "Enable Claude Review Gate for Claude Code? This adds a review hook to ~/.claude/settings.json " +
      "so your code changes open here for review before each turn ends.",
    "Enable",
    "Not now",
  );
  if (choice === "Enable") {
    if (await registerHooks(context)) {
      await context.globalState.update(ENABLED_KEY, true);
      reloadHint();
    }
  } else if (choice === "Not now") {
    await context.globalState.update(DECLINED_KEY, true);
  }
}

function onReview(id: string, req: ReviewRequest): void {
  void clearActive();
  const files = parseHunks(req.diff);
  active = {
    id,
    cwd: req.cwd,
    files: files.map((f) => f.file),
    approvedFiles: new Set(),
    fileUris: new Map(),
    threads: [],
    docMaps: new Map(),
  };

  void (async () => {
    for (const f of files) {
      const sbs = buildSideBySide(f);
      const baseUri = paneUri(id, "base", f.file);
      const modUri = paneUri(id, "mod", f.file);
      provider.set(baseUri, sbs.baseText);
      provider.set(modUri, sbs.modText);
      active!.docMaps.set(baseUri.toString(), { file: f.file, side: "old", map: sbs.baseMap });
      active!.docMaps.set(modUri.toString(), { file: f.file, side: "new", map: sbs.modMap });
      active!.fileUris.set(f.file, { base: baseUri, mod: modUri });
      // Native two-pane diff: base (left) ↔ changed (right).
      await vscode.commands.executeCommand(
        "vscode.diff", baseUri, modUri, `${f.file} (review)`, { preview: false },
      );
    }
    showButtons();
    // No popup notification — the Approve / Approve all buttons and the opened diff
    // tabs are the affordances. A transient, auto-dismissing status-bar message
    // signals the new review without nagging.
    vscode.window.setStatusBarMessage(
      `$(git-pull-request) Review — ${files.length} file(s): ` +
        `${req.title || "(untitled change)"}. Comment, then Approve each file or Approve all.`,
      8000,
    );
  })();
}

/** The file whose diff tab is currently focused, if any. */
function currentReviewFile(): string | undefined {
  if (!active) return undefined;
  const ed = vscode.window.activeTextEditor;
  if (ed) {
    const e = active.docMaps.get(ed.document.uri.toString());
    if (e) return e.file;
  }
  const tab = vscode.window.tabGroups.activeTabGroup?.activeTab;
  const input = tab?.input;
  if (input instanceof vscode.TabInputTextDiff) {
    const e =
      active.docMaps.get(input.modified.toString()) ?? active.docMaps.get(input.original.toString());
    if (e) return e.file;
  }
  return undefined;
}

/** Approve the currently-focused file and close its diff tab. When it's the last
 * file, finish the review (the verdict is decided by whether comments were left). */
async function approveFile(): Promise<void> {
  if (!active || !server) {
    vscode.window.showInformationMessage("Review Gate: no review is currently open.");
    return;
  }
  const file = currentReviewFile();
  if (!file) {
    vscode.window.showInformationMessage(
      "Review Gate: focus a file's diff to approve it, or use “Approve all”.",
    );
    return;
  }
  active.approvedFiles.add(file);
  await closeFileTabs(file);
  const remaining = active.files.filter((f) => !active!.approvedFiles.has(f));
  if (remaining.length === 0) {
    await finalize();
  } else {
    refreshApproveAll(remaining.length);
    vscode.window.setStatusBarMessage(
      `Review Gate: approved ${file} — ${remaining.length} file(s) left to review.`,
      4000,
    );
  }
}

/** Approve every file at once, close all review tabs, and finish the review. */
async function approveAll(): Promise<void> {
  if (!active || !server) {
    vscode.window.showInformationMessage("Review Gate: no review is currently open.");
    return;
  }
  for (const f of active.files) active.approvedFiles.add(f);
  await finalize();
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

/** Collect the human's inline comments anchored to file lines. */
function collectComments(): RawComment[] {
  const comments: RawComment[] = [];
  if (!active) return comments;
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
  return comments;
}

/** Send the verdict to the agent. The verdict is decided by the review itself:
 * any inline comments → request_changes (the agent resolves them); none → approve. */
async function finalize(): Promise<void> {
  if (!active || !server) return;

  const comments = collectComments();
  const verdict = comments.length > 0 ? "request_changes" : "approve";

  const ok = server.submitVerdict(active.id, verdict, "", comments);
  if (ok) {
    vscode.window.setStatusBarMessage(
      verdict === "approve"
        ? "Review Gate: approved — sent to the agent."
        : `Review Gate: ${comments.length} comment(s) sent to the agent to resolve.`,
      5000,
    );
  }
  await clearActive();
}

function bodyText(body: string | vscode.MarkdownString): string {
  return typeof body === "string" ? body : body.value;
}

/** Close the diff tab(s) for one file. */
async function closeFileTabs(file: string): Promise<void> {
  const uris = active?.fileUris.get(file);
  if (!uris) return;
  const want = new Set([uris.base.toString(), uris.mod.toString()]);
  const toClose: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputTextDiff &&
        (want.has(input.original.toString()) || want.has(input.modified.toString()))
      ) {
        toClose.push(tab);
      }
    }
  }
  if (toClose.length) await vscode.window.tabGroups.close(toClose);
}

/** Close every open review diff tab (any reviewgate-scheme diff). */
async function closeAllReviewTabs(): Promise<void> {
  const toClose: vscode.Tab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        input instanceof vscode.TabInputTextDiff &&
        (input.original.scheme === SCHEME || input.modified.scheme === SCHEME)
      ) {
        toClose.push(tab);
      }
    }
  }
  if (toClose.length) await vscode.window.tabGroups.close(toClose);
}

function refreshApproveAll(remaining: number): void {
  approveAllItem.text =
    remaining > 0 ? `$(check-all) Approve all (${remaining} left)` : "$(check-all) Approve all";
}

function showButtons(): void {
  refreshApproveAll(active ? active.files.length : 0);
  approveAllItem.tooltip =
    "Approve all files & finish the review. " +
    "Any inline comments are sent back for the agent to resolve.";
  approveAllItem.show();
  void vscode.commands.executeCommand("setContext", "claudeReviewGate.reviewActive", true);
}

async function clearActive(): Promise<void> {
  // Null `active` synchronously: onReview() calls this right before creating the next
  // review, so deferring the reset past an await would clobber the new one.
  const prev = active;
  active = undefined;
  approveAllItem?.hide();
  void vscode.commands.executeCommand("setContext", "claudeReviewGate.reviewActive", false);
  await closeAllReviewTabs();
  if (prev) for (const t of prev.threads) t.dispose();
}
