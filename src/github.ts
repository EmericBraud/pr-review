import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

export const run = async (cmd: string, args: string[], cwd?: string) =>
  (await execFileP(cmd, args, { cwd, maxBuffer: 100 * 1024 * 1024 })).stdout;

// The extension host may not inherit the shell PATH when VS Code is launched from the Dock.
export async function gh(args: string[], cwd?: string) {
  for (const bin of ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    try {
      return await run(bin, args, cwd);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw new Error(e.stderr?.trim() || e.message);
    }
  }
  throw new Error('GitHub CLI (gh) not found');
}

let token: Promise<string> | undefined;
const getToken = () =>
  (token ??= gh(['auth', 'token'])
    .then((t) => t.trim())
    .catch(async () => (await vscode.authentication.getSession('github', ['repo'], { createIfNone: true })).accessToken));

export async function rest<T = any>(path: string, opts: { method?: string; body?: unknown; accept?: string } = {}): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : `https://api.github.com${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${await getToken()}`,
      Accept: opts.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pr-review-vscode',
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401) token = undefined;
  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = [j.message, ...(j.errors ?? []).map((e: any) => e.message ?? e)].filter(Boolean).join(' — ');
    } catch {}
    throw new Error(`GitHub ${res.status}: ${msg}`);
  }
  if (res.status === 204) return undefined as T;
  return (res.headers.get('content-type')?.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export async function restAll<T = any>(path: string, max = 30): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= max; page++) {
    const batch = await rest<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export async function graphql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await rest('/graphql', { method: 'POST', body: { query, variables } });
  if (r.errors?.length) throw new Error(r.errors.map((e: any) => e.message).join('; '));
  return r.data;
}

export interface Repo {
  owner: string;
  name: string;
  root: vscode.Uri;
}

export async function findRepo(): Promise<Repo | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    try {
      const root = (await run('git', ['rev-parse', '--show-toplevel'], folder.uri.fsPath)).trim();
      const remotes = (await run('git', ['remote'], root)).split('\n').filter(Boolean);
      // A fork usually has the PRs on `upstream`.
      for (const remote of ['upstream', 'origin', ...remotes]) {
        if (!remotes.includes(remote)) continue;
        const url = (await run('git', ['remote', 'get-url', remote], root)).trim();
        const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
        if (m) return { owner: m[1], name: m[2], root: vscode.Uri.file(root) };
      }
    } catch {}
  }
}

export const localHead = async (repo: Repo) => (await run('git', ['rev-parse', 'HEAD'], repo.root.fsPath).catch(() => '')).trim();

export async function withProgress<T>(title: string, task: () => Promise<T>): Promise<T | undefined> {
  try {
    return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
  } catch (e: any) {
    vscode.window.showErrorMessage(`${title.replace(/…$/, '')} failed: ${e.message}`);
  }
}

export function ago(date: string) {
  const s = (Date.now() - new Date(date).getTime()) / 1000;
  for (const [unit, secs] of [['y', 31536000], ['mo', 2592000], ['d', 86400], ['h', 3600], ['m', 60]] as const) {
    if (s >= secs) return `${Math.floor(s / secs)}${unit} ago`;
  }
  return 'just now';
}
