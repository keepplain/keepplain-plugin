#!/usr/bin/env node
/**
 * The tests that run commands and hooks, run again on the single file for this platform that scripts/build.mjs made
 * (plan, stage 13.1): preview, send, login and whoami against a stand-in for the site, auto mode's background runs,
 * the proxy tunnel, the hooks. `npm run test:binary`, after `npm run build`; or give the file: node scripts/smoke.mjs <file>.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assetName } from './lib/update.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(process.argv[2] ?? join(root, 'dist', assetName()));
if (!existsSync(file)) {
    console.error(`No ${file}: run npm run build first.`);
    process.exit(1);
}

const tests = ['cli', 'codex-auto', 'enable', 'enable-pi-cursor', 'enable-readers', 'git', 'githooks', 'library', 'pi-cursor', 'readers-hooks', 'readers-live', 'terminal', 'update', 'use'].map((name) => join(root, 'test', `${name}.test.mjs`));
const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(root, 'test', 'isolate.mjs')).href, '--test', ...tests], { stdio: 'inherit', env: { ...process.env, KEEPPLAIN_BIN: file } });
process.exit(result.status ?? 1);
