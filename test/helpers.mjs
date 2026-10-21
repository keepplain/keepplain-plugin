// Shared by the tests; not a test file itself.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

/**
 * KEEPPLAIN_BIN=dist/keepplain-… runs the commands and hooks of the tests on the single file built by
 * scripts/build.mjs instead of the scripts (npm run test:binary): the same checks, under Bun (plan, stage 13.1).
 */
export const BINARY = process.env.KEEPPLAIN_BIN ? resolve(process.env.KEEPPLAIN_BIN) : null;
const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));

/** [program, arguments] that run `keepplain <args>`. */
export const coders = (args) => (BINARY ? [BINARY, args] : [process.execPath, [join(scripts, 'keepplain.mjs'), ...args]]);

/** [program, arguments] that run a hook as the agent does: session-start, stop or session-end; --agent=codex for Codex. */
export function hookCommand(name, args = []) {
    if (!BINARY) return [process.execPath, [join(scripts, `${name}.mjs`), ...args]];

    return [BINARY, ['hook', args.includes('--agent=codex') ? 'codex' : 'claude-code', name]];
}

/**
 * Waits until check() is true, for something a hook left running in the background: an upload, a line in a log.
 * A deadline, not a number of tries: a loaded CI runner is slow, and its slowness is not a failure.
 */
export async function waitFor(check, ms = 30_000) {
    const until = Date.now() + ms;
    while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}

export const plain = (text) => text.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

/**
 * `keepplain <args>` run in a pseudo-terminal by `script`, with $input typed in once it asks `[y/N]`: {status, out}.
 * Null where `script` cannot give it one (Windows): nothing lets a script answer the question otherwise.
 */
export function inTerminal(args, input, { env, cwd }) {
    if (process.platform === 'win32') return null;
    const [program, programArgs] = coders(args);
    const quoted = [program, ...programArgs].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const linux = spawnSync('script', ['--version'], { encoding: 'utf8' }).stdout?.includes('util-linux');
    const scriptArgs = linux ? ['-qec', quoted, '/dev/null'] : ['-q', '/dev/null', 'sh', '-c', quoted];
    if (spawnSync('script', linux ? ['-qec', 'true', '/dev/null'] : ['-q', '/dev/null', 'true']).status !== 0) return null;

    return new Promise((resolve) => {
        const child = spawn('script', scriptArgs, { env, cwd });
        let out = '';
        child.stdout.on('data', (d) => {
            out += d;
            // Readline moves the cursor after its question, so the escape codes go first. `script` waits for its
            // input to end before it exits.
            if (/\[y\/N\]$/.test(plain(out).trimEnd()) && child.stdin.writable) child.stdin.end(input);
        });
        const stuck = setTimeout(() => child.kill(), 60_000);
        child.on('close', (status) => {
            clearTimeout(stuck);
            resolve({ status, out: plain(out) });
        });
    });
}

/** A throwaway repository with commits at fixed dates; returns the hashes in order. */
export function makeRepo(remote = 'git@github.com:mara/shop.git') {
    const dir = mkdtempSync(join(tmpdir(), 'ct-repo-'));
    const run = (args, date) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();

    run(['init', '-q', '-b', 'main']);
    if (remote) run(['remote', 'add', 'origin', remote]);
    const hashes = [];
    for (const [i, date] of ['2026-09-01T09:00:00Z', '2026-09-01T10:10:00Z', '2026-09-01T10:40:00Z'].entries()) {
        writeFileSync(join(dir, 'app.txt'), `line\n`.repeat(i + 1));
        run(['add', '.'], date);
        run(['commit', '-q', '-m', ['Initial commit', 'Add a limiter keyed by email', 'Cover the limiter with tests'][i]], date);
        hashes.push(run(['rev-parse', 'HEAD'], date));
    }

    return { dir, hashes };
}

/**
 * Text like a rollout's, the same for a seed every time: JSON lines, each with one of a few dozen phrases (some of
 * their words not ASCII), cut at $bytes. With $binary, bytes nothing compresses. The zstd fixtures are made of these
 * (test/fixtures/zstd/make.mjs), and kept small by how much the lines repeat: the plugin folder has a size limit.
 */
export function sample(bytes, seed = 1, binary = false) {
    // mulberry32
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), a | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    if (binary) return Buffer.from(Array.from({ length: bytes }, () => Math.floor(next() * 256)));
    const words = 'fix the flaky queue test login route limiter keyed by email retry backoff token cache очередь тест готово — café 🙂 npm run build git commit diff branch main'.split(' ');
    const phrases = Array.from({ length: 40 }, () => Array.from({ length: 3 + Math.floor(next() * 20) }, () => words[Math.floor(next() * words.length)]).join(' '));
    const lines = [];
    for (let size = 0, i = 0; size < bytes; i++) {
        const text = phrases[Math.floor(next() * phrases.length)];
        const line = JSON.stringify({ timestamp: new Date(Date.UTC(2026, 9, 1) + i * 7000).toISOString(), type: 'response_item', payload: { type: 'message', role: next() < 0.5 ? 'user' : 'assistant', content: [{ type: 'input_text', text }] } });
        lines.push(line);
        size += Buffer.byteLength(line) + 1;
    }

    return Buffer.from(lines.join('\n') + '\n').subarray(0, bytes);
}

/**
 * $bytes as one zstd frame: compressed by node:zlib where this Node has zstd (22.15 on), else in raw blocks, which zstd
 * allows, so that a test makes a compressed rollout on every Node. The size goes in the header, as Codex writes it.
 */
export function zstdFrame(bytes) {
    if (typeof zlib.zstdCompressSync === 'function') return zlib.zstdCompressSync(bytes, { pledgedSrcSize: bytes.length });
    const header = Buffer.alloc(13);
    header.writeUInt32LE(0xfd2fb528, 0);
    // A single segment, eight bytes of size.
    header[4] = 0xe0;
    header.writeBigUInt64LE(BigInt(bytes.length), 5);
    const blocks = [];
    for (let at = 0; at === 0 || at < bytes.length; at += 128 * 1024) {
        const block = bytes.subarray(at, at + 128 * 1024);
        const last = at + 128 * 1024 >= bytes.length ? 1 : 0;
        const h = last | (block.length << 3);
        blocks.push(Buffer.from([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff]), block);
    }

    return Buffer.concat([header, ...blocks]);
}

/**
 * What Codex does to a rollout it has not written to for a week (lib/session.mjs, transcriptFile): $path.zst in its
 * place, with the time it was changed kept. Returns the new path.
 */
export function compressRollout(path) {
    const { mtime } = statSync(path);
    const zst = `${path}.zst`;
    writeFileSync(zst, zstdFrame(readFileSync(path)));
    utimesSync(zst, mtime, mtime);
    rmSync(path);

    return zst;
}
