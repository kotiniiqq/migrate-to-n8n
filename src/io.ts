/** Reading what the user gives: a file on this computer or the file's contents. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { InputError } from './types.ts';

const MAX_BYTES = 20 * 1024 * 1024;

export function resolvePath(p: string): string {
  const t = p.trim().replace(/^["']|["']$/g, '');
  const home = t === '~' || t.startsWith('~/') || t.startsWith('~\\') ? join(homedir(), t.slice(1)) : t;
  return isAbsolute(home) ? home : resolve(process.cwd(), home);
}

/** Exactly one of `path` and `json`. Returns the text to parse. */
export function readInput(args: { path?: string; json?: string }): string {
  const hasPath = typeof args.path === 'string' && args.path.trim() !== '';
  const hasJson = typeof args.json === 'string' && args.json.trim() !== '';
  if (hasPath === hasJson) throw new InputError('Give either "path" (a file on this computer) or "json" (the file contents), not both.');
  if (hasJson) {
    if (Buffer.byteLength(args.json!) > MAX_BYTES) throw new InputError('The JSON is larger than 20 MB; pass the file path instead.');
    return args.json!;
  }
  const file = resolvePath(args.path!);
  if (!existsSync(file) || !statSync(file).isFile()) throw new InputError(`File not found: ${file}`);
  if (statSync(file).size > MAX_BYTES) throw new InputError(`The file is larger than 20 MB: ${file}`);
  return readFileSync(file, 'utf8');
}
