// Local HTTP gate server (no vscode). The Stop hook POSTs a review and
// long-polls for the verdict; the extension calls submitVerdict() in-process
// when the human decides.

import * as http from "http";
import { codeContext } from "./diff.js";
import { Feedback, ReviewRequest, Side, Verdict } from "./types.js";

interface Pending {
  request: ReviewRequest;
  feedback: Feedback | null;
  waiters: Array<(fb: Feedback | null) => void>;
}

export interface RawComment {
  file: string;
  line: number;
  side: Side;
  body: string;
}

export type OnReview = (id: string, req: ReviewRequest) => void;

const WAIT_MS = 25_000;

export class GateServer {
  private reviews = new Map<string, Pending>();
  private server: http.Server | null = null;
  private counter = 0;
  constructor(private onReview: OnReview, private token?: string) {}

  /** Authorized iff no token is configured, or the request carries the right one. */
  private authed(req: http.IncomingMessage): boolean {
    if (!this.token) return true;
    return req.headers["x-review-gate-token"] === this.token;
  }

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
      // DNS-rebinding guard: only serve requests with a loopback Host header.
      if (!hostAllowed(req.headers.host)) return json(res, 403, { error: "forbidden host" });
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, { ok: true }); // liveness only — intentionally unauthenticated
      }
      if (req.method === "POST" && url.pathname === "/reviews") {
        if (!this.authed(req)) return json(res, 401, { error: "unauthorized" });
        const body = await readBody(req);
        const reqObj: ReviewRequest = JSON.parse(body || "{}");
        if (!reqObj.diff || !reqObj.diff.trim()) return json(res, 400, { error: "empty diff" });
        // Dedup: if an identical change is already awaiting review, return that one so
        // two concurrent hooks (e.g. a project-scoped + a user-global registration)
        // share a single review instead of opening duplicate tabs.
        for (const [existingId, p] of this.reviews) {
          if (!p.feedback && p.request.diff === reqObj.diff && p.request.cwd === reqObj.cwd) {
            return json(res, 200, { id: existingId });
          }
        }
        const id = `rev_${++this.counter}_${Date.now().toString(36)}`;
        this.reviews.set(id, {
          request: { diff: reqObj.diff, cwd: reqObj.cwd, title: reqObj.title },
          feedback: null, waiters: [],
        });
        this.onReview(id, this.reviews.get(id)!.request);
        return json(res, 200, { id });
      }
      const m = url.pathname.match(/^\/reviews\/([^/]+)\/feedback$/);
      if (req.method === "GET" && m) {
        if (!this.authed(req)) return json(res, 401, { error: "unauthorized" });
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

const MAX_BODY = 32 * 1024 * 1024; // 32 MB cap — generous for diffs, guards against local DoS

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let len = 0;
    req.on("data", (c) => {
      len += c.length;
      if (len > MAX_BODY) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Accept only loopback Host headers (blocks DNS-rebinding via a malicious domain). */
function hostAllowed(host?: string): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(s);
}
