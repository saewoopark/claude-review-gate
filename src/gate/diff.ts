// Unified-diff parsing — mirrors reviewgate/diffutil.py. Used to know which
// files/lines changed (to scope the review) and to extract code context.

import { Side } from "./types.js";

export interface ChangedFile {
  path: string;
  newLines: number[]; // 1-based new-side line numbers that were added/changed
}

const FILE_HEADER = /^\+\+\+ (?:b\/)?(.+)$/;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface SideIndex {
  [path: string]: { new: Map<number, string>; old: Map<number, string> };
}

export function buildLineIndex(diff: string): SideIndex {
  const index: SideIndex = {};
  let cur: string | null = null;
  let oldLn = 0;
  let newLn = 0;
  for (const raw of diff.split("\n")) {
    const fh = raw.match(FILE_HEADER);
    if (fh) {
      cur = fh[1];
      if (!index[cur]) index[cur] = { new: new Map(), old: new Map() };
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (cur === null) continue;
    const h = raw.match(HUNK);
    if (h) {
      oldLn = parseInt(h[1], 10);
      newLn = parseInt(h[2], 10);
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const tag = raw[0];
    const text = raw.slice(1);
    if (tag === "+") {
      index[cur].new.set(newLn, text);
      newLn++;
    } else if (tag === "-") {
      index[cur].old.set(oldLn, text);
      oldLn++;
    } else if (tag === " ") {
      index[cur].old.set(oldLn, text);
      index[cur].new.set(newLn, text);
      oldLn++;
      newLn++;
    }
  }
  return index;
}

export function changedFiles(diff: string): ChangedFile[] {
  const index = buildLineIndex(diff);
  const out: ChangedFile[] = [];
  let cur: string | null = null;
  let oldLn = 0;
  let newLn = 0;
  const added: Record<string, number[]> = {};
  for (const raw of diff.split("\n")) {
    const fh = raw.match(FILE_HEADER);
    if (fh) {
      cur = fh[1];
      if (!added[cur]) added[cur] = [];
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (cur === null) continue;
    const h = raw.match(HUNK);
    if (h) {
      oldLn = parseInt(h[1], 10);
      newLn = parseInt(h[2], 10);
      continue;
    }
    if (raw.startsWith("\\")) continue;
    const tag = raw[0];
    if (tag === "+") {
      added[cur].push(newLn);
      newLn++;
    } else if (tag === "-") {
      oldLn++;
    } else if (tag === " ") {
      oldLn++;
      newLn++;
    }
  }
  for (const path of Object.keys(index)) {
    out.push({ path, newLines: added[path] || [] });
  }
  return out;
}

export function codeContext(
  diff: string,
  file: string,
  line: number,
  side: Side,
  ctx = 3,
): string {
  const index = buildLineIndex(diff);
  const sideMap = index[file]?.[side];
  if (!sideMap || !sideMap.has(line)) return "";
  const out: string[] = [];
  for (let ln = line - ctx; ln <= line + ctx; ln++) {
    if (sideMap.has(ln)) {
      const marker = ln === line ? ">" : " ";
      out.push(`${marker} ${String(ln).padStart(5)}: ${sideMap.get(ln)}`);
    }
  }
  return out.join("\n");
}
