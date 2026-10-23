import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const reportPath = resolve('coverage/coverage-final.json');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const adapterEntry = Object.entries(report).find(([path]) =>
  path.endsWith('/src/storage/sqlite.adapter.ts'),
);

if (adapterEntry === undefined) {
  throw new Error('SQLite adapter coverage is missing; run Vitest with coverage first.');
}

const [, adapter] = adapterEntry;
const targets = ['claimDueEvents', 'compareClaimedEvents'];
const results = targets.map((name) => {
  const functionEntry = Object.entries(adapter.fnMap).find(([, fn]) => fn.name === name);
  if (functionEntry === undefined) {
    throw new Error(`Coverage data is missing for ${name}.`);
  }

  const [functionId, fn] = functionEntry;
  const { start, end } = fn.loc;
  const statements = Object.entries(adapter.statementMap).filter(
    ([, statement]) => statement.start.line >= start.line && statement.start.line <= end.line,
  );
  const lines = new Map();
  for (const [id, statement] of statements) {
    const line = statement.start.line;
    lines.set(line, (lines.get(line) ?? 0) + adapter.s[id]);
  }
  const branches = Object.entries(adapter.branchMap).filter(
    ([, branch]) => branch.line >= start.line && branch.line <= end.line,
  );
  const branchTotal = branches.reduce((total, [id]) => total + adapter.b[id].length, 0);
  const branchCovered = branches.reduce(
    (total, [id]) => total + adapter.b[id].filter((count) => count > 0).length,
    0,
  );

  return {
    name,
    functions: adapter.f[functionId] > 0 ? 100 : 0,
    lines: percentage([...lines.values()].filter((count) => count > 0).length, lines.size),
    statements: percentage(
      statements.filter(([id]) => adapter.s[id] > 0).length,
      statements.length,
    ),
    branches: percentage(branchCovered, branchTotal),
  };
});

process.stdout.write(`${JSON.stringify({ threshold: 95, results }, null, 2)}\n`);

const metrics = ['functions', 'lines', 'statements', 'branches'];
if (results.some((result) => metrics.some((metric) => result[metric] < 95))) {
  process.exitCode = 1;
}

function percentage(covered, total) {
  return total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2));
}
