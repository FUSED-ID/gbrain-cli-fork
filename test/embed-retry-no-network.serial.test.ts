/**
 * GBRAIN_TEST_NO_NETWORK must fail on the first transient embed failure,
 * while the unset default keeps the existing retry count.
 *
 * Serial: mock.module replaces the embedding transport for this process.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const networkError = Object.assign(new Error('socket reset'), { code: 'ECONNRESET' });
let embedCalls = 0;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async () => {
    embedCalls++;
    throw networkError;
  },
}));

const {
  _setAbortableSleepForTests,
  embedBatchWithBackoff,
  MAX_RATE_LIMIT_RETRIES,
} = await import('../src/core/embed-retry.ts');

let sleepCalls: number[] = [];

beforeEach(() => {
  sleepCalls = [];
  _setAbortableSleepForTests(async (ms) => { sleepCalls.push(ms); });
});

afterEach(() => {
  _setAbortableSleepForTests(null);
  delete process.env.GBRAIN_TEST_NO_NETWORK;
  embedCalls = 0;
  sleepCalls = [];
});

describe('GBRAIN_TEST_NO_NETWORK', () => {
  test('unset preserves the retry path for a transient network failure', async () => {
    delete process.env.GBRAIN_TEST_NO_NETWORK;

    await expect(embedBatchWithBackoff(['stubbed text'])).rejects.toThrow('socket reset');
    expect(embedCalls).toBe(MAX_RATE_LIMIT_RETRIES + 1);
    expect(sleepCalls).toHaveLength(MAX_RATE_LIMIT_RETRIES);
    expect(sleepCalls.every((ms) => ms > 0)).toBe(true);
  });

  test('set throws the first transient failure without backoff retries', async () => {
    process.env.GBRAIN_TEST_NO_NETWORK = '1';

    let caught: unknown;
    try {
      await embedBatchWithBackoff(['stubbed text']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('GBRAIN_TEST_NO_NETWORK=1');
    expect((caught as Error).cause).toBe(networkError);
    expect(embedCalls).toBe(1);
    expect(sleepCalls).toEqual([]);
  });
});
