// Reconstruct a two-pane (base ↔ modified) view from a unified diff, with each
// pane line mapped back to its real file line. Self-contained: works from the
// diff alone, no need for the file to exist on disk. VS Code's native diff
// editor (vscode.diff) then renders the two reconstructed panes side by side.

const FILE_HEADER = /^\+\+\+ (?:b\/)?(.+)$/;
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export interface HunkLine {
  tag: " " | "+" | "-";
  text: string;
}
export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: HunkLine[];
}
export interface FileHunks {
  file: string;
  hunks: Hunk[];
}

export function parseHunks(diff: string): FileHunks[] {
  const files: FileHunks[] = [];
  let cur: FileHunks | null = null;
  let hunk: Hunk | null = null;
  for (const raw of diff.split("\n")) {
    const fh = raw.match(FILE_HEADER);
    if (fh) {
      cur = { file: fh[1], hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (raw.startsWith("--- ") || !cur) continue;
    const h = raw.match(HUNK);
    if (h) {
      hunk = { oldStart: parseInt(h[1], 10), newStart: parseInt(h[2], 10), lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk || raw.startsWith("\\")) continue;
    const tag = raw[0];
    if (tag === "+" || tag === "-" || tag === " ") {
      hunk.lines.push({ tag, text: raw.slice(1) });
    }
    // "diff --git", "index", "new file mode" etc. appear before a hunk → ignored.
  }
  return files;
}

const SENTINEL = "⋮"; // ⋮ — marks a gap between hunks (maps to null)

export interface SideBySide {
  baseText: string;
  baseMap: (number | null)[]; // base-pane line index → old-side file line (1-based)
  modText: string;
  modMap: (number | null)[]; // mod-pane line index → new-side file line (1-based)
}

export function buildSideBySide(file: FileHunks): SideBySide {
  const base: string[] = [];
  const baseMap: (number | null)[] = [];
  const mod: string[] = [];
  const modMap: (number | null)[] = [];

  file.hunks.forEach((h, hi) => {
    if (hi > 0) {
      base.push(SENTINEL);
      baseMap.push(null);
      mod.push(SENTINEL);
      modMap.push(null);
    }
    let oldLn = h.oldStart;
    let newLn = h.newStart;
    for (const l of h.lines) {
      if (l.tag === " ") {
        base.push(l.text);
        baseMap.push(oldLn++);
        mod.push(l.text);
        modMap.push(newLn++);
      } else if (l.tag === "-") {
        base.push(l.text);
        baseMap.push(oldLn++);
      } else {
        mod.push(l.text);
        modMap.push(newLn++);
      }
    }
  });

  return { baseText: base.join("\n"), baseMap, modText: mod.join("\n"), modMap };
}
