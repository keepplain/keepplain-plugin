// The zstd fixtures of test/zstd.test.mjs, compressed by libzstd through node:zlib (Node 22.15 or newer):
//   node test/fixtures/zstd/make.mjs --write
// What they hold comes from sample() (test/helpers.mjs): the test makes it again to compare.
import { writeFileSync } from 'node:fs';
import * as zlib from 'node:zlib';
import { sample } from '../../helpers.mjs';

// node --test picks up every file under test/: run that way, there is nothing to do.
if (!process.argv.includes('--write')) process.exit(0);

const { ZSTD_c_checksumFlag, ZSTD_c_compressionLevel, ZSTD_c_windowLog } = zlib.constants;
const zstd = (bytes, level, checksum = false, windowLog = 0) =>
    zlib.zstdCompressSync(bytes, { pledgedSrcSize: bytes.length, params: { [ZSTD_c_compressionLevel]: level, [ZSTD_c_checksumFlag]: checksum ? 1 : 0, [ZSTD_c_windowLog]: windowLog } });
const write = (name, bytes) => writeFileSync(new URL(name, import.meta.url), bytes);

// Several blocks at the level Codex uses, with a checksum; the same kind of text at the highest level.
write('text-3.zst', zstd(sample(160_000, 1), 3, true));
write('text-19.zst', zstd(sample(100_000, 2), 19));
// A window of 32 KB under ten times the same 30 KB: matches reach back nearly as far as it goes, and the text runs past
// it. Level 9 finds those matches (level 3 keeps a third of the text as literals).
write('window.zst', zstd(Buffer.concat(Array(10).fill(sample(30_000, 5))), 9, false, 15));
// Frames one after another: a run of one byte, a skippable frame, bytes nothing compresses, nothing, a negative level,
// eight byte values (Huffman weights written as they are), letters with no repeat long enough for a match, a short
// text (its literals in one Huffman stream, not four).
const skippable = Buffer.from([0x5a, 0x2a, 0x4d, 0x18, 5, 0, 0, 0, 1, 2, 3, 4, 5]);
const few = sample(4096, 6, true).map((b) => b & 7);
const letters = Buffer.from(sample(768, 7, true).toString('base64'));
write('mixed.zst', Buffer.concat([
    zstd(Buffer.alloc(200_000, 'a'), 1), skippable, zstd(sample(1024, 3, true), 3), zstd(Buffer.alloc(0), 3), zstd(sample(20_000, 4), -5),
    zstd(few, 3), zstd(letters, 1), zstd(sample(200, 8), 3),
]));
