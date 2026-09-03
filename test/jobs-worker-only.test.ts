import { describe, expect, test } from 'bun:test';
import { parseWorkerOnlyNames } from '../src/commands/jobs.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';

describe('bounded worker job allow-list', () => {
  test('defaults to unrestricted when no flag or env is present', () => {
    expect(parseWorkerOnlyNames([], {})).toBeUndefined();
  });

  test('parses, trims, and de-duplicates comma-separated names', () => {
    expect(parseWorkerOnlyNames(['--only', ' facts-absorb, chronicle_extract, facts-absorb '], {}))
      .toEqual(['facts-absorb', 'chronicle_extract']);
  });

  test('the explicit flag wins over the environment', () => {
    expect(parseWorkerOnlyNames(['--only', 'facts-absorb'], {
      GBRAIN_WORKER_ONLY_NAMES: 'shell',
    })).toEqual(['facts-absorb']);
    expect(parseWorkerOnlyNames([], {
      GBRAIN_WORKER_ONLY_NAMES: 'facts-absorb,chronicle_extract',
    })).toEqual(['facts-absorb', 'chronicle_extract']);
  });

  test('rejects an empty allow-list', () => {
    expect(() => parseWorkerOnlyNames(['--only', ' , '], {})).toThrow('--only must contain');
  });

  test('keepOnly makes the claim set exact', () => {
    const worker = new MinionWorker({} as never);
    worker.register('facts-absorb', async () => ({}));
    worker.register('chronicle_extract', async () => ({}));
    worker.register('shell', async () => ({}));
    worker.keepOnly(['facts-absorb', 'chronicle_extract']);
    expect(worker.registeredNames).toEqual(['facts-absorb', 'chronicle_extract']);
  });
});
