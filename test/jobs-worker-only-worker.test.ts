import { describe, expect, test } from 'bun:test';
import { MinionWorker } from '../src/core/minions/worker.ts';

describe('worker public handler registry', () => {
  test('registeredNames and getHandler expose registered handlers', () => {
    const worker = new MinionWorker({} as never);
    const sync = async () => ({ ok: true });
    const extract = async () => ({ ok: true });
    worker.register('sync', sync);
    worker.register('extract', extract);
    expect(worker.registeredNames).toEqual(['sync', 'extract']);
    expect(worker.getHandler('sync')).toBe(sync);
    expect(worker.getHandler('extract')).toBe(extract);
  });

  test('unknown handler lookup is empty and leaves registrations unchanged', () => {
    const worker = new MinionWorker({} as never);
    worker.register('sync', async () => ({}));
    expect(worker.getHandler('missing')).toBeUndefined();
    expect(worker.registeredNames).toEqual(['sync']);
  });
});
