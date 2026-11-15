export function skipPurgeWithoutConsent(
  purgeConsent: { olderThanHours: number } | undefined,
): {
  phase: 'purge';
  status: 'skipped';
  duration_ms: 0;
  summary: string;
  details: { reason: 'missing_purge_consent'; required_flag: '--yes-i-mean-it' };
} | null {
  if (
    purgeConsent === undefined ||
    !Number.isFinite(purgeConsent.olderThanHours) ||
    purgeConsent.olderThanHours < 0
  ) {
    return {
      phase: 'purge',
      status: 'skipped',
      duration_ms: 0,
      summary: 'purge skipped: explicit --yes-i-mean-it is required',
      details: {
        reason: 'missing_purge_consent',
        required_flag: '--yes-i-mean-it',
      },
    };
  }
  return null;
}
