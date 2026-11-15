function parseWorkerFlag(args: string[], flag: string): string | undefined {
  const equalsPrefix = `${flag}=`;
  const index = args.findIndex(arg => arg === flag || arg.startsWith(equalsPrefix));
  if (index < 0) return undefined;

  const token = args[index];
  const raw = token.startsWith(equalsPrefix)
    ? token.slice(equalsPrefix.length)
    : args[index + 1];
  if (raw === undefined || raw.trim() === '' || raw.trim().startsWith('--')) {
    throw new Error('--only requires a non-empty comma-separated job name list');
  }
  return raw;
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
