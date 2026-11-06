/**
 * A program and its arguments as one command line, for the shell that reads it. On their own because the copy of the
 * plugin in Claude's directory needs them too, and has no lib/plugin.mjs.
 */

/** Single-quoted for sh and Git Bash: nothing inside is special. */
export const shCommand = (parts) => parts.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(' ');
/** PowerShell: the call operator, then single-quoted words. */
export const psCommand = (parts) => `& ${parts.map((p) => `'${p.replace(/'/g, "''")}'`).join(' ')}`;
/** cmd.exe: double quotes; a Windows path holds none. */
export const cmdCommand = (parts) => parts.map((p) => (/[\s&^|<>()"]/.test(p) ? `"${p}"` : p)).join(' ');
