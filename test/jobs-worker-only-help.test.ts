import { expect, spyOn, test } from 'bun:test';
import { runJobs } from '../src/commands/jobs.ts';

async function captureHelp(args: string[]): Promise<string> {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  try {
    await runJobs(null, args);
    return log.mock.calls.map(call => String(call[0] ?? '')).join('\n');
  } finally {
    log.mockRestore();
  }
}

test('jobs work help documents the allow-list flag and environment fallback', async () => {
  const help = await captureHelp(['work', '--help']);
  expect(help).toContain('--only NAMES');
  expect(help).toContain('GBRAIN_WORKER_ONLY_NAMES');
  expect(help).toContain('takes precedence over the environment');
});

test('jobs overview help lists the allow-list option', async () => {
  const help = await captureHelp(['--help']);
  expect(help).toContain('--only NAMES');
  expect(help).toContain('GBRAIN_WORKER_ONLY_NAMES');
});

test('R8 places the allow-list explanatory paragraph under jobs work help', async () => {
  const help = await captureHelp(['--help']);
  // The explanatory paragraph starts at the indented option row, not at the
  // `--only NAMES` synopsis above it: locate that paragraph by its body.
  const paragraph = [
    '--only NAMES   Claim only these job names',
    'Env fallback: GBRAIN_WORKER_ONLY_NAMES. An explicit',
    '--only flag takes precedence over the environment.',
  ];
  const paragraphAt = help.indexOf(paragraph[0]);
  expect(paragraphAt).toBeGreaterThanOrEqual(0);
  for (const line of paragraph) {
    expect(help.indexOf(line)).toBeGreaterThanOrEqual(0);
  }
  const workSynopsisAt = help.indexOf('gbrain jobs work [--queue Q]');
  const supervisorSynopsisAt = help.indexOf('gbrain jobs supervisor [start]');
  expect(workSynopsisAt).toBeGreaterThanOrEqual(0);
  expect(supervisorSynopsisAt).toBeGreaterThan(workSynopsisAt);
  // The paragraph sits in the jobs work block, after its synopsis and before
  // the supervisor block — not merely the earlier synopsis line that happens
  // to mention the flag.
  expect(paragraphAt).toBeGreaterThan(workSynopsisAt);
  expect(paragraphAt).toBeLessThan(supervisorSynopsisAt);
  expect(help.indexOf('--only=NAMES')).toBeGreaterThan(paragraphAt);
  expect(help.indexOf('unknown job names are rejected')).toBeGreaterThan(paragraphAt);
  expect(help.indexOf('unknown job names are rejected')).toBeLessThan(supervisorSynopsisAt);
});

test('R9 supervisor help does not advertise a worker-only flag', async () => {
  const help = await captureHelp(['supervisor', '--help']);
  expect(help).not.toContain('--only');
  expect(help).not.toContain('GBRAIN_WORKER_ONLY_NAMES');
});
