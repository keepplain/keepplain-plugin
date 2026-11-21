/**
 * The person's home folder as the readers see it: where an agent keeps its files unless its own variable says another
 * place. KEEPPLAIN_USER_HOME stands in for it in the tests, so a test never lists the sessions of an agent that is
 * really on this computer.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const userHome = (env = process.env) => env.KEEPPLAIN_USER_HOME || homedir();

/** A path of an agent's variable with a leading ~ as the home folder. */
export const expand = (path, env = process.env) => (path === '~' ? userHome(env) : /^~[\/]/.test(path) ? join(userHome(env), path.slice(2)) : path);
