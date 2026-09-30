// Usage: [SUITE=writes] npm run test:integration -- <path to a clone of a GitHub repo> <PR number> [actions job id]
// SUITE=writes posts comments/reviews: only use it on a sandbox PR you own.
import * as path from 'path';
import * as os from 'os';
import { runTests } from '@vscode/test-electron';

const [workspace, pr, job] = process.argv.slice(2);
const tmp = path.join(os.tmpdir(), 'pr-review-test');
runTests({
  vscodeExecutablePath: process.env.VSCODE_BIN ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  extensionDevelopmentPath: path.resolve(__dirname, '../..'),
  extensionTestsPath: path.resolve(__dirname, `${process.env.SUITE ?? 'integration'}.js`),
  extensionTestsEnv: { PR: pr, JOB: job ?? '', DUMP: process.env.DUMP ?? '' },
  launchArgs: [path.resolve(workspace), '--disable-extensions', '--user-data-dir', path.join(tmp, 'user'), '--extensions-dir', path.join(tmp, 'ext')],
}).catch(() => process.exit(1));
