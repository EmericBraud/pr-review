// Write-path test: posts comments, reviews and "viewed" marks. Only run it against a sandbox PR you own,
// e.g. EmericBraud/pr-review-sandbox#1 (see README).
import * as vscode from 'vscode';
import * as assert from 'assert';
import { parsePatch } from '../patch';

const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 30000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 300))) if (await ok()) return;
  throw new Error(`Timed out waiting for ${what}`);
};

// GitHub reads lag 1-2 s behind writes: retry assertions that read GitHub state.
const eventually = async (fn: () => Promise<unknown>) => {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 20) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
};

export async function run() {
  const errors: string[] = [];
  let event = 'COMMENT';
  const w = vscode.window as any;
  w.showErrorMessage = async (m: string) => void (errors.push(m), console.log('error:', m));
  w.showInformationMessage = async (m: string) => void console.log('info:', m);
  w.showWarningMessage = async (m: string, ...items: unknown[]) => items.find((i) => i === 'Delete' || i === 'Discard');
  w.showQuickPick = async (items: any) => (await items).find((i: any) => i.event === event);
  w.showInputBox = async () => 'Review summary from the automated test';

  const ext = vscode.extensions.all.find((e) => e.id.endsWith('.pr-review'))!;
  const { review } = await ext.activate();
  const { graphql } = require('../github');
  const PR = Number(process.env.PR);
  const exec = (cmd: string, ...args: unknown[]) => vscode.commands.executeCommand(`prReview.${cmd}`, ...args);
  const ok = (step: string) => {
    assert.deepEqual(errors, [], `errors during: ${step}`);
    console.log('✔', step);
  };

  await exec('review', PR);
  const s = review.s;
  const { owner, name } = s.repo;
  const gh = async () => (await graphql(`query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){pullRequest(number:$num){
    files(first:50){nodes{path viewerViewedState}}
    reviews(last:20){nodes{id state body viewerDidAuthor}}
    reviewThreads(first:100){nodes{id isResolved path line startLine diffSide comments(first:20){nodes{body state}}}}
    comments(last:20){nodes{body}}
  }}}`, { o: owner, n: name, num: PR })).repository.pullRequest;
  const viewed = async (p: string) => (await gh()).files.nodes.find((f: any) => f.path === p).viewerViewedState;
  const threadOf = async (body: string) => (await gh()).reviewThreads.nodes.find((t: any) => t.comments.nodes.some((c: any) => c.body === body));
  const head = (p: string) => review.uri(p, s.pr.headSha);
  const newThread = (uri: vscode.Uri, from: number, to = from) => review.controller.createCommentThread(uri, new vscode.Range(from - 1, 0, to - 1, 0), []);
  const vsThread = (body: string) => [...review.vsThreads.entries()].find(([, t]: any) => t.comments.nodes[0].body === body)?.[0];
  const comment = (body: string) => [...review.vsThreads.keys()].flatMap((t: any) => t.comments).find((c: any) => c.gh.body === body);
  const run = Date.now().toString(36); // keeps bodies unique across runs
  const B = (text: string) => `${text} [${run}]`;

  if (s.pendingReviewId) await exec('discard'); // leftover from an interrupted run

  // Viewed checkboxes ↔ GitHub
  const utils = review.node({ kind: 'file', file: s.files.find((f: any) => f.path === 'src/utils.ts') });
  await review.check(utils, true);
  await eventually(async () => assert.equal(await viewed('src/utils.ts'), 'VIEWED'));
  await review.check(utils, false);
  await eventually(async () => assert.equal(await viewed('src/utils.ts'), 'UNVIEWED'));
  const first = review.current;
  await exec('nextFile');
  await eventually(async () => assert.equal(await viewed(first.file.path), 'VIEWED'));
  assert.notEqual(review.current, first);
  await review.check(first, false);
  ok('viewed state synced with GitHub (check, uncheck, mark & next)');

  // Folder tree: common parents, a folder is checked iff all its files are viewed
  const Checked = vscode.TreeItemCheckboxState.Checked;
  const roots = await review.getChildren();
  assert.deepEqual(roots.map((n: any) => (n.kind === 'dir' ? `${n.name}/` : n.file.path)), ['docs/', 'src/', 'config.json']);
  const srcDir = roots.find((n: any) => n.name === 'src');
  assert.deepEqual(srcDir.children.map((n: any) => n.file.path), ['src/app.ts', 'src/greet.ts', 'src/utils.ts']);
  await review.check(srcDir, true);
  await eventually(async () => assert.ok((await gh()).files.nodes.filter((f: any) => f.path.startsWith('src/')).every((f: any) => f.viewerViewedState === 'VIEWED')));
  assert.equal(review.getTreeItem(srcDir).checkboxState.state, Checked);
  await review.check(srcDir.children[0], false);
  assert.notEqual(review.getTreeItem(srcDir).checkboxState.state, Checked);
  assert.equal(review.getTreeItem(srcDir).description, '2/3');
  await review.check(srcDir, false);
  await eventually(async () => assert.ok((await gh()).files.nodes.every((f: any) => f.viewerViewedState === 'UNVIEWED')));
  ok('folder tree: common parents, folder checked iff all files viewed (2/3 shown), folder check synced to GitHub');

  // Pending review: new thread, multi-line thread, LEFT side, reply, edit, delete, submit
  await exec('startReviewComment', { thread: newThread(head('src/greet.ts'), 2), text: B('Pending single-line') });
  assert.ok(s.pendingReviewId, 'pending review created');
  await exec('addReviewComment', { thread: newThread(head('src/greet.ts'), 3, 5), text: B('Pending multi-line') });
  const left = parsePatch(s.files.find((f: any) => f.path === 'src/utils.ts').patch).oldRanges[0][1];
  await exec('addReviewComment', { thread: newThread(review.uri('src/utils.ts', s.pr.mergeBase), left), text: B('Pending left side') });
  await exec('addReviewComment', { thread: vsThread(B('Pending single-line')), text: B('Pending reply') });
  const edited = comment(B('Pending reply'));
  edited.body = B('Pending reply (edited)');
  await exec('saveComment', edited);
  await exec('deleteComment', comment(B('Pending multi-line')));
  let t: any;
  await eventually(async () => {
    t = await threadOf(B('Pending single-line'));
    assert.deepEqual(t.comments.nodes.map((c: any) => [c.body, c.state]), [[B('Pending single-line'), 'PENDING'], [B('Pending reply (edited)'), 'PENDING']]);
    assert.equal(t.line, 2);
  });
  await eventually(async () => assert.equal((await threadOf(B('Pending left side'))).diffSide, 'LEFT'));
  const leftRange = vsThread(B('Pending left side'))!.range!;
  assert.deepEqual([leftRange.start.line, leftRange.end.line], [left - 1, left - 1], 'LEFT single-line thread rendered on its line');
  assert.equal(vsThread(B('Pending left side'))!.uri.query, s.pr.mergeBase);
  await eventually(async () => assert.equal(await threadOf(B('Pending multi-line')), undefined));
  await eventually(async () => assert.equal((await gh()).reviews.nodes.find((r: any) => r.state === 'PENDING' && r.viewerDidAuthor)?.id, s.pendingReviewId));
  ok('pending review: thread, multi-line, left side, reply, edit, delete');

  // Multi-line anchoring
  await exec('addReviewComment', { thread: newThread(head('src/greet.ts'), 3, 5), text: B('Multi-line kept') });
  await eventually(async () => {
    t = await threadOf(B('Multi-line kept'));
    assert.deepEqual([t.startLine, t.line, t.diffSide], [3, 5, 'RIGHT']);
  });
  const multiRange = vsThread(B('Multi-line kept'))!.range!;
  assert.deepEqual([multiRange.start.line, multiRange.end.line], [2, 4], 'multi-line thread rendered on lines 3-5');
  ok('multi-line thread anchored on lines 3-5');

  event = 'COMMENT';
  await exec('submit');
  assert.equal(s.pendingReviewId, undefined);
  await eventually(async () => {
    const submitted = (await gh()).reviews.nodes.filter((r: any) => r.viewerDidAuthor).pop();
    assert.deepEqual([submitted.state, submitted.body], ['COMMENTED', 'Review summary from the automated test']);
  });
  await eventually(async () => assert.equal((await threadOf(B('Pending single-line'))).comments.nodes[0].state, 'SUBMITTED'));
  ok('review submitted (COMMENT) with summary');

  // Single comments (published immediately), reply, resolve / unresolve
  const appLine = parsePatch(s.files.find((f: any) => f.path === 'src/app.ts').patch).added[0];
  await exec('addSingleComment', { thread: newThread(head('src/app.ts'), appLine), text: B('Single comment') });
  await exec('addSingleComment', { thread: vsThread(B('Single comment')), text: B('Single reply') });
  await eventually(async () => {
    t = await threadOf(B('Single comment'));
    assert.deepEqual(t.comments.nodes.map((c: any) => c.state), ['SUBMITTED', 'SUBMITTED']);
    assert.equal(t.line, appLine);
  });
  assert.equal(s.pendingReviewId, undefined);
  await exec('resolve', vsThread(B('Single comment')));
  await eventually(async () => assert.equal((await threadOf(B('Single comment'))).isResolved, true));
  await exec('unresolve', vsThread(B('Single comment')));
  await eventually(async () => assert.equal((await threadOf(B('Single comment'))).isResolved, false));
  ok('single comment, single reply, resolve, unresolve');

  // Discard a pending review
  await exec('startReviewComment', { thread: newThread(head('src/greet.ts'), 1), text: B('To be discarded') });
  assert.ok(s.pendingReviewId);
  await exec('discard');
  assert.equal(s.pendingReviewId, undefined);
  await eventually(async () => assert.equal(await threadOf(B('To be discarded')), undefined));
  await eventually(async () => assert.ok(!(await gh()).reviews.nodes.some((r: any) => r.state === 'PENDING')));
  ok('pending review discarded');

  // GitHub refuses approving your own PR: the error must reach the user
  event = 'APPROVE';
  await exec('submit');
  assert.ok(errors.some((e) => /approve your own/i.test(e)), JSON.stringify(errors));
  errors.length = 0;
  ok('approving own PR surfaces the GitHub error');

  // Commit by commit: commenting allowed only where the commit's file equals the PR head
  review.toggleMode('commits');
  await review.list();
  const [c1, c2, c3] = s.commits;
  const c2Roots = await review.getChildren(review.node({ kind: 'commit', commit: c2 }));
  assert.deepEqual(c2Roots.map((n: any) => (n.kind === 'dir' ? `${n.name}/` : n.file.path)), ['docs/', 'config.json']);
  await review.check(c2Roots[0], true);
  assert.equal(review.getTreeItem(c2Roots[0]).checkboxState.state, Checked);
  assert.ok(review.isChecked(c2Roots[0].children[0]));
  await review.check(c2Roots[0], false);
  await review.check(review.node({ kind: 'file', file: s.files.find((f: any) => f.path === 'docs/guide.md') }), false);
  const openCfile = async (c: any, p: string) => {
    await review.open(review.node({ kind: 'cfile', commit: c, file: c.files.find((f: any) => f.path === p) }));
    await until(`diff of ${p}`, () => (vscode.window.tabGroups.activeTabGroup.activeTab?.input as any)?.modified?.path === '/' + p);
    return (vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputTextDiff).modified;
  };
  const greetRight = await openCfile(c1, 'src/greet.ts');
  assert.equal(greetRight.query, s.pr.headSha);
  assert.ok(review.commentRanges(greetRight).length > 0);
  const appRight = await openCfile(c1, 'src/app.ts');
  assert.equal(appRight.query, c1.sha);
  assert.deepEqual(review.commentRanges(appRight), []);
  assert.ok(review.tree.message.includes('feat: add greeting helper'), review.tree.message);
  ok('commit mode: folder tree per commit; head-equal file commentable, later-changed file not; commit message shown');

  // Checking the only commit touching a file marks it viewed on GitHub
  await eventually(async () => assert.equal(await viewed('src/utils.ts'), 'UNVIEWED'));
  await review.check(review.node({ kind: 'cfile', commit: c3, file: c3.files.find((f: any) => f.path === 'src/utils.ts') }), true);
  await eventually(async () => assert.equal(await viewed('src/utils.ts'), 'VIEWED'));
  await review.check(utils, false);
  review.toggleMode('full');
  ok('commit-mode checkbox syncs full-file viewed state');

  // PR conversation comment from the overview
  await exec('openPr', PR);
  const { PrDetail } = require('../prs');
  const detail = PrDetail.panels.get(`${owner}/${name}#${PR}`);
  await until('overview render', () => !detail.panel.webview.html.includes('Loading…'));
  const html: string = detail.panel.webview.html;
  assert.ok(html.includes('no-unused-vars') || html.includes('● '), 'CI annotation (or pending CI) visible');
  await detail.onMessage({ cmd: 'comment', body: B('Conversation comment') });
  await eventually(async () => assert.ok((await gh()).comments.nodes.some((c: any) => c.body === B('Conversation comment'))));
  ok('conversation comment posted from the overview');

  // Comment straight from the workspace file once the branch is checked out
  await exec('checkout', PR);
  assert.ok(s.headIsLocal);
  const fileUri = vscode.Uri.joinPath(s.repo.root, 'src/greet.ts');
  await vscode.window.showTextDocument(fileUri);
  await exec('addSingleComment', { thread: newThread(fileUri, 1), text: B('From the workspace file') });
  await eventually(async () => {
    t = await threadOf(B('From the workspace file'));
    assert.deepEqual([t.path, t.line, t.diffSide], ['src/greet.ts', 1, 'RIGHT']);
  });
  assert.ok([...review.vsThreads.keys()].some((th: any) => th.uri.scheme === 'file'), 'threads rendered on the workspace file');
  ok('comment from the workspace file after checkout');

  console.log('WRITES OK');
}
