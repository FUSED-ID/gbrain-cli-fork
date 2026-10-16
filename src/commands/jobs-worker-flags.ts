/** Stable name for the bounded remote autopilot cycle job. */
export const REMOTE_AUTOPILOT_JOB_NAME = 'remote-autopilot-cycle';

function parseWorkerFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/** Parse the worker job-name allow-list used by bounded drainers. */
export function parseWorkerOnlyNames(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  const raw = parseWorkerFlag(args, '--only') ?? env.GBRAIN_WORKER_ONLY_NAMES;
  if (raw === undefined) return undefined;
  const names = [...new Set(raw.split(',').map(name => name.trim()).filter(Boolean))];
  if (names.length === 0) throw new Error('--only must contain at least one comma-separated job name');
  return names;
}
