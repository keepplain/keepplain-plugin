// A stand-in for the command of an agent that keeps its sessions in a database (opencode, kilo, goose, crush), for
// test/readers-live.test.mjs: it prints what the real command printed in the live run the fixtures were taken from.
//
//   FAKE_CLI_DIR   the fixture's folder: <dir>/db-sessions.json, export.json, session-list.json, session-show.json
//   FAKE_CLI_LOG   a file that gets every call, a line of JSON each
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// node --test picks up every file under test/: run that way, there is nothing to do.
if (!process.env.FAKE_CLI_DIR) process.exit(0);

const given = process.argv.slice(2);
const dir = process.env.FAKE_CLI_DIR;
if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(given)}\n`);
// Crush is told its project first: crush --cwd <project> session …
const args = given[0] === '--cwd' ? given.slice(2) : given;
const print = (name) => process.stdout.write(readFileSync(join(dir, name), 'utf8'));
const session = (id) => JSON.parse(readFileSync(join(dir, 'db-sessions.json'), 'utf8')).some((s) => s.id === id);
const json = args.includes('json') || args.includes('--json');

if (args[0] === 'session' && args[1] === 'list' && json) print('session-list.json');
else if (args[0] === 'session' && args[1] === 'export' && json) print('export.json');
else if (args[0] === 'session' && args[1] === 'show' && json) print('session-show.json');
else if (args[0] === 'db' && /^select /.test(args[1] ?? '') && json) print('db-sessions.json');
else if (args[0] === 'export' && session(args[1])) {
    // As opencode does: a line for the person on stderr, the session on stdout.
    console.error(`Exporting session: ${args[1]}`);
    print('export.json');
} else {
    console.error(`fake-cli: no answer for ${JSON.stringify(given)}`);
    process.exit(1);
}
