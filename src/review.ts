import * as vscode from 'vscode';
import * as path from 'path';
import { Repo, rest, restAll, graphql, run, gh, localHead, withProgress } from './github';
import { parsePatch, folderTree, Folder } from './patch';

export const SCHEME = 'pr-review';
const FILE_SCHEME = 'pr-review-file';
const NONE = 'none';

type Viewed = 'VIEWED' | 'UNVIEWED' | 'DISMISSED';
type Mode = 'full' | 'commits';
type Side = 'LEFT' | 'RIGHT';

interface ChangedFile {
  path: string;
  previous?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  /** blob sha of the new version */
  sha: string;
}
interface PrFile extends ChangedFile {
  viewed: Viewed;
}
interface Commit {
  sha: string;
  parent?: string;
  message: string;
  author: string;
  date: string;
  files?: ChangedFile[];
}
interface GhComment {
  id: string;
  databaseId: number;
  body: string;
  createdAt: string;
  viewerDidAuthor: boolean;
  state: string;
  author: { login: string; avatarUrl: string } | null;
}
interface GhThread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: Side;
  /** null for single-line threads, whose startLine is unreliable (on LEFT it's the new-side line). */
  startDiffSide: Side | null;
  comments: { nodes: GhComment[] };
}

type Leaf = { kind: 'file'; file: PrFile } | { kind: 'cfile'; commit: Commit; file: ChangedFile };
type Node = Leaf | { kind: 'commit'; commit: Commit } | { kind: 'dir'; path: string; name: string; commit?: Commit; children: Node[] };

const leavesOf = (nodes: Node[]): Leaf[] =>
  nodes.flatMap((n) => (n.kind === 'dir' ? leavesOf(n.children) : n.kind === 'commit' ? [] : [n]));

class Session {
  pr!: { id: string; title: string; url: string; headSha: string; mergeBase: string };
  files: PrFile[] = [];
  commits: Commit[] = [];
  threads: GhThread[] = [];
  pendingReviewId?: string;
  headIsLocal = false;
  constructor(readonly repo: Repo, readonly number: number) {}
  get api() {
    return `/repos/${this.repo.owner}/${this.repo.name}`;
  }
  get vars() {
    return { owner: this.repo.owner, name: this.repo.name, number: this.number };
  }
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    pending: reviews(states:PENDING,first:5){nodes{id viewerDidAuthor}}
    reviewThreads(first:100){nodes{id isResolved path line startLine diffSide startDiffSide
      comments(first:100){nodes{id databaseId body createdAt viewerDidAuthor state author{login avatarUrl}}}}}
  }}}`;

const VIEWED_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    files(first:100,after:$after){nodes{path viewerViewedState} pageInfo{hasNextPage endCursor}}
  }}}`;

const hasComment = (id: string) => (s: Session) => s.threads.some((t) => t.comments.nodes.some((c) => c.id === id));
const noPending = (s: Session) => !s.pendingReviewId && !s.threads.some((t) => t.comments.nodes.some((c) => c.state === 'PENDING'));

const toFile = (f: any): ChangedFile => ({
  path: f.filename,
  previous: f.previous_filename,
  status: f.status,
  additions: f.additions,
  deletions: f.deletions,
  patch: f.patch,
  sha: f.sha,
});

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<unknown>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

class Comment implements vscode.Comment {
  mode = vscode.CommentMode.Preview;
  body: string | vscode.MarkdownString;
  author: vscode.CommentAuthorInformation;
  label?: string;
  contextValue: string;
  timestamp: Date;
  constructor(readonly gh: GhComment, readonly parent: vscode.CommentThread) {
    this.body = new vscode.MarkdownString(gh.body);
    this.author = { name: gh.author?.login ?? 'ghost', iconPath: gh.author ? vscode.Uri.parse(gh.author.avatarUrl) : undefined };
    this.label = gh.state === 'PENDING' ? 'Pending' : undefined;
    this.contextValue = gh.viewerDidAuthor ? 'mine' : '';
    this.timestamp = new Date(gh.createdAt);
  }
}

export class Review implements vscode.TreeDataProvider<Node>, vscode.TextDocumentContentProvider, vscode.FileDecorationProvider {
  s?: Session;
  private mode: Mode = 'full';
  private current?: Leaf;
  private nodes = new Map<string, Node>();
  private parents = new Map<Node, Node>();
  private diffNodes = new Map<string, Leaf>();
  private commitViewed = new Set<string>();
  private decoPatch = new Map<string, string | undefined>();
  private content = new Map<string, Promise<string>>();
  private vsThreads = new Map<vscode.CommentThread, GhThread>();
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private tree: vscode.TreeView<Node>;
  private controller = vscode.comments.createCommentController('pr-review', 'PR Review');
  private status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  private added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private removed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    borderStyle: 'solid',
    borderWidth: '2px 0 0 0',
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });

  constructor(private ctx: vscode.ExtensionContext, private onReviewSubmitted: () => void) {
    this.tree = vscode.window.createTreeView('prReview.review', { treeDataProvider: this, manageCheckboxStateManually: true });
    this.controller.options = { prompt: 'Comment on this line…', placeHolder: 'Leave a comment — Markdown supported' };
    this.status.command = 'prReview.toggleMode';
    ctx.subscriptions.push(
      this.tree,
      this.controller,
      this.status,
      this.added,
      this.removed,
      vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
      vscode.window.registerFileDecorationProvider(this),
      this.tree.onDidChangeCheckboxState(async (e) => {
        for (const [n, state] of e.items) await this.check(n, state === vscode.TreeItemCheckboxState.Checked);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        this.decorate();
        if (this.s) this.syncHead(); // catches a checkout done from the terminal
      }),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        const n = ed && this.diffNodes.get(ed.document.uri.toString());
        if (n && n !== this.current) {
          this.current = n;
          this.refreshUi();
        }
      }),
      vscode.window.onDidChangeWindowState(async (w) => {
        if (w.focused && this.s) this.syncHead();
      }),
    );
    this.refreshUi();
  }

  // ---------- session lifecycle ----------

  async start(repo: Repo, number: number, opts: { mode?: Mode; commit?: string; open?: boolean } = {}) {
    const s = this.s?.number === number && this.s.repo.root.fsPath === repo.root.fsPath ? this.s : new Session(repo, number);
    if (opts.mode) this.mode = opts.mode;
    if (s === this.s) {
      this.refreshUi();
    } else {
      if (!(await withProgress(`Loading PR #${number}…`, () => this.load(s).then(() => true)))) return;
      this.clearThreads();
      this.s = s;
      this.nodes.clear();
      this.parents.clear();
      this.diffNodes.clear();
      this.decoPatch.clear();
      this.current = undefined;
      this.commitViewed = new Set(this.ctx.globalState.get<string[]>(this.stateKey) ?? []);
      this.afterLoad();
    }
    this.ctx.workspaceState.update('prReview.session', { number, mode: this.mode });
    if (opts.open === false) return;
    vscode.commands.executeCommand('prReview.review.focus');
    if (opts.commit) {
      const c = s.commits.find((c) => c.sha.startsWith(opts.commit!));
      if (c) return this.stepCommit(0, c);
    }
    await this.next(false);
  }

  async refresh() {
    const s = this.s;
    if (!s) return;
    const cur = this.current && this.id(this.current);
    await withProgress(`Refreshing PR #${s.number}…`, () => this.load(s));
    this.nodes.clear();
    this.parents.clear();
    this.diffNodes.clear();
    this.current = undefined;
    if (cur) this.current = (await this.list()).find((n) => this.id(n) === cur);
    this.afterLoad();
  }

  exit() {
    this.clearThreads();
    this.s = undefined;
    this.ctx.workspaceState.update('prReview.session', undefined);
    this.afterLoad();
  }

  private async load(s: Session) {
    const [pr, files, commits] = await Promise.all([
      rest(`${s.api}/pulls/${s.number}`),
      restAll(`${s.api}/pulls/${s.number}/files`),
      restAll(`${s.api}/pulls/${s.number}/commits`, 3),
    ]);
    // The PR diff is computed against the merge base, not the base branch tip.
    const mergeBase = await rest(`${s.api}/compare/${pr.base.sha}...${pr.head.sha}?per_page=1`)
      .then((c) => c.merge_base_commit.sha as string)
      .catch(() => pr.base.sha as string);
    s.pr = { id: pr.node_id, title: pr.title, url: pr.html_url, headSha: pr.head.sha, mergeBase };
    s.files = files.map((f) => ({ ...toFile(f), viewed: 'UNVIEWED' as Viewed })).sort((a, b) => a.path.localeCompare(b.path));
    const known = new Map(s.commits.map((c) => [c.sha, c]));
    s.commits = commits.map((c) => known.get(c.sha) ?? {
      sha: c.sha,
      parent: c.parents[0]?.sha,
      message: c.commit.message,
      author: c.author?.login ?? c.commit.author.name,
      date: c.commit.author.date,
    });
    await Promise.all([this.loadThreads(s), this.loadViewed(s)]);
    s.headIsLocal = (await localHead(s.repo)) === s.pr.headSha;
  }

  private async loadThreads(s: Session) {
    const pr = (await graphql(THREADS_QUERY, s.vars)).repository.pullRequest;
    // ponytail: first 100 threads only; paginate reviewThreads if PRs get that busy.
    s.threads = pr.reviewThreads.nodes;
    s.pendingReviewId = pr.pending.nodes.find((r: any) => r.viewerDidAuthor)?.id;
  }

  private async loadViewed(s: Session) {
    const viewed = new Map<string, Viewed>();
    let after: string | null = null;
    do {
      const files: any = (await graphql(VIEWED_QUERY, { ...s.vars, after })).repository.pullRequest.files;
      for (const f of files.nodes) viewed.set(f.path, f.viewerViewedState);
      after = files.pageInfo.hasNextPage ? files.pageInfo.endCursor : null;
    } while (after);
    for (const f of s.files) f.viewed = viewed.get(f.path) ?? 'UNVIEWED';
  }

  /** GitHub reads lag 1-2 s behind writes: re-read until the mutation shows up (5 s max). */
  private async reloadThreads(visible: (s: Session) => boolean) {
    const s = this.s!;
    for (let i = 0; i < 10; i++) {
      await this.loadThreads(s);
      if (visible(s)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    this.renderThreads();
    this.refreshUi();
  }

  /** Runs a mutation returning "is it visible yet?", then re-syncs with GitHub — even when it failed, since
   *  GitHub sometimes errors after applying the change. Resolves to whether the mutation succeeded. */
  private async mutate(title: string, run: () => Promise<(s: Session) => boolean>) {
    return (await withProgress(title, async () => {
      let visible = (_: Session) => true;
      try {
        visible = await run();
      } finally {
        await this.reloadThreads(visible);
      }
      return true;
    })) === true;
  }

  private afterLoad() {
    this.renderThreads();
    this.refreshUi();
    this.decorate();
    // Re-assigning the provider makes VS Code re-query the commenting ranges of open editors.
    this.controller.commentingRangeProvider = { provideCommentingRanges: (doc) => this.commentRanges(doc.uri) };
  }

  private async syncHead() {
    const s = this.s!;
    const local = (await localHead(s.repo)) === s.pr.headSha;
    if (local !== s.headIsLocal) {
      s.headIsLocal = local;
      this.afterLoad();
    }
  }

  async checkout(repo: Repo, number: number) {
    const ok = await withProgress(`Checking out PR #${number}…`, () => gh(['pr', 'checkout', String(number)], repo.root.fsPath));
    if (ok !== undefined) vscode.window.setStatusBarMessage(`$(check) Checked out PR #${number}`, 4000);
    if (this.s) await this.syncHead();
  }

  private get stateKey() {
    return `viewed:${this.s?.repo.owner}/${this.s?.repo.name}#${this.s?.number}`;
  }

  // ---------- tree ----------

  private id(n: Node) {
    switch (n.kind) {
      case 'file':
        return `f:${n.file.path}`;
      case 'cfile':
        return `cf:${n.commit.sha}:${n.file.path}`;
      case 'commit':
        return `c:${n.commit.sha}`;
      case 'dir':
        return `d:${n.commit?.sha ?? ''}:${n.path}`;
    }
  }

  private node<T extends Node>(n: T): T {
    const id = this.id(n);
    if (!this.nodes.has(id)) this.nodes.set(id, n);
    return this.nodes.get(id) as T;
  }

  private async loadCommit(c: Commit) {
    c.files ??= (await rest(`${this.s!.api}/commits/${c.sha}`)).files.map(toFile);
  }

  /** Folder tree of the PR files, or of one commit's files. Also records parents for reveal(). */
  private folders(commit?: Commit): Node[] {
    const leaves: Leaf[] = commit
      ? commit.files!.map((file) => this.node({ kind: 'cfile', commit, file }))
      : this.s!.files.map((file) => this.node({ kind: 'file', file }));
    const toNode = (x: Folder<Leaf> | Leaf, parent?: Node): Node => {
      const n: Node = 'children' in x ? this.node<Node>({ kind: 'dir', path: x.path, name: x.name, commit, children: [] }) : x;
      if (parent) this.parents.set(n, parent);
      if ('children' in x && n.kind === 'dir') n.children = x.children.map((c) => toNode(c, n));
      return n;
    };
    const parent = commit && this.node<Node>({ kind: 'commit', commit });
    return folderTree(leaves, (l) => l.file.path).map((x) => toNode(x, parent));
  }

  /** Files in review order (tree order) for the current mode. */
  private async list(): Promise<Leaf[]> {
    const s = this.s!;
    if (this.mode === 'full') return leavesOf(this.folders());
    await pool(s.commits, 8, (c) => this.loadCommit(c));
    return s.commits.flatMap((c) => leavesOf(this.folders(c)));
  }

  async getChildren(n?: Node): Promise<Node[]> {
    const s = this.s;
    if (!s) return [];
    if (n?.kind === 'commit') return this.folders(n.commit);
    if (n?.kind === 'dir') return n.children;
    if (n) return [];
    if (this.mode === 'full') return this.folders();
    await pool(s.commits, 8, (c) => this.loadCommit(c));
    return s.commits.map((commit) => this.node({ kind: 'commit', commit }));
  }

  getParent(n: Node) {
    return this.parents.get(n);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const checkbox = (on: boolean) => ({
      state: on ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: on ? 'Viewed' : 'Mark as viewed',
    });
    if (n.kind === 'commit') {
      const c = n.commit;
      const [headline, ...body] = c.message.split('\n');
      const isCurrent = this.currentCommit === c;
      const item = new vscode.TreeItem(headline, isCurrent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = this.id(n);
      const i = this.s!.commits.indexOf(c) + 1;
      item.description = `${i}/${this.s!.commits.length} · ${c.sha.slice(0, 7)} · ${c.author}`;
      item.tooltip = new vscode.MarkdownString(`**${headline}**\n\n${body.join('\n').trim()}\n\n\`${c.sha.slice(0, 7)}\` by ${c.author} · ${new Date(c.date).toLocaleString()}`);
      item.iconPath = new vscode.ThemeIcon(isCurrent ? 'debug-stackframe' : 'git-commit');
      item.checkboxState = checkbox(this.isChecked(n));
      return item;
    }
    if (n.kind === 'dir') {
      const leaves = leavesOf(n.children);
      const done = leaves.filter((l) => this.isChecked(l)).length;
      const item = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.Expanded);
      item.id = this.id(n);
      item.resourceUri = vscode.Uri.from({ scheme: FILE_SCHEME, path: '/' + n.path });
      item.iconPath = vscode.ThemeIcon.Folder;
      item.description = done === leaves.length ? '' : `${done}/${leaves.length}`;
      item.tooltip = `${n.path}/ — ${done}/${leaves.length} files viewed`;
      item.checkboxState = checkbox(done === leaves.length);
      return item;
    }
    const f = n.file;
    const item = new vscode.TreeItem(path.posix.basename(f.path));
    item.id = this.id(n);
    item.resourceUri = vscode.Uri.from({ scheme: FILE_SCHEME, path: '/' + f.path, query: f.status });
    const dismissed = n.kind === 'file' && n.file.viewed === 'DISMISSED';
    item.description = `${dismissed ? '⟳ changed since viewed · ' : ''}+${f.additions} −${f.deletions}`;
    item.tooltip = `${f.previous ? `${f.previous} → ` : ''}${f.path}\n${f.status} · +${f.additions} −${f.deletions}${f.patch ? '' : '\n(no textual diff: binary or too large)'}`;
    item.checkboxState = checkbox(this.isChecked(n));
    item.command = { command: 'prReview.openDiff', title: 'Open diff', arguments: [n] };
    return item;
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== FILE_SCHEME || !uri.query) return; // folders have no status
    const [badge, color] = ({
      added: ['A', 'gitDecoration.addedResourceForeground'],
      removed: ['D', 'gitDecoration.deletedResourceForeground'],
      renamed: ['R', 'gitDecoration.renamedResourceForeground'],
    } as Record<string, string[]>)[uri.query] ?? ['M', 'gitDecoration.modifiedResourceForeground'];
    return { badge, color: new vscode.ThemeColor(color), tooltip: uri.query };
  }

  private get currentCommit() {
    return this.current?.kind === 'cfile' ? this.current.commit : undefined;
  }

  // ---------- viewed state ----------

  private isChecked(n: Node): boolean {
    if (n.kind === 'file') return n.file.viewed === 'VIEWED';
    if (n.kind === 'cfile') return this.commitViewed.has(`${n.commit.sha}:${n.file.path}`);
    if (n.kind === 'dir') return leavesOf(n.children).every((l) => this.isChecked(l));
    return !!n.commit.files && n.commit.files.every((file) => this.isChecked({ kind: 'cfile', commit: n.commit, file }));
  }

  private async check(n: Node, on: boolean): Promise<void> {
    if (n.kind === 'dir') return pool(leavesOf(n.children), 4, (l) => this.check(l, on));
    if (n.kind === 'file') return this.setViewed(n.file, on);
    const files = n.kind === 'cfile' ? [n.file] : n.commit.files ?? [];
    for (const f of files) this.commitViewed[on ? 'add' : 'delete'](`${n.commit.sha}:${f.path}`);
    this.ctx.globalState.update(this.stateKey, [...this.commitViewed]);
    this.refreshUi();
    // Once every commit touching a file has been viewed, the whole file is reviewed: sync that to GitHub.
    const s = this.s!;
    if (on) {
      for (const f of files) {
        const pf = s.files.find((x) => x.path === f.path);
        const done = s.commits.every((c) => !c.files?.some((x) => x.path === f.path) || this.commitViewed.has(`${c.sha}:${f.path}`));
        if (pf && done) await this.setViewed(pf, true);
      }
    }
  }

  private async setViewed(f: PrFile, on: boolean) {
    const s = this.s!;
    if ((f.viewed === 'VIEWED') === on) return;
    const prev = f.viewed;
    f.viewed = on ? 'VIEWED' : 'UNVIEWED';
    this.refreshUi();
    try {
      await graphql(`mutation($id:ID!,$path:String!){ ${on ? 'markFileAsViewed' : 'unmarkFileAsViewed'}(input:{pullRequestId:$id,path:$path}){clientMutationId} }`, { id: s.pr.id, path: f.path });
    } catch (e: any) {
      f.viewed = prev;
      this.refreshUi();
      vscode.window.showErrorMessage(`Could not update viewed state: ${e.message}`);
    }
  }

  // ---------- navigation & diffs ----------

  private uri(p: string, ref: string) {
    return vscode.Uri.from({ scheme: SCHEME, path: '/' + p, query: ref });
  }

  async open(n: Node, opts: vscode.TextDocumentShowOptions = {}) {
    const s = this.s;
    if (!s || n.kind === 'commit' || n.kind === 'dir') return;
    const f = n.file;
    const name = path.posix.basename(f.path);
    let left: vscode.Uri, right: vscode.Uri, title: string;
    if (n.kind === 'file') {
      left = f.status === 'added' ? this.uri(f.path, NONE) : this.uri(f.previous ?? f.path, s.pr.mergeBase);
      right = f.status === 'removed' ? this.uri(f.path, NONE) : this.uri(f.path, s.pr.headSha);
      title = `${name} (#${s.number})`;
      this.decoPatch.delete(f.path);
    } else {
      const c = n.commit;
      // Same content as the PR head → reuse the head document so comments and threads work there too.
      const atHead = s.files.find((x) => x.path === f.path)?.sha === f.sha;
      left = f.status === 'added' || !c.parent ? this.uri(f.path, NONE) : this.uri(f.previous ?? f.path, c.parent);
      right = f.status === 'removed' ? this.uri(f.path, NONE) : this.uri(f.path, atHead ? s.pr.headSha : c.sha);
      title = `${name} @ ${c.sha.slice(0, 7)} · ${c.message.split('\n')[0]}`;
      if (atHead) this.decoPatch.set(f.path, f.patch);
      else this.decoPatch.delete(f.path);
    }
    this.current = n;
    this.diffNodes.set(left.toString(), n);
    this.diffNodes.set(right.toString(), n);
    this.refreshUi();
    if (this.tree.visible) {
      this.folders(n.kind === 'cfile' ? n.commit : undefined); // parents must be known before reveal()
      this.tree.reveal(n, { select: true, focus: false, expand: true }).then(undefined, () => {});
    }
    // VS Code reuses a tab showing the same two documents and keeps its old title (e.g. full PR vs. first commit): close it.
    const stale = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) =>
      t.input instanceof vscode.TabInputTextDiff && t.label !== title &&
      t.input.original.toString() === left.toString() && t.input.modified.toString() === right.toString());
    await vscode.window.tabGroups.close(stale);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, ...opts });
  }

  /** Opens the next unviewed file (optionally marking the current one as viewed first). */
  async next(markCurrent: boolean) {
    const s = this.s;
    if (!s) return;
    const list = await this.list();
    const i = this.current ? list.indexOf(this.current) : -1;
    if (markCurrent && i >= 0) await this.check(list[i], true);
    const next = [...list.slice(i + 1), ...list.slice(0, i + 1)].find((n) => !this.isChecked(n));
    if (next) return this.open(next);
    const a = await vscode.window.showInformationMessage(`All files of PR #${s.number} are viewed 🎉`, 'Submit review');
    if (a) this.submit();
  }

  async stepCommit(delta: number, target?: Commit) {
    const s = this.s;
    if (!s || !s.commits.length) return;
    this.mode = 'commits';
    const cur = this.currentCommit ? s.commits.indexOf(this.currentCommit) : delta > 0 ? -1 : s.commits.length;
    const c = target ?? s.commits[Math.max(0, Math.min(s.commits.length - 1, cur + delta))];
    await this.loadCommit(c);
    const file = c.files!.find((file) => !this.isChecked({ kind: 'cfile', commit: c, file })) ?? c.files![0];
    if (file) await this.open(this.node({ kind: 'cfile', commit: c, file }));
    else this.refreshUi();
  }

  toggleMode(mode?: Mode) {
    this.mode = mode ?? (this.mode === 'full' ? 'commits' : 'full');
    this.ctx.workspaceState.update('prReview.session', this.s && { number: this.s.number, mode: this.mode });
    this.refreshUi();
  }

  /** Workspace file ↔ diff. */
  async openFile(uri?: vscode.Uri) {
    const s = this.s;
    const ed = vscode.window.activeTextEditor;
    uri ??= ed?.document.uri;
    if (!s || uri?.scheme !== SCHEME) return;
    const t = this.target(uri);
    const p = t?.path ?? uri.path.slice(1);
    await this.syncHead();
    if (!s.headIsLocal) {
      const a = await vscode.window.showWarningMessage(
        `PR #${s.number} is not checked out: the local file may differ from the PR, so changed lines can't be highlighted.`,
        'Checkout PR branch',
        'Open anyway',
      );
      if (!a) return;
      if (a !== 'Open anyway') await this.checkout(s.repo, s.number);
    }
    const line = t?.side === 'RIGHT' && ed?.document.uri.toString() === uri.toString() ? ed.selection.active.line : 0;
    await vscode.window.showTextDocument(vscode.Uri.joinPath(s.repo.root, p), { preview: false, selection: new vscode.Range(line, 0, line, 0) });
  }

  async openDiffFor(uri?: vscode.Uri) {
    const s = this.s;
    uri ??= vscode.window.activeTextEditor?.document.uri;
    if (!s || !uri) return;
    const rel = path.relative(s.repo.root.fsPath, uri.fsPath).split(path.sep).join('/');
    const nodes = (await this.list()).filter((n) => n.file.path === rel);
    const n = nodes.find((n) => n === this.current) ?? nodes[nodes.length - 1];
    const line = vscode.window.activeTextEditor?.selection.active.line ?? 0;
    if (n) await this.open(n, { selection: new vscode.Range(line, 0, line, 0) });
  }

  async openThread(repo: Repo, number: number, file: string, line?: number) {
    if (this.s?.number !== number) await this.start(repo, number, { open: false });
    const f = this.s?.files.find((f) => f.path === file);
    if (!f) return vscode.window.showWarningMessage(`${file} is no longer part of PR #${number}.`);
    this.mode = 'full';
    await this.open(this.node({ kind: 'file', file: f }), line ? { selection: new vscode.Range(line - 1, 0, line - 1, 0) } : {});
  }

  provideTextDocumentContent(uri: vscode.Uri): Promise<string> | string {
    const s = this.s;
    if (!s || uri.query === NONE) return '';
    const p = uri.path.slice(1);
    const key = `${uri.query}:${p}`;
    let c = this.content.get(key);
    if (!c) {
      // Commits are immutable, so the cache never goes stale. Local git first (fast), API for commits not fetched locally.
      c = run('git', ['show', `${uri.query}:${p}`], s.repo.root.fsPath).catch(() =>
        rest<string>(`${s.api}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${uri.query}`, { accept: 'application/vnd.github.raw' }),
      );
      this.content.set(key, c);
      c.catch(() => this.content.delete(key));
    }
    return c;
  }

  // ---------- comments ----------

  /** Where a document sits in the PR diff, if comments can be anchored on it. */
  private target(uri: vscode.Uri): { path: string; side: Side } | undefined {
    const s = this.s;
    if (!s) return;
    if (uri.scheme === SCHEME) {
      const p = uri.path.slice(1);
      if (uri.query === s.pr.headSha) return { path: p, side: 'RIGHT' };
      if (uri.query === s.pr.mergeBase) {
        const f = s.files.find((f) => (f.previous ?? f.path) === p);
        return f && { path: f.path, side: 'LEFT' };
      }
    } else if (uri.scheme === 'file' && s.headIsLocal) {
      const rel = path.relative(s.repo.root.fsPath, uri.fsPath).split(path.sep).join('/');
      if (s.files.some((f) => f.path === rel)) return { path: rel, side: 'RIGHT' };
    }
  }

  private commentRanges(uri: vscode.Uri) {
    const t = this.target(uri);
    if (!t) return [];
    const h = parsePatch(this.s!.files.find((f) => f.path === t.path)?.patch);
    return (t.side === 'RIGHT' ? h.newRanges : h.oldRanges).map(([a, b]) => new vscode.Range(a - 1, 0, b - 1, 0));
  }

  private clearThreads() {
    for (const t of this.vsThreads.keys()) t.dispose();
    this.vsThreads.clear();
  }

  private renderThreads() {
    this.clearThreads();
    const s = this.s;
    if (!s) return;
    for (const th of s.threads) {
      if (th.line == null) continue; // outdated: listed in the PR overview only
      const f = s.files.find((f) => f.path === th.path);
      const uris = th.diffSide === 'LEFT'
        ? [this.uri(f?.previous ?? th.path, s.pr.mergeBase)]
        : [this.uri(th.path, s.pr.headSha), ...(s.headIsLocal ? [vscode.Uri.joinPath(s.repo.root, th.path)] : [])];
      for (const uri of uris) {
        const start = th.startDiffSide && th.startLine ? th.startLine : th.line;
        const t = this.controller.createCommentThread(uri, new vscode.Range(start - 1, 0, th.line - 1, 0), []);
        t.comments = th.comments.nodes.map((c) => new Comment(c, t));
        const pending = th.comments.nodes.some((c) => c.state === 'PENDING');
        t.label = pending ? 'Pending' : th.isResolved ? 'Resolved' : undefined;
        t.state = th.isResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
        t.contextValue = th.isResolved ? 'resolved' : 'unresolved';
        t.collapsibleState = th.isResolved ? vscode.CommentThreadCollapsibleState.Collapsed : vscode.CommentThreadCollapsibleState.Expanded;
        this.vsThreads.set(t, th);
      }
    }
  }

  async comment(reply: vscode.CommentReply, pending: boolean) {
    const s = this.s;
    if (!s) return;
    const th = this.vsThreads.get(reply.thread);
    const t = this.target(reply.thread.uri);
    const r = reply.thread.range;
    if (!th && (!t || !r)) {
      return vscode.window.showWarningMessage('Comments can only be added on the PR diff (in commit mode: files unchanged by later commits).');
    }
    const multi = r && r.start.line < r.end.line;
    await this.mutate('Posting comment…', async () => {
      let id: string;
      if (pending) {
        s.pendingReviewId ??= (await graphql(
          `mutation($pr:ID!,$sha:GitObjectID){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$sha}){pullRequestReview{id}}}`,
          { pr: s.pr.id, sha: s.pr.headSha },
        )).addPullRequestReview.pullRequestReview.id;
        if (th) {
          id = (await graphql(
            `mutation($review:ID!,$thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewId:$review,pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}`,
            { review: s.pendingReviewId, thread: th.id, body: reply.text },
          )).addPullRequestReviewThreadReply.comment.id;
        } else {
          id = (await graphql(
            `mutation($review:ID!,$path:String!,$body:String!,$line:Int!,$side:DiffSide!,$startLine:Int,$startSide:DiffSide){
              addPullRequestReviewThread(input:{pullRequestReviewId:$review,path:$path,body:$body,line:$line,side:$side,startLine:$startLine,startSide:$startSide}){thread{comments(first:1){nodes{id}}}}}`,
            { review: s.pendingReviewId, path: t!.path, body: reply.text, line: r!.end.line + 1, side: t!.side, startLine: multi ? r!.start.line + 1 : null, startSide: multi ? t!.side : null },
          )).addPullRequestReviewThread.thread.comments.nodes[0].id;
        }
      } else if (th) {
        id = (await rest(`${s.api}/pulls/${s.number}/comments/${th.comments.nodes[0].databaseId}/replies`, { method: 'POST', body: { body: reply.text } })).node_id;
      } else {
        id = (await rest(`${s.api}/pulls/${s.number}/comments`, {
          method: 'POST',
          body: { body: reply.text, commit_id: s.pr.headSha, path: t!.path, line: r!.end.line + 1, side: t!.side, ...(multi ? { start_line: r!.start.line + 1, start_side: t!.side } : {}) },
        })).node_id;
      }
      if (!th) reply.thread.dispose();
      return hasComment(id);
    });
  }

  editComment(c: Comment) {
    c.mode = vscode.CommentMode.Editing;
    c.parent.comments = [...c.parent.comments];
  }

  cancelEdit(c: Comment) {
    c.body = new vscode.MarkdownString(c.gh.body);
    c.mode = vscode.CommentMode.Preview;
    c.parent.comments = [...c.parent.comments];
  }

  async saveComment(c: Comment) {
    const body = typeof c.body === 'string' ? c.body : c.body.value;
    await this.mutate('Saving comment…', async () => {
      await graphql(`mutation($id:ID!,$body:String!){updatePullRequestReviewComment(input:{pullRequestReviewCommentId:$id,body:$body}){clientMutationId}}`, { id: c.gh.id, body });
      return (s) => s.threads.some((t) => t.comments.nodes.some((x) => x.id === c.gh.id && x.body === body));
    });
  }

  async deleteComment(c: Comment) {
    if ((await vscode.window.showWarningMessage('Delete this comment?', { modal: true }, 'Delete')) !== 'Delete') return;
    await this.mutate('Deleting comment…', async () => {
      await graphql(`mutation($id:ID!){deletePullRequestReviewComment(input:{id:$id}){clientMutationId}}`, { id: c.gh.id });
      return (s) => !hasComment(c.gh.id)(s);
    });
  }

  async resolve(thread: vscode.CommentThread, resolved: boolean) {
    const th = this.vsThreads.get(thread);
    if (!th) return;
    await this.mutate(resolved ? 'Resolving thread…' : 'Reopening thread…', async () => {
      await graphql(`mutation($id:ID!){${resolved ? 'resolveReviewThread' : 'unresolveReviewThread'}(input:{threadId:$id}){clientMutationId}}`, { id: th.id });
      return (s) => s.threads.find((t) => t.id === th.id)?.isResolved === resolved;
    });
  }

  async submit() {
    const s = this.s;
    if (!s) return;
    const pending = s.threads.flatMap((t) => t.comments.nodes).filter((c) => c.state === 'PENDING').length;
    const pick = await vscode.window.showQuickPick(
      [
        { label: '$(comment) Comment', detail: 'Submit general feedback without explicit approval', event: 'COMMENT' },
        { label: '$(check) Approve', detail: 'Approve merging these changes', event: 'APPROVE' },
        { label: '$(request-changes) Request changes', detail: 'Submit feedback that must be addressed before merging', event: 'REQUEST_CHANGES' },
      ],
      { title: `Submit review on #${s.number}${pending ? ` — ${pending} pending comment${pending > 1 ? 's' : ''}` : ''}` },
    );
    if (!pick) return;
    const body = await vscode.window.showInputBox({
      title: `${pick.label.replace(/\$\(.*?\) /, '')} — #${s.number}`,
      prompt: 'Review summary (Markdown). Optional when approving or when you left comments.',
      ignoreFocusOut: true,
    });
    if (body === undefined) return;
    const ok = await this.mutate('Submitting review…', async () => {
      if (s.pendingReviewId) {
        await graphql(`mutation($id:ID!,$event:PullRequestReviewEvent!,$body:String){submitPullRequestReview(input:{pullRequestReviewId:$id,event:$event,body:$body}){clientMutationId}}`, { id: s.pendingReviewId, event: pick.event, body });
      } else {
        await graphql(`mutation($pr:ID!,$sha:GitObjectID,$event:PullRequestReviewEvent!,$body:String){addPullRequestReview(input:{pullRequestId:$pr,commitOID:$sha,event:$event,body:$body}){clientMutationId}}`, { pr: s.pr.id, sha: s.pr.headSha, event: pick.event, body });
      }
      return noPending;
    });
    if (!ok) return;
    vscode.window.showInformationMessage(`Review submitted on PR #${s.number}.`, 'Open on GitHub').then((a) => a && vscode.env.openExternal(vscode.Uri.parse(s.pr.url)));
    this.onReviewSubmitted();
  }

  async discard() {
    const s = this.s;
    if (!s?.pendingReviewId) return;
    if ((await vscode.window.showWarningMessage('Discard your pending review and all its comments?', { modal: true }, 'Discard')) !== 'Discard') return;
    await this.mutate('Discarding review…', async () => {
      await graphql(`mutation($id:ID!){deletePullRequestReview(input:{pullRequestReviewId:$id}){clientMutationId}}`, { id: s.pendingReviewId });
      return noPending;
    });
  }

  // ---------- chrome ----------

  private decorate() {
    const s = this.s;
    for (const ed of vscode.window.visibleTextEditors) {
      const t = ed.document.uri.scheme === 'file' ? this.target(ed.document.uri) : undefined;
      const f = t && s!.files.find((f) => f.path === t.path);
      const h = parsePatch(f && (this.decoPatch.has(f.path) ? this.decoPatch.get(f.path) : f.patch));
      const line = (l: number) => new vscode.Range(Math.min(l, ed.document.lineCount) - 1, 0, Math.min(l, ed.document.lineCount) - 1, 0);
      ed.setDecorations(this.added, h.added.map(line));
      ed.setDecorations(this.removed, h.deletedAt.map(line));
    }
  }

  private refreshUi() {
    const s = this.s;
    const set = (k: string, v: unknown) => vscode.commands.executeCommand('setContext', `prReview.${k}`, v);
    set('active', !!s);
    set('mode', this.mode);
    set('pending', !!s?.pendingReviewId);
    set('filePaths', s ? s.files.map((f) => vscode.Uri.joinPath(s.repo.root, f.path).fsPath) : []);
    this.changed.fire();
    if (!s) {
      this.tree.title = 'Review';
      this.tree.description = '';
      this.tree.message = undefined;
      this.status.hide();
      return;
    }
    this.tree.title = `#${s.number} ${s.pr.title}`;
    const viewed = s.files.filter((f) => f.viewed === 'VIEWED').length;
    const pending = s.pendingReviewId ? ' · review pending' : '';
    if (this.mode === 'full') {
      this.tree.description = `${viewed}/${s.files.length} viewed${pending}`;
      this.tree.message = undefined;
      this.status.text = `$(eye) #${s.number} · ${viewed}/${s.files.length} viewed`;
      this.status.tooltip = 'Reviewing the full PR — click to switch to commit by commit';
    } else {
      const c = this.currentCommit;
      const i = c ? s.commits.indexOf(c) + 1 : 0;
      const done = s.commits.filter((commit) => this.isChecked({ kind: 'commit', commit })).length;
      this.tree.description = `${done}/${s.commits.length} commits viewed${pending}`;
      this.tree.message = c
        ? `Commit ${i}/${s.commits.length} · ${c.sha.slice(0, 7)} by ${c.author}\n${c.message.trim()}`
        : 'Commit by commit: expand a commit, or use ↓ to start with the first one.';
      this.status.text = `$(git-commit) #${s.number} · commit ${i || '–'}/${s.commits.length}`;
      this.status.tooltip = 'Reviewing commit by commit — click to switch to the full PR';
    }
    this.status.show();
  }
}
