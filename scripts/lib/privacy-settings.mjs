/**
 * The person's own privacy settings, on this computer only (~/.keepplain):
 *
 *   privacy.json  {"redact": ["Globex", "billing-core"]}  words to hide as [REDACTED:TERM] in every session: client
 *                 names, internal services. Written by hand; the plugin only reads it.
 *   kept.json     {"sha256": ["…"]}  values the person chose to send as they are (preview --keep). Hashes only, so
 *                 the file holds no secret; the same hashes go to the site, whose own check then leaves those alone.
 *
 * The check itself is privacy.mjs, generated from KeepPlain's resources/js/lib/privacyScan.ts.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, writePrivate } from './credentials.mjs';
import { Failure } from './failure.mjs';
import { PrivacyScan } from './privacy.mjs';

export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * A file written by hand on Windows: Notepad and PowerShell 5.1 put a BOM in front, and PowerShell's `>` and
 * Out-File write UTF-16. JSON.parse fails on all of these, so they are decoded here first.
 */
export function decodeText(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');

    return bytes.toString('utf8').replace(/^﻿/, '');
}

function read(name) {
    try {
        return JSON.parse(decodeText(readFileSync(join(home(), name))));
    } catch {
        return {};
    }
}

/**
 * The words to hide. A privacy.json that is there but cannot be read stops the send: going on as if it were
 * empty would send the very words the person asked to hide.
 */
export function terms() {
    const path = join(home(), 'privacy.json');
    if (!existsSync(path)) return [];

    let settings;
    try {
        settings = JSON.parse(decodeText(readFileSync(path)));
    } catch (e) {
        throw new Failure(`Could not read ${path} (${e.message}), so the words it lists would not be hidden. Fix the file or remove it, then send again.`);
    }
    const list = settings?.redact;
    if (list !== undefined && !Array.isArray(list)) {
        throw new Failure(`${path}: "redact" must be a list of words, like {"redact": ["Globex"]}. Fix the file, then send again.`);
    }

    return (list ?? []).filter((t) => typeof t === 'string' && t.trim() !== '');
}

export function keptHashes() {
    const list = read('kept.json').sha256;

    return new Set(Array.isArray(list) ? list.filter((h) => /^[0-9a-f]{64}$/.test(h)) : []);
}

export function keep(hashes) {
    const all = [...new Set([...keptHashes(), ...hashes])];
    writePrivate(join(home(), 'kept.json'), JSON.stringify({ sha256: all }, null, 2) + '\n');
}

/** A check with the person's words and kept values; kept values are matched by their hash. */
export function privacyScan() {
    const kept = keptHashes();

    return new PrivacyScan({ terms: terms(), keep: (value) => kept.has(sha256(value)) });
}

/** What goes to the site: counts, and the hashes of the kept values found in this session. Never a value. */
export function privacySummary(scan) {
    return scan.summary(scan.findings().filter((f) => f.kept).map((f) => sha256(f.value)));
}
