import { describe, expect, test } from 'bun:test';
import { formatResult } from '../src/cli.ts';

/**
 * `gbrain timeline <slug> --json` accepted `--json` and still printed the
 * human lines, which drop `detail` and `id`. `--json` must emit the rows.
 */
describe('formatResult - get_timeline --json', () => {
  const entry = {
    id: 4,
    date: '2026-03-01',
    summary: 'Shipped the ledger',
    source: 'notes',
    detail: 'oauth columns landed',
  };

  test('--json returns timeline rows including detail and id', () => {
    const out = formatResult('get_timeline', [entry], { json: true });
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(entry);
    expect(parsed[0].date).toBe('2026-03-01');
    expect(parsed[0].summary).toBe('Shipped the ledger');
    expect(parsed[0].source).toBe('notes');
    expect(parsed[0].detail).toBe('oauth columns landed');
    expect(parsed[0].id).toBe(4);
  });

  test('--json keeps an empty timeline machine-readable', () => {
    expect(JSON.parse(formatResult('get_timeline', [], { json: true }))).toEqual([]);
  });

  test('plain output is unchanged when --json is absent', () => {
    expect(formatResult('get_timeline', [entry], {})).toBe('2026-03-01  Shipped the ledger [notes]\n');
    expect(formatResult('get_timeline', [], {})).toBe('No timeline entries.\n');
    expect(formatResult('get_timeline', [
      { id: 1, date: '2026-01-02', summary: 'No source', source: '', detail: 'hidden detail' },
    ], {})).toBe('2026-01-02  No source\n');
  });

  test('--json=false stays on the human path', () => {
    const out = formatResult('get_timeline', [entry], { json: false });
    expect(() => JSON.parse(out)).toThrow();
    expect(out).toBe('2026-03-01  Shipped the ledger [notes]\n');
    expect(out).not.toContain('oauth columns landed');
  });
});
