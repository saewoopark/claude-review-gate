// Map each line of a rendered unified-diff document back to a concrete
// (file, side, line). The document shown to the reviewer IS the diff text, so
// document line index === diff line index, and a comment on doc line N resolves
// to lineMap[N]. Lines that aren't commentable code (headers, hunk markers) map
// to null.

import { Side } from "./types.js";

export interface DiffLineLoc {
  file: string;
  side: Side;
  line: number;
}

const FILE_HEADER = /^\+\+\+ (?:b\/)?(.+)$/;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function buildDiffLineMap(diff: string): (DiffLineLoc | null)[] {
  const map: (DiffLineLoc | null)[] = [];
  let cur: string | null = null;
  let oldLn = 0;
  let newLn = 0;
  for (const raw of diff.split("\n")) {
    const fh = raw.match(FILE_HEADER);
    if (fh) {
      cur = fh[1];
      map.push(null);
      continue;
    }
    if (raw.startsWith("--- ")) {
      map.push(null);
      continue;
    }
    const h = raw.match(HUNK);
    if (h) {
      oldLn = parseInt(h[1], 10);
      newLn = parseInt(h[2], 10);
      map.push(null);
      continue;
    }
    if (cur === null || raw.startsWith("\\")) {
      map.push(null);
      continue;
    }
    const tag = raw[0];
    if (tag === "+") {
      map.push({ file: cur, side: "new", line: newLn });
      newLn++;
    } else if (tag === "-") {
      map.push({ file: cur, side: "old", line: oldLn });
      oldLn++;
    } else if (tag === " ") {
      map.push({ file: cur, side: "new", line: newLn });
      oldLn++;
      newLn++;
    } else {
      map.push(null); // "diff --git", "index", "new file mode", etc.
    }
  }
  return map;
}
