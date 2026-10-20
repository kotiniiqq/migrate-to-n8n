/** Names: n8n node names must be unique in a workflow, and expressions refer to nodes by name. */

const MAX_NODE_NAME = 64;

/** `wanted`, or `wanted 2`, `wanted 3`… whichever is free; trimmed so the result stays within 64 characters. */
export function uniqueName(wanted: string, taken: Set<string>): string {
  const base = [...(wanted.replace(/\s+/g, ' ').trim() || 'Step')].slice(0, MAX_NODE_NAME).join('').trim();
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const name = [...base].slice(0, MAX_NODE_NAME - suffix.length).join('').trimEnd() + suffix;
    if (!taken.has(name)) return name;
  }
}

/** `$('Node name')` with the name escaped for a single-quoted JS string. */
export function nodeRef(name: string): string {
  return `$('${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`;
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** A file name (without extension) that is safe on Windows, macOS and Linux. */
export function safeFileName(name: string): string {
  let s = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  s = [...s].slice(0, 80).join('').replace(/[. ]+$/, '').replace(/^\.+/, '').trim();
  if (!s) s = 'workflow';
  if (RESERVED.test(s)) s = `${s} workflow`;
  return s;
}
