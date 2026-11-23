/**
 * Stage L0 of the local app (docs/local-app-plan.md on the site): does the SQLite this program runs on have what the
 * local index needs? Run with Bun, as a script and compiled the way scripts/build.mjs compiles the program, on every
 * platform the program ships for (.github/workflows/local-probe.yml). Prints one JSON object; exits 1 when something
 * the index needs is missing.
 *
 *   bun scripts/local/probe.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Database } = await import('bun:sqlite');
const checks = {};
const probe = (name, fn) => {
    try {
        const value = fn();
        checks[name] = value === undefined ? true : value;
    } catch (e) {
        checks[name] = `missing: ${e.message}`;
    }
};

const db = new Database(':memory:');
const one = (sql, ...params) => db.query(sql).get(...params);

probe('sqlite_version', () => one('select sqlite_version() as v').v);
probe('compile_options', () => db.query('pragma compile_options').all().map((r) => r.compile_options).filter((o) => /FTS|JSON|THREADSAFE|MAX_VARIABLE/.test(o)));
probe('fts5_unicode61', () => {
    db.exec("create virtual table words using fts5(text, tokenize = 'unicode61 remove_diacritics 2')");
    db.query('insert into words(text) values (?)').run('выпуск сертификат issue certificate');
    return one("select count(*) as n from words where words match 'выпуск AND issue'").n === 1;
});
probe('fts5_trigram', () => {
    db.exec("create virtual table grams using fts5(text, tokenize = 'trigram')");
    db.query('insert into grams(text) values (?)').run('class TaskMatcher extends Base');
    return one("select count(*) as n from grams where grams match 'matcher'").n === 1;
});
probe('fts5_bm25', () => typeof one("select bm25(words) as r from words where words match 'issue'").r === 'number');
probe('json', () => one(`select json_extract('{"a":[1,2,3]}', '$.a[1]') as v`).v === 2);
probe('json_each', () => one(`select count(*) as n from json_each('[1,2,3]')`).n === 3);
probe('wal_file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kp-probe-'));
    try {
        const file = new Database(join(dir, 'local.db'));
        const mode = file.query('pragma journal_mode = wal').get().journal_mode;
        file.close();
        return mode === 'wal';
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

const needed = ['fts5_unicode61', 'fts5_trigram', 'json', 'json_each', 'wal_file'];
const ok = needed.every((name) => checks[name] === true);
console.log(JSON.stringify({ ok, platform: process.platform, arch: process.arch, bun: Bun.version, compiled: !process.execPath.toLowerCase().includes('bun') ? true : false, checks }, null, 2));
process.exit(ok ? 0 : 1);
