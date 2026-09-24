// Guardrails that do not depend on the agent reading the skill.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

// SuiteQL over REST cannot write, but a single plain SELECT (or WITH ... SELECT)
// keeps it obvious what a query does. Comments and string literals are stripped
// before checking so keywords inside them do not count.
export function checkSelectOnly(sql) {
  const bare = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim();
  if (!/^(SELECT|WITH)\b/i.test(bare)) {
    throw new Error('only a single SELECT (or WITH ... SELECT) statement is allowed');
  }
  if (bare.includes(';')) throw new Error('one statement per run: remove the ";" separators');
}

// Query results are client data. Refuse to write them inside a git repository
// unless git ignores the path, so they cannot be committed by accident.
export function checkSavePath(path) {
  const abs = resolve(path);
  let root;
  try {
    root = execFileSync('git', ['-C', dirname(abs), 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch {
    return; // not in a repository, or git is not installed
  }
  try {
    execFileSync('git', ['-C', root, 'check-ignore', '-q', abs], { stdio: 'ignore' });
  } catch {
    throw new Error(
      `refusing to save results to ${abs}: it is inside the git repository ${root} and not ignored. ` +
        'Add the path to .gitignore, use --out outside the repository, or pass --allow-tracked.'
    );
  }
}
