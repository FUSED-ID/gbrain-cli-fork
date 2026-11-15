import { describe, expect, test } from 'bun:test';
import { parseWorkerOnlyNames } from '../src/commands/jobs.ts';
<<<<<<< HEAD
=======
import { MinionWorker } from '../src/core/minions/worker.ts';
>>>>>>> 6690b2ee7485e0f829013e571360aaff5d22ce4e

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

<<<<<<< HEAD
  test('an empty environment allow-list is rejected', () => {
    expect(() => parseWorkerOnlyNames([], { GBRAIN_WORKER_ONLY_NAMES: ' , ' }))
      .toThrow('--only must contain at least one worker job name');
  });

  test('unknown syntactically valid names are preserved for handler validation', () => {
    expect(parseWorkerOnlyNames(['--only', 'facts-absorb,typo-name'], {}))
      .toEqual(['facts-absorb', 'typo-name']);
  });

=======
>>>>>>> 6690b2ee7485e0f829013e571360aaff5d22ce4e
  test('rejects an empty allow-list', () => {
    expect(() => parseWorkerOnlyNames(['--only', ' , '], {})).toThrow('--only must contain');
  });

<<<<<<< HEAD
=======
  test('keepOnly makes the claim set exact', () => {
    const worker = new MinionWorker({} as never);
    worker.register('facts-absorb', async () => ({}));
    worker.register('chronicle_extract', async () => ({}));
    worker.register('shell', async () => ({}));
    worker.keepOnly(['facts-absorb', 'chronicle_extract']);
    expect(worker.registeredNames).toEqual(['facts-absorb', 'chronicle_extract']);
  });

>>>>>>> 6690b2ee7485e0f829013e571360aaff5d22ce4e
  test('R1 rejects a bare --only flag', () => {
    expect(() => parseWorkerOnlyNames(['--only'], {})).toThrow('--only');
  });

  test('R2 does not fall back to env after a bare --only flag', () => {
    expect(() => parseWorkerOnlyNames(['--only'], {
      GBRAIN_WORKER_ONLY_NAMES: 'shell',
    })).toThrow('--only');
  });

  test('R3 accepts the equals form', () => {
    expect(parseWorkerOnlyNames(['--only=facts-absorb'], {})).toEqual(['facts-absorb']);
  });

  test('R4 rejects a flag-looking --only value', () => {
    expect(() => parseWorkerOnlyNames(['--only', '--queue', 'x'], {})).toThrow('--only');
  });

<<<<<<< HEAD
=======
  test('unknown allow-list names are named by keepOnly', () => {
    const worker = new MinionWorker({} as never);
    worker.register('facts-absorb', async () => ({}));
    expect(() => worker.keepOnly(['facts-absorb', 'facts-absorbb', 'typo-name']))
      .toThrow(/facts-absorbb.*typo-name|typo-name.*facts-absorbb/);
  });
>>>>>>> 6690b2ee7485e0f829013e571360aaff5d22ce4e
});
