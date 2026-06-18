// Local HTTP gate server (no vscode). The MCP bridge POSTs a review and
// long-polls for the verdict; the extension calls submitVerdict() in-process
// when the human decides.

import * as http from "http";
import { codeContext } from "./diff.js";
import { Feedback, ReviewRequest, Side, Verdict } from "./types.js";

interface Pending {
  request: ReviewRequest;
  round: number;
  parentId?: string;
  feedback: Feedback | null;
  waiters: Array<(fb: Feedback | null) => void>;
}

export interface RawComment {
  file: string;
  line: number;
  side: Side;
  body: string;
}

export type OnReview = (id: string, req: ReviewRequest, round: number) => void;

const WAIT_MS = 25_000;

export class GateServer {
  private reviews = new Map<string, Pending>();
  private server: http.Server | null = null;
  private counter = 0;
  constructor(private onReview: OnReview) {}

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve());
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  getRequest(id: string): ReviewRequest | undefined {
    return this.reviews.get(id)?.request;
  }

  hasPending(): boolean {
    for (const r of this.reviews.values()) if (!r.feedback) return true;
    return false;
  }

  /** Called by the extension when the human sets a verdict. */
  submitVerdict(id: string, verdict: Verdict, summary: string, comments: RawComment[]): boolean {
    const p = this.reviews.get(id);
    if (!p || p.feedback) return false;
    p.feedback = {
      reviewId: id,
      round: p.round,
      verdict,
      summary,
      comments: comments.map((c) => ({
        ...c,
        code_context: codeContext(p.request.diff, c.file, c.line, c.side),
      })),
    };
    const waiters = p.waiters.splice(0);
    for (const w of waiters) w(p.feedback);
    return true;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/reviews") {
        const body = await readBody(req);
        const reqObj: ReviewRequest & { parentId?: string } = JSON.parse(body || "{}");
        if (!reqObj.diff || !reqObj.diff.trim()) return json(res, 400, { error: "empty diff" });
        const id = `rev_${++this.counter}_${Date.now().toString(36)}`;
        const parent = reqObj.parentId ? this.reviews.get(reqObj.parentId) : undefined;
        const round = parent ? parent.round + 1 : 1;
        this.reviews.set(id, {
          request: { diff: reqObj.diff, cwd: reqObj.cwd, title: reqObj.title },
          round, parentId: reqObj.parentId, feedback: null, waiters: [],
        });
        this.onReview(id, this.reviews.get(id)!.request, round);
        return json(res, 200, { id, round });
      }
      const m = url.pathname.match(/^\/reviews\/([^/]+)\/feedback$/);
      if (req.method === "GET" && m) {
        const p = this.reviews.get(m[1]);
        if (!p) return json(res, 404, { error: "not found" });
        if (p.feedback) return json(res, 200, p.feedback);
        if (url.searchParams.get("wait") !== "true") return json(res, 202, { status: "pending" });
        const fb = await this.waitForVerdict(p);
        if (fb) return json(res, 200, fb);
        return json(res, 202, { status: "pending" });
      }
      json(res, 404, { error: "no route" });
    } catch (e: any) {
      json(res, 500, { error: String(e?.message || e) });
    }
  }

  private waitForVerdict(p: Pending): Promise<Feedback | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = p.waiters.indexOf(onDone);
        if (i >= 0) p.waiters.splice(i, 1);
        resolve(null);
      }, WAIT_MS);
      const onDone = (fb: Feedback | null) => {
        clearTimeout(timer);
        resolve(fb);
      };
      p.waiters.push(onDone);
    });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(s);
}
