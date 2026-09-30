// Runs inside a real VS Code (see runIntegration.ts). Read-only against GitHub: no comments, no "viewed" mutations.
import * as vscode from 'vscode';
import * as assert from 'assert';

const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await ok()) return;
  throw new Error(`Timed out waiting for ${what}`);
};

export async function run() {
  const errors: string[] = [];
  const w = vscode.window as any;
  w.showErrorMessage = async (m: string) => void errors.push(m);
  w.showWarningMessage = async (m: string) => void console.log('warn:', m);
  w.showInformationMessage = async (m: string) => void console.log('info:', m);

  const ext = vscode.extensions.all.find((e) => e.id.endsWith('.pr-review'))!;
  const { review, prs } = await ext.activate();
  const PR = Number(process.env.PR);
  const diff = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input as vscode.TabInputTextDiff | undefined;

  // PR list
  const cats = await prs.getChildren();
  assert.deepEqual(cats.map((c: any) => c.kind), ['cat', 'cat', 'cat'], JSON.stringify(cats));
  assert.ok(cats[2].prs.length > 0, 'all open PRs');
  cats[2].prs.forEach((pr: any) => prs.getTreeItem({ kind: 'pr', cat: 'all', pr }));

  // Full review: opens the first file diff, content served through the API fallback (shallow clone).
  await vscode.commands.executeCommand('prReview.review', PR);
  assert.ok(review.s.files.length > 0 && review.s.pr.mergeBase, 'session loaded');
  await until('diff tab', () => diff()?.modified?.scheme === 'pr-review');
  const right = await vscode.workspace.openTextDocument(diff()!.modified);
  const left = await vscode.workspace.openTextDocument(diff()!.original);
  console.log(`full: ${diff()!.modified.path} left=${left.getText().length}b right=${right.getText().length}b`);
  assert.ok(right.getText().length + left.getText().length > 0, 'diff has content');
  // A removed file is only commentable on the left (base) side, an added one only on the right.
  const ranges = [...review.commentRanges(diff()!.original), ...review.commentRanges(diff()!.modified)];
  console.log('comment ranges', ranges.map((r: vscode.Range) => `${r.start.line + 1}-${r.end.line + 1}`).join(','));
  assert.ok(ranges.length > 0, 'commenting ranges on the diff');
  (await review.getChildren()).forEach((n: any) => review.getTreeItem(n));

  // Commit by commit
  await vscode.commands.executeCommand('prReview.nextCommit');
  await until('commit diff tab', () => vscode.window.tabGroups.activeTabGroup.activeTab?.label.includes('@') ?? false);
  console.log('commit tab:', vscode.window.tabGroups.activeTabGroup.activeTab?.label);
  const commits = await review.getChildren();
  assert.equal(commits.length, review.s.commits.length);
  commits.forEach((n: any) => review.getTreeItem(n));
  (await review.getChildren(commits[0])).forEach((n: any) => review.getTreeItem(n));
  await vscode.commands.executeCommand('prReview.nextCommit');
  console.log('commit tab:', vscode.window.tabGroups.activeTabGroup.activeTab?.label);
  await vscode.commands.executeCommand('prReview.modeFull');

  // Overview webview
  await vscode.commands.executeCommand('prReview.openPr', PR);
  const { PrDetail } = require('../prs');
  const panel = [...PrDetail.panels.values()][0].panel as vscode.WebviewPanel;
  await until('overview render', () => !panel.webview.html.includes('Loading…'));
  const html = panel.webview.html;
  assert.ok(!html.includes('Could not load'), html.slice(0, 2000));
  for (const s of ['Checks', 'Description', 'Commits', 'Code comments', 'Conversation']) assert.ok(html.includes(`<h2>${s}`), s);
  console.log('overview:', html.length, 'chars;', (html.match(/class="check /g) ?? []).length, 'checks');
  if (process.env.DUMP) require('fs').writeFileSync(process.env.DUMP, html);

  // Checkout, then the workspace file becomes commentable and links back to its diff.
  await vscode.commands.executeCommand('prReview.checkout', PR);
  assert.ok(review.s.headIsLocal, 'PR head checked out');
  const f = review.s.files.find((f: any) => f.status !== 'removed');
  const fileUri = vscode.Uri.joinPath(review.s.repo.root, f.path);
  assert.ok(review.commentRanges(fileUri).length > 0, 'comment ranges on workspace file');
  await vscode.window.showTextDocument(fileUri);
  await vscode.commands.executeCommand('prReview.openFileDiff', fileUri);
  await until('diff opened from workspace file', () => diff()?.modified.path === '/' + f.path);

  // CI log download (follows the redirect to blob storage)
  const job = process.env.JOB;
  if (job) {
    const text: string = await require('../github').rest(`/repos/${review.s.repo.owner}/${review.s.repo.name}/actions/jobs/${job}/logs`);
    assert.ok(text.includes('##[group]') || text.includes('Current runner version'), text.slice(0, 200));
  }

  assert.deepEqual(errors, []);
  console.log('INTEGRATION OK');
}
