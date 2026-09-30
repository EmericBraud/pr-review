// Pure helpers (no vscode import, so they can be tested with plain node).

export interface Hunks {
  /** 1-based inclusive line ranges of each hunk on the new (RIGHT) side. */
  newRanges: [number, number][];
  /** Same on the old (LEFT) side. */
  oldRanges: [number, number][];
  /** 1-based new-side lines that were added. */
  added: number[];
  /** New-side lines right before which old lines were removed. */
  deletedAt: number[];
}

export function parsePatch(patch = ''): Hunks {
  const h: Hunks = { newRanges: [], oldRanges: [], added: [], deletedAt: [] };
  let o = 0;
  let n = 0;
  for (const line of patch.split('\n')) {
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      o = +m[1];
      n = +m[3];
      const oc = m[2] === undefined ? 1 : +m[2];
      const nc = m[4] === undefined ? 1 : +m[4];
      if (nc) h.newRanges.push([n, n + nc - 1]);
      if (oc) h.oldRanges.push([o, o + oc - 1]);
    } else if (line.startsWith('+')) {
      h.added.push(n++);
    } else if (line.startsWith('-')) {
      if (h.deletedAt[h.deletedAt.length - 1] !== n) h.deletedAt.push(n);
      o++;
    } else if (!line.startsWith('\\')) {
      o++;
      n++;
    }
  }
  return h;
}

export interface Folder<T> {
  name: string;
  path: string;
  children: (Folder<T> | T)[];
}

/** VS Code-style folder tree: folders first, then items, both sorted; single-child folder chains compacted ("src/app"). */
export function folderTree<T>(items: T[], pathOf: (t: T) => string): (Folder<T> | T)[] {
  type Dir = { dirs: Map<string, Dir>; items: T[] };
  const root: Dir = { dirs: new Map(), items: [] };
  for (const item of items) {
    let d = root;
    for (const part of pathOf(item).split('/').slice(0, -1)) {
      if (!d.dirs.has(part)) d.dirs.set(part, { dirs: new Map(), items: [] });
      d = d.dirs.get(part)!;
    }
    d.items.push(item);
  }
  const build = (d: Dir, prefix: string): (Folder<T> | T)[] => [
    ...[...d.dirs.keys()].sort((a, b) => a.localeCompare(b)).map((key) => {
      let name = key;
      let sub = d.dirs.get(key)!;
      while (!sub.items.length && sub.dirs.size === 1) {
        const [[k, next]] = sub.dirs;
        name += '/' + k;
        sub = next;
      }
      return { name, path: prefix + name, children: build(sub, prefix + name + '/') };
    }),
    ...d.items.sort((a, b) => pathOf(a).localeCompare(pathOf(b))),
  ];
  return build(root, '');
}
