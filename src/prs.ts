import * as vscode from 'vscode';
import { Repo, graphql, rest, withProgress, ago } from './github';
import { Review } from './review';

const LIST = `query($q1:String!,$q2:String!,$q3:String!){
  review: search(query:$q1,type:ISSUE,first:50){nodes{...pr}}
  mine: search(query:$q2,type:ISSUE,first:50){nodes{...pr}}
  all: search(query:$q3,type:ISSUE,first:100){nodes{...pr}}
}
fragment pr on PullRequest{number title isDraft updatedAt headRefName baseRefName author{login} reviewDecision additions deletions
  commits(last:1){nodes{commit{statusCheckRollup{state}}}}}`;

const DETAIL = `query($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    number title url state isDraft createdAt bodyHTML additions deletions changedFiles
    author{login avatarUrl} baseRefName headRefName reviewDecision mergeable
    labels(first:20){nodes{name color}}
    reviewRequests(first:20){nodes{requestedReviewer{... on User{login} ... on Team{name}}}}
    latestReviews(first:20){nodes{author{login} state}}
    commits(first:100){totalCount nodes{commit{oid messageHeadline messageBody committedDate author{name user{login}} statusCheckRollup{state}}}}
    last: commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{
      __typename
      ... on CheckRun{name conclusion status detailsUrl databaseId title summary
        annotations(first:30){nodes{path title message annotationLevel location{start{line}}}}
        checkSuite{app{slug} workflowRun{workflow{name}}}}
      ... on StatusContext{context state description targetUrl}
    }}}}}}
    comments(first:100){nodes{author{login avatarUrl} bodyHTML createdAt}}
    reviews(first:100){nodes{author{login avatarUrl} state bodyHTML submittedAt}}
    reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine
      comments(first:50){nodes{bodyHTML createdAt author{login avatarUrl}}}}}
  }}}`;

interface ListPr {
  number: number;
  title: string;
  isDraft: boolean;
  updatedAt: string;
  headRefName: string;
  baseRefName: string;
  author: { login: string } | null;
  reviewDecision: string | null;
  additions: number;
  deletions: number;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

type Item =
  | { kind: 'cat'; key: string; label: string; icon: string; prs: ListPr[] }
  | { kind: 'pr'; cat: string; pr: ListPr }
  | { kind: 'error'; message: string };

const CI_COLOR: Record<string, string> = {
  SUCCESS: 'testing.iconPassed',
  FAILURE: 'testing.iconFailed',
  ERROR: 'testing.iconFailed',
  PENDING: 'testing.iconQueued',
  EXPECTED: 'testing.iconQueued',
};
const DECISION: Record<string, string> = { APPROVED: '✓ approved', CHANGES_REQUESTED: '✗ changes requested', REVIEW_REQUIRED: 'review required' };

export class PrList implements vscode.TreeDataProvider<Item> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private tree: vscode.TreeView<Item>;
  private lastLoad = 0;
  all: ListPr[] = [];

  constructor(ctx: vscode.ExtensionContext, private repo: () => Promise<Repo | undefined>) {
    this.tree = vscode.window.createTreeView('prReview.prs', { treeDataProvider: this, showCollapseAll: true });
    ctx.subscriptions.push(
      this.tree,
      vscode.window.onDidChangeWindowState((w) => {
        if (w.focused && Date.now() - this.lastLoad > 120_000) this.refresh();
      }),
    );
  }

  refresh() {
    this.changed.fire();
  }

  async getChildren(i?: Item): Promise<Item[]> {
    if (i?.kind === 'cat') return i.prs.map((pr) => ({ kind: 'pr', cat: i.key, pr }));
    if (i) return [];
    const repo = await this.repo();
    vscode.commands.executeCommand('setContext', 'prReview.noRepo', !repo);
    if (!repo) return [];
    this.lastLoad = Date.now();
    try {
      const q = `repo:${repo.owner}/${repo.name} is:pr is:open sort:updated-desc`;
      const d = await graphql(LIST, { q1: `${q} review-requested:@me`, q2: `${q} author:@me`, q3: q });
      this.all = d.all.nodes;
      const waiting = d.review.nodes.length;
      this.tree.badge = waiting ? { value: waiting, tooltip: `${waiting} PR${waiting > 1 ? 's' : ''} waiting for your review` } : undefined;
      this.tree.description = `${repo.owner}/${repo.name}`;
      return [
        { kind: 'cat', key: 'review', label: 'Waiting for my review', icon: 'eye', prs: d.review.nodes },
        { kind: 'cat', key: 'mine', label: 'Created by me', icon: 'account', prs: d.mine.nodes },
        { kind: 'cat', key: 'all', label: 'All open', icon: 'git-pull-request', prs: d.all.nodes },
      ];
    } catch (e: any) {
      return [{ kind: 'error', message: e.message }];
    }
  }

  getTreeItem(i: Item): vscode.TreeItem {
    if (i.kind === 'error') {
      const t = new vscode.TreeItem(i.message);
      t.iconPath = new vscode.ThemeIcon('error');
      t.tooltip = i.message;
      return t;
    }
    if (i.kind === 'cat') {
      const t = new vscode.TreeItem(i.label, i.key === 'all' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
      t.id = i.key;
      t.description = String(i.prs.length);
      t.iconPath = new vscode.ThemeIcon(i.icon);
      return t;
    }
    const pr = i.pr;
    const ci = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
    const t = new vscode.TreeItem(`#${pr.number} ${pr.title}`);
    t.id = `${i.cat}:${pr.number}`;
    t.description = [pr.author?.login, ago(pr.updatedAt), pr.reviewDecision && DECISION[pr.reviewDecision]].filter(Boolean).join(' · ');
    t.iconPath = new vscode.ThemeIcon(pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request', ci ? new vscode.ThemeColor(CI_COLOR[ci]) : undefined);
    t.tooltip = new vscode.MarkdownString(
      `**#${pr.number} ${pr.title}**${pr.isDraft ? ' _(draft)_' : ''}\n\n` +
        `\`${pr.headRefName}\` → \`${pr.baseRefName}\` by **${pr.author?.login ?? 'ghost'}**\n\n` +
        `CI: ${ci?.toLowerCase() ?? 'none'} · Review: ${pr.reviewDecision ? DECISION[pr.reviewDecision] : 'none'} · +${pr.additions} −${pr.deletions}`,
    );
    t.contextValue = 'pr';
    t.command = { command: 'prReview.openPr', title: 'Open', arguments: [pr.number] };
    return t;
  }
}

// ---------- PR overview webview ----------

const esc = (s: string | null | undefined = '') => (s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function md(text: string | null | undefined) {
  if (!text?.trim()) return '';
  try {
    return await vscode.commands.executeCommand<string>('markdown.api.render', text);
  } catch {
    return `<pre>${esc(text)}</pre>`;
  }
}

type CheckState = 'fail' | 'pending' | 'pass' | 'skip';
interface Check {
  name: string;
  state: CheckState;
  label: string;
  url?: string;
  jobId?: number;
  title?: string;
  summary?: string;
  annotations: { path: string; title: string | null; message: string; annotationLevel: string; location: { start: { line: number } } }[];
}

function toCheck(c: any): Check {
  if (c.__typename === 'StatusContext') {
    const state = ({ SUCCESS: 'pass', PENDING: 'pending', EXPECTED: 'pending' } as Record<string, CheckState>)[c.state] ?? 'fail';
    return { name: c.context, state, label: c.description || c.state.toLowerCase(), url: c.targetUrl, annotations: [] };
  }
  const concl: string | null = c.conclusion;
  const state: CheckState =
    c.status !== 'COMPLETED' ? 'pending'
    : ['SUCCESS', 'NEUTRAL'].includes(concl!) ? 'pass'
    : ['SKIPPED', 'CANCELLED', 'STALE'].includes(concl!) ? 'skip'
    : 'fail';
  const workflow = c.checkSuite?.workflowRun?.workflow?.name;
  return {
    name: workflow ? `${workflow} / ${c.name}` : c.name,
    state,
    label: (concl ?? c.status).toLowerCase().replace(/_/g, ' '),
    url: c.detailsUrl,
    jobId: c.checkSuite?.app?.slug === 'github-actions' ? c.databaseId : undefined,
    title: c.title,
    summary: c.summary,
    annotations: c.annotations?.nodes ?? [],
  };
}

const ICON: Record<CheckState, string> = { fail: '✗', pending: '●', pass: '✓', skip: '⊘' };
const REVIEW_STATE: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'reviewed', DISMISSED: 'review dismissed' };

const logs = new Map<string, string>();
export const logProvider: vscode.TextDocumentContentProvider = { provideTextDocumentContent: (uri) => logs.get(uri.query) ?? '' };

async function showLog(repo: Repo, jobId: string, name: string) {
  const text = await withProgress(`Fetching logs of ${name}…`, () => rest<string>(`/repos/${repo.owner}/${repo.name}/actions/jobs/${jobId}/logs`));
  if (text === undefined) return;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''));
  logs.set(jobId, lines.join('\n'));
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'pr-review-log', path: `/${name.replace(/[\\/]/g, '-')}.log`, query: jobId }));
  const ed = await vscode.window.showTextDocument(doc, { preview: false });
  const i = lines.findIndex((l) => l.startsWith('##[error]'));
  if (i >= 0) {
    ed.selection = new vscode.Selection(i, 0, i, 0);
    ed.revealRange(new vscode.Range(i, 0, i, 0), vscode.TextEditorRevealType.InCenter);
  }
}

export class PrDetail {
  private static panels = new Map<string, PrDetail>();

  static show(repo: Repo, number: number, review: Review) {
    const key = `${repo.owner}/${repo.name}#${number}`;
    const existing = PrDetail.panels.get(key);
    if (existing) {
      existing.panel.reveal();
      return existing.render();
    }
    PrDetail.panels.set(key, new PrDetail(repo, number, review, () => PrDetail.panels.delete(key)));
  }

  private panel: vscode.WebviewPanel;

  private constructor(private repo: Repo, private number: number, private review: Review, onDispose: () => void) {
    this.panel = vscode.window.createWebviewPanel('prReview.detail', `#${number}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.onDidDispose(onDispose);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => vscode.window.showErrorMessage(e.message)));
    this.panel.webview.html = this.page('<p class="muted">Loading…</p>');
    this.render();
  }

  async render() {
    try {
      const pr = (await graphql(DETAIL, { owner: this.repo.owner, name: this.repo.name, number: this.number })).repository.pullRequest;
      this.panel.title = `#${pr.number} ${pr.title}`;
      this.panel.webview.html = this.page(await this.body(pr));
    } catch (e: any) {
      this.panel.webview.html = this.page(`<p class="error">Could not load PR #${this.number}: ${esc(e.message)}</p><button data-cmd="refresh">Retry</button>`);
    }
  }

  private async onMessage(m: Record<string, string>) {
    const { repo, number, review } = this;
    switch (m.cmd) {
      case 'review':
        return review.start(repo, number, { mode: 'full' });
      case 'commits':
        return review.start(repo, number, { mode: 'commits', commit: m.sha });
      case 'checkout':
        return review.checkout(repo, number);
      case 'external':
        return vscode.env.openExternal(vscode.Uri.parse(m.url));
      case 'refresh':
        return this.render();
      case 'log':
        return showLog(repo, m.id, m.name);
      case 'annotation': {
        const line = Math.max(0, +m.line - 1);
        return vscode.window.showTextDocument(vscode.Uri.joinPath(repo.root, m.path), { selection: new vscode.Range(line, 0, line, 0) });
      }
      case 'thread':
        return review.openThread(repo, number, m.path, m.line ? +m.line : undefined);
      case 'comment':
        if (!m.body?.trim()) return;
        return withProgress('Posting comment…', async () => {
          await rest(`/repos/${repo.owner}/${repo.name}/issues/${number}/comments`, { method: 'POST', body: { body: m.body } });
          await this.render();
        });
    }
  }

  private async body(pr: any): Promise<string> {
    const state = pr.isDraft ? 'draft' : pr.state.toLowerCase();
    const rollup = pr.last.nodes[0]?.commit.statusCheckRollup;
    const order: CheckState[] = ['fail', 'pending', 'pass', 'skip'];
    const checks: Check[] = (rollup?.contexts.nodes ?? []).map(toCheck).sort((a: Check, b: Check) => order.indexOf(a.state) - order.indexOf(b.state));
    const count = (s: CheckState) => checks.filter((c) => c.state === s).length;
    const who = (a: { login: string; avatarUrl?: string } | null) =>
      `<span class="who">${a?.avatarUrl ? `<img class="avatar" src="${esc(a.avatarUrl)}">` : ''}<b>${esc(a?.login ?? 'ghost')}</b></span>`;

    const reviewers = [
      ...pr.latestReviews.nodes.map((r: any) => `<span class="pill ${r.state.toLowerCase()}">${esc(r.author?.login)} · ${REVIEW_STATE[r.state] ?? r.state.toLowerCase()}</span>`),
      ...pr.reviewRequests.nodes.map((r: any) => `<span class="pill">${esc(r.requestedReviewer?.login ?? r.requestedReviewer?.name)} · pending</span>`),
    ].join(' ');

    const checkHtml = await Promise.all(checks.map(async (c) => {
      const details = [
        c.title && `<p><b>${esc(c.title)}</b></p>`,
        c.state === 'fail' || c.state === 'pending' ? await md(c.summary) : '',
        c.annotations.length
          ? `<ul class="annotations">${c.annotations.map((a) => `<li class="${esc(a.annotationLevel.toLowerCase())}">${
              // GitHub attaches runner-level annotations to ".github", which is not a file.
              a.path === '.github' ? '' : `<a href="#" data-cmd="annotation" data-path="${esc(a.path)}" data-line="${a.location.start.line}">${esc(a.path)}:${a.location.start.line}</a> `
            }${a.title ? `<b>${esc(a.title)}</b> ` : ''}${esc(a.message)}</li>`).join('')}</ul>`
          : '',
      ].filter(Boolean).join('');
      const buttons = [
        c.jobId && `<button class="small ${c.state === 'fail' ? '' : 'secondary'}" data-cmd="log" data-id="${c.jobId}" data-name="${esc(c.name)}">View log</button>`,
        c.url && `<button class="small secondary" data-cmd="external" data-url="${esc(c.url)}">Details ↗</button>`,
      ].filter(Boolean).join(' ');
      return `<details class="check ${c.state}" ${c.state === 'fail' ? 'open' : ''}>
        <summary><span class="icon">${ICON[c.state]}</span><span class="name">${esc(c.name)} <span class="muted">— ${esc(c.label)}</span></span><span class="right">${buttons}</span></summary>
        ${details || '<p class="muted">No details.</p>'}
      </details>`;
    }));

    const commits = pr.commits.nodes.map(({ commit: c }: any) => {
      const ci = c.statusCheckRollup?.state;
      return `<li>
        <span class="icon ci-${esc(ci?.toLowerCase())}">${ci ? ICON[({ SUCCESS: 'pass', PENDING: 'pending', EXPECTED: 'pending' } as Record<string, CheckState>)[ci] ?? 'fail'] : '·'}</span>
        <a href="#" data-cmd="commits" data-sha="${c.oid}">${esc(c.messageHeadline)}</a>
        <code>${c.oid.slice(0, 7)}</code> <span class="muted">${esc(c.author?.user?.login ?? c.author?.name)} · ${ago(c.committedDate)}</span>
        ${c.messageBody ? `<pre class="commit-body">${esc(c.messageBody)}</pre>` : ''}
      </li>`;
    }).join('');

    const threads = pr.reviewThreads.nodes;
    const unresolved = threads.filter((t: any) => !t.isResolved).length;
    const threadHtml = threads.map((t: any) => `
      <div class="thread ${t.isResolved ? 'resolved' : ''}">
        <div class="thread-head">
          <a href="#" data-cmd="thread" data-path="${esc(t.path)}" data-line="${t.line ?? ''}">${esc(t.path)}:${t.line ?? t.originalLine}</a>
          ${t.isResolved ? '<span class="pill">resolved</span>' : ''} ${t.isOutdated ? '<span class="pill">outdated</span>' : ''}
        </div>
        ${t.comments.nodes.map((c: any) => `<div class="comment">${who(c.author)} <span class="muted">${ago(c.createdAt)}</span><div class="markdown-body">${c.bodyHTML}</div></div>`).join('')}
      </div>`).join('');

    const timeline = [
      ...pr.comments.nodes.map((c: any) => ({ date: c.createdAt, html: `${who(c.author)} <span class="muted">commented ${ago(c.createdAt)}</span><div class="markdown-body">${c.bodyHTML}</div>` })),
      ...pr.reviews.nodes
        .filter((r: any) => r.state !== 'PENDING' && (r.bodyHTML || r.state !== 'COMMENTED'))
        .map((r: any) => ({ date: r.submittedAt, html: `${who(r.author)} <span class="pill ${r.state.toLowerCase()}">${REVIEW_STATE[r.state] ?? r.state.toLowerCase()}</span> <span class="muted">${ago(r.submittedAt)}</span>${r.bodyHTML ? `<div class="markdown-body">${r.bodyHTML}</div>` : ''}` })),
    ].sort((a, b) => a.date.localeCompare(b.date)).map((e) => `<div class="event">${e.html}</div>`).join('');

    const ciSummary = [count('fail') && `<span class="fail">${count('fail')} failing</span>`, count('pending') && `<span class="pending">${count('pending')} pending</span>`, count('pass') && `<span class="pass">${count('pass')} passing</span>`, count('skip') && `${count('skip')} skipped`].filter(Boolean).join(' · ');

    return `
      <header>
        <h1>${esc(pr.title)} <span class="muted">#${pr.number}</span></h1>
        <div class="meta">
          <span class="badge ${state}">${state}</span>
          ${who(pr.author)} wants to merge <code>${esc(pr.headRefName)}</code> into <code>${esc(pr.baseRefName)}</code>
          · ${ago(pr.createdAt)} · <span class="pass">+${pr.additions}</span> <span class="fail">−${pr.deletions}</span>
          · ${pr.changedFiles} files · ${pr.commits.totalCount} commits
          ${pr.mergeable === 'CONFLICTING' ? ' · <span class="fail">⚠ merge conflicts</span>' : ''}
        </div>
        ${pr.labels.nodes.length ? `<div class="labels">${pr.labels.nodes.map((l: any) => `<span class="label" style="border-color:#${esc(l.color)}">${esc(l.name)}</span>`).join('')}</div>` : ''}
        ${reviewers ? `<div class="reviewers">Reviewers: ${reviewers}</div>` : ''}
        <div class="actions">
          <button data-cmd="review">Review changes</button>
          <button class="secondary" data-cmd="commits">Review commit by commit</button>
          <button class="secondary" data-cmd="checkout">Checkout branch</button>
          <button class="secondary" data-cmd="external" data-url="${esc(pr.url)}">Open on GitHub ↗</button>
          <button class="secondary" data-cmd="refresh" title="Refresh">↻</button>
        </div>
      </header>
      <section>
        <h2>Checks ${ciSummary ? `<span class="h-meta">${ciSummary}</span>` : ''}</h2>
        ${checks.length ? '' : '<p class="muted">No checks reported for the latest commit.</p>'}
        ${checkHtml.filter((_, i) => checks[i].state === 'fail' || checks[i].state === 'pending').join('')}
        ${count('pass') + count('skip') ? `<details class="ok-checks" ${count('fail') + count('pending') ? '' : 'open'}><summary class="muted">${count('pass') + count('skip')} successful or skipped checks</summary>${checkHtml.filter((_, i) => checks[i].state === 'pass' || checks[i].state === 'skip').join('')}</details>` : ''}
      </section>
      <section>
        <h2>Description</h2>
        <div class="markdown-body">${pr.bodyHTML || '<p class="muted">No description provided.</p>'}</div>
      </section>
      <section>
        <h2>Commits <span class="h-meta">${pr.commits.totalCount} — click one to review it</span></h2>
        <ol class="commits">${commits}</ol>
      </section>
      <section>
        <h2>Code comments <span class="h-meta">${threads.length ? `${unresolved} unresolved / ${threads.length}` : ''}</span></h2>
        ${threadHtml || '<p class="muted">No code comments yet.</p>'}
      </section>
      <section>
        <h2>Conversation</h2>
        ${timeline || '<p class="muted">No comments yet.</p>'}
        <textarea id="new-comment" rows="4" placeholder="Leave a comment on the PR (Markdown)"></textarea>
        <div class="actions"><button data-cmd="comment">Comment</button></div>
      </section>`;
  }

  private page(content: string) {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 8px 24px 48px; max-width: 1000px; margin: 0 auto; line-height: 1.5; }
  h1 { font-size: 1.6em; font-weight: 600; margin: 12px 0 6px; }
  h2 { font-size: 1.15em; font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; margin-top: 28px; }
  .h-meta { font-weight: normal; font-size: .85em; color: var(--vscode-descriptionForeground); margin-left: 8px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .error { color: var(--vscode-errorForeground); }
  .pass, .ci-success { color: var(--vscode-testing-iconPassed); }
  .fail, .ci-failure, .ci-error { color: var(--vscode-testing-iconFailed); }
  .pending, .ci-pending, .ci-expected { color: var(--vscode-testing-iconQueued); }
  code { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 1px 5px; border-radius: 4px; font-size: .92em; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; } a:hover { text-decoration: underline; }
  button { font: inherit; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 5px 12px; border-radius: 2px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.small { padding: 1px 8px; font-size: .9em; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  .meta, .reviewers, .labels { margin: 6px 0; }
  .badge { text-transform: capitalize; padding: 2px 10px; border-radius: 12px; color: #fff; font-weight: 600; font-size: .9em; }
  .badge.open { background: #1f883d; } .badge.draft { background: #6e7781; } .badge.merged { background: #8250df; } .badge.closed { background: #cf222e; }
  .pill { display: inline-block; padding: 0 8px; border-radius: 10px; border: 1px solid var(--vscode-panel-border); font-size: .88em; margin: 2px 0; }
  .pill.approved { border-color: var(--vscode-testing-iconPassed); color: var(--vscode-testing-iconPassed); }
  .pill.changes_requested { border-color: var(--vscode-testing-iconFailed); color: var(--vscode-testing-iconFailed); }
  .label { display: inline-block; padding: 0 8px; border-radius: 10px; border: 1px solid; margin-right: 4px; font-size: .88em; }
  .who { white-space: nowrap; }
  .avatar { width: 18px; height: 18px; border-radius: 50%; vertical-align: text-bottom; margin-right: 4px; }
  .check { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin: 4px 0; padding: 4px 10px; }
  .check summary { cursor: pointer; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
  .check summary .name { flex: 1 1 14em; min-width: 0; }
  .check summary .right { display: flex; gap: 6px; white-space: nowrap; }
  .ok-checks > summary { cursor: pointer; margin: 6px 0; }
  .check .icon { font-weight: bold; width: 1em; text-align: center; }
  .check.fail { border-left: 3px solid var(--vscode-testing-iconFailed); } .check.fail .icon { color: var(--vscode-testing-iconFailed); }
  .check.pass .icon { color: var(--vscode-testing-iconPassed); }
  .check.pending { border-left: 3px solid var(--vscode-testing-iconQueued); } .check.pending .icon { color: var(--vscode-testing-iconQueued); }
  .check.skip .icon { color: var(--vscode-descriptionForeground); }
  .annotations { padding-left: 18px; font-family: var(--vscode-editor-font-family); font-size: .92em; }
  .annotations li.failure { color: var(--vscode-errorForeground); } .annotations li.warning { color: var(--vscode-editorWarning-foreground); }
  .commits { padding-left: 0; list-style: none; } .commits li { padding: 4px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .commit-body { margin: 4px 0 0 22px; white-space: pre-wrap; font-size: .9em; color: var(--vscode-descriptionForeground); font-family: inherit; }
  .thread, .event { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 12px; margin: 8px 0; }
  .thread.resolved { opacity: .65; }
  .thread-head { font-family: var(--vscode-editor-font-family); margin-bottom: 4px; }
  .comment { border-top: 1px solid var(--vscode-panel-border); padding-top: 6px; margin-top: 6px; }
  .markdown-body img { max-width: 100%; }
  .markdown-body pre { background: var(--vscode-textCodeBlock-background); padding: 8px; overflow-x: auto; }
  .markdown-body table { border-collapse: collapse; } .markdown-body td, .markdown-body th { border: 1px solid var(--vscode-panel-border); padding: 2px 8px; }
  textarea { width: 100%; box-sizing: border-box; margin-top: 12px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 6px; }
</style></head><body>${content}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-cmd]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const msg = { ...el.dataset };
    if (msg.cmd === 'comment') msg.body = document.getElementById('new-comment').value;
    vscode.postMessage(msg);
  });
</script></body></html>`;
  }
}
