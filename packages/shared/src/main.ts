import { pathToFileURL } from 'node:url';

/** True when the module at `metaUrl` is the script node was asked to run (works on Windows and with spaces). */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try { return pathToFileURL(entry).href === metaUrl; } catch { return false; }
}
