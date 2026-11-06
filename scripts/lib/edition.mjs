/**
 * Which copy of the plugin this is. The repository, the single file and what `keepplain enable` lays out are the full
 * program. The copy for Claude's plugin directory (scripts/directory.mjs, the branch `directory`) is the same code with
 * this line changed, without hooks, a hooks module or a header helper, which that directory takes only from Verified
 * organizations, and without the files that set any of them up.
 *
 * That copy runs what its skills run and nothing else: a command that needs the hooks would say it is on and then do
 * nothing, and one that installs them has no business in a copy the directory reviewed without them.
 */
export const EDITION = 'full';

/** What the skills of the directory's copy run, and the two every program answers. */
export const DIRECTORY_COMMANDS = ['preview', 'send', 'discard', 'login', 'logout', 'whoami', 'context', 'mcp-call', 'handoff', 'use', 'share', 'version', 'help'];

/** Whether this copy runs $command. No command at all is the usage text. */
export const editionRuns = (command, edition = EDITION) => edition !== 'directory' || !command || DIRECTORY_COMMANDS.includes(command);

/** What the directory's copy says of a command it does not have. */
export const notInThisCopy = (command) => `"${command}" is not part of KeepPlain from Claude's plugin directory: that copy has no hooks and changes nothing on this computer by itself. The full program is a separate install: https://keepplain.com/plugins`;
