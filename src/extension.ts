import * as vscode from 'vscode';
import { findRepo } from './github';
import { Review } from './review';
import { PrList, PrDetail, logProvider } from './prs';

export async function activate(ctx: vscode.ExtensionContext) {
  let repoP = findRepo();
  const repo = async () => (await repoP) ?? (await (repoP = findRepo()));
  const need = async () => {
    const r = await repo();
    if (!r) throw new Error('No GitHub repository found in this workspace.');
    return r;
  };

  const prs = new PrList(ctx, repo);
  const review = new Review(ctx, () => prs.refresh());

  const prNumber = async (arg: any): Promise<number | undefined> => {
    if (typeof arg === 'number') return arg;
    if (arg?.pr) return arg.pr.number;
    if (!prs.all.length) await prs.getChildren();
    const pick = await vscode.window.showQuickPick(
      prs.all.map((p) => ({ label: `#${p.number} ${p.title}`, description: p.author?.login, detail: `${p.headRefName} → ${p.baseRefName}`, n: p.number })),
      { placeHolder: 'Pick a pull request', matchOnDescription: true, matchOnDetail: true },
    );
    return pick?.n;
  };

  const cmd = (id: string, fn: (...args: any[]) => unknown) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(`prReview.${id}`, async (...args) => {
      try {
        await fn(...args);
      } catch (e: any) {
        vscode.window.showErrorMessage(e.message);
      }
    }));

  cmd('refreshPrs', () => prs.refresh());
  cmd('openPr', async (a) => {
    const n = await prNumber(a);
    if (n) await PrDetail.show(await need(), n, review);
  });
  cmd('review', async (a) => {
    const n = await prNumber(a);
    if (n) await review.start(await need(), n, { mode: 'full' });
  });
  cmd('reviewCommits', async (a) => {
    const n = await prNumber(a);
    if (n) await review.start(await need(), n, { mode: 'commits' });
  });
  cmd('checkout', async (a) => {
    const n = await prNumber(a ?? review.s?.number);
    if (n) await review.checkout(await need(), n);
  });
  cmd('openOnGitHub', async (a) => {
    const n = await prNumber(a ?? review.s?.number);
    const r = await need();
    if (n) await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${r.owner}/${r.name}/pull/${n}`));
  });
  cmd('showPrDetails', () => review.s && PrDetail.show(review.s.repo, review.s.number, review));
  cmd('toggleMode', () => review.toggleMode());
  cmd('modeFull', () => review.toggleMode('full'));
  cmd('modeCommits', () => review.toggleMode('commits'));
  cmd('nextFile', () => review.next(true));
  cmd('nextCommit', () => review.stepCommit(1));
  cmd('prevCommit', () => review.stepCommit(-1));
  cmd('openDiff', (n) => review.open(n));
  cmd('openFile', (uri) => review.openFile(uri));
  cmd('openFileDiff', (uri) => review.openDiffFor(uri));
  cmd('refreshReview', () => review.refresh());
  cmd('submit', () => review.submit());
  cmd('discard', () => review.discard());
  cmd('exit', () => review.exit());
  cmd('startReviewComment', (r) => review.comment(r, true));
  cmd('addReviewComment', (r) => review.comment(r, true));
  cmd('addSingleComment', (r) => review.comment(r, false));
  cmd('resolve', (t) => review.resolve(t, true));
  cmd('unresolve', (t) => review.resolve(t, false));
  cmd('editComment', (c) => review.editComment(c));
  cmd('saveComment', (c) => review.saveComment(c));
  cmd('cancelEdit', (c) => review.cancelEdit(c));
  cmd('deleteComment', (c) => review.deleteComment(c));

  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('pr-review-log', logProvider),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      repoP = findRepo();
      prs.refresh();
    }),
  );

  // Resume the review that was in progress when the window closed.
  const saved = ctx.workspaceState.get<{ number: number; mode: 'full' | 'commits' }>('prReview.session');
  const r = await repo();
  if (saved && r) review.start(r, saved.number, { mode: saved.mode, open: false });
  return { review, prs }; // used by the integration test
}

export function deactivate() {}
