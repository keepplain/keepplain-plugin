// zstd unpacked with no dependency (lib/zstd.mjs), for the rollouts Codex compresses. The fixtures were compressed by
// libzstd (test/fixtures/zstd/make.mjs); where this Node has zstd itself, what it compresses on the spot comes back too.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as zlib from 'node:zlib';
import { zstdChunks, zstdContentSize } from '../scripts/lib/zstd.mjs';
import { sample, zstdFrame } from './helpers.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/zstd/${name}`, import.meta.url));
const unpack = (bytes, partial = false) => Buffer.concat([...zstdChunks(bytes, partial)]);

test('what libzstd compressed comes back byte for byte: blocks of Huffman literals and FSE sequences, a checksum, its highest level', () => {
    assert.ok(unpack(fixture('text-3.zst')).equals(sample(160_000, 1)));
    assert.ok(unpack(fixture('text-19.zst')).equals(sample(100_000, 2)));
    assert.equal(zstdContentSize(fixture('text-3.zst')), 160_000);
});

test('a window smaller than the text: matches reach back nearly as far as it goes, and what is older is let go', () => {
    const text = Buffer.concat(Array(10).fill(sample(30_000, 5)));
    const chunks = [...zstdChunks(fixture('window.zst'))];
    assert.ok(Buffer.concat(chunks).equals(text));
    assert.ok(chunks.length > 1, 'a block at a time');
});

test('frames one after another, a skippable one among them, of all kinds of data', () => {
    // A run of one byte, bytes nothing compresses, nothing, a negative level, eight byte values (Huffman weights
    // written as they are), letters with no repeat long enough for a match (literals only), a short text (its literals
    // in one Huffman stream, not four).
    const few = sample(4096, 6, true).map((b) => b & 7);
    const letters = Buffer.from(sample(768, 7, true).toString('base64'));
    const want = Buffer.concat([Buffer.alloc(200_000, 'a'), sample(1024, 3, true), sample(20_000, 4), few, letters, sample(200, 8)]);
    assert.ok(unpack(fixture('mixed.zst')).equals(want));
});

test('the start of a file unpacks as far as its whole blocks go; read as a whole file, it is cut short', () => {
    const file = fixture('text-3.zst');
    // Cut inside its second and last block: the first is there whole.
    const head = unpack(file.subarray(0, file.length - 100), true);
    assert.equal(head.length, 128 * 1024);
    assert.ok(head.equals(sample(160_000, 1).subarray(0, head.length)));
    assert.equal(unpack(file.subarray(0, 6), true).length, 0, 'not even the frame header');
    assert.throws(() => unpack(file.subarray(0, file.length - 10)), /Not zstd this can unpack: the data ends inside/);
});

test('what is not zstd, or is not whole, or needs a dictionary, is turned down', () => {
    assert.throws(() => unpack(Buffer.from('{"type":"session_meta","payload":{}}\n')), /no zstd frame/);
    // A frame that names dictionary 7.
    assert.throws(() => unpack(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x21, 0x07, 0x01, 0x00, 0x00])), /needs a dictionary/);
    // A frame that says it holds 9 bytes, and holds a raw block of 8.
    assert.throws(() => unpack(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 9, 0x41, 0, 0, ...Buffer.from('{"a":1}\n')])), /the frame says 9 bytes and holds 8/);
    // A compressed block cut in the middle of its sequences.
    const text = fixture('text-19.zst');
    const broken = Buffer.from(text);
    broken.fill(0, 200, 400);
    assert.throws(() => unpack(broken), /Not zstd this can unpack/);
});

test('the frames the tests write for a compressed rollout come back: raw blocks where this Node has no zstd', () => {
    for (const size of [0, 1, 128 * 1024, 128 * 1024 + 1, 300_000]) {
        const text = sample(size, size + 1);
        const frame = zstdFrame(text);
        assert.ok(unpack(frame).equals(text), `${size} bytes`);
        assert.equal(zstdContentSize(frame), size);
    }
});

const native = typeof zlib.zstdCompressSync === 'function';
test('what this Node compresses comes back, at levels from the fastest to the highest', { skip: !native && 'this Node has no zstd' }, () => {
    const { ZSTD_c_checksumFlag, ZSTD_c_compressionLevel } = zlib.constants;
    // Up to a window of 2 MB, letters with few matches (literals sections of the largest kind), bytes nothing compresses.
    const inputs = [Buffer.alloc(0), Buffer.from('x'), sample(1000, 7), sample(131_073, 8), sample(1_500_000, 9), Buffer.from(sample(150_000, 11, true).toString('base64')), sample(50_000, 10, true)];
    for (const level of [-5, 1, 3, 9, 19]) {
        for (const [n, input] of inputs.entries()) {
            const params = { [ZSTD_c_compressionLevel]: level, [ZSTD_c_checksumFlag]: n % 2 };
            // With its size said and without: a frame need not say it.
            for (const options of [{ params, pledgedSrcSize: input.length }, { params }]) {
                assert.ok(unpack(zlib.zstdCompressSync(input, options)).equals(input), `level ${level}, input ${n}`);
            }
        }
    }
});
