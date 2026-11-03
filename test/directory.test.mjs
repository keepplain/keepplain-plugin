// What Claude's plugin directory takes (claude.com/docs/plugins/pre-submission-checklist), checked on the files git
// tracks: the whole repository is the plugin folder. The directory's scanner stopped fetching this repository once it
// passed 2 MiB (021287d, 2.09 MiB: "Files in the repository the scanner won't accept"; every version up to 1.94 MiB
// passed), so the total is kept under 1.9 MiB to hear of it here first. Files over 256 KiB that are not images or fonts,
// and more than 512 files, hold a version for a reviewer.
//
// Measured as git keeps the files (the index's blobs), which is what GitHub serves the scanner: a Windows checkout turns
// the line ends to CRLF, and the files on its disk come out some 28 KiB larger than the repository is.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let files = null;
try {
    // "<mode> <blob> <stage>\t<path>" for each file.
    files = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
        .map((entry) => ({ blob: entry.split(' ')[1], file: entry.slice(entry.indexOf('\t') + 1) }));
} catch {
    // Not a git checkout (an installed copy of the plugin): nothing to measure.
}
const blobSizes = files?.length
    ? execFileSync('git', ['cat-file', '--batch-check=%(objectsize)'], { cwd: ROOT, encoding: 'utf8', input: files.map((f) => f.blob).join('\n') + '\n' }).trim().split('\n').map(Number)
    : [];
const sizes = (files ?? []).map(({ file }, i) => ({ file, size: blobSizes[i] }));
const skip = !files && 'not a git checkout';

test('the plugin folder stays well under the 2 MiB the directory scanner fetches', { skip }, () => {
    const total = sizes.reduce((sum, f) => sum + f.size, 0);
    const largest = [...sizes].sort((a, b) => b.size - a.size).slice(0, 5).map((f) => `${f.file} ${f.size}`).join(', ');
    assert.ok(total < 1.9 * 1024 * 1024, `${total} bytes in ${sizes.length} files; the largest: ${largest}`);
});

test('no file but an image or a font reaches 256 KiB, and there are at most 512 files', { skip }, () => {
    const big = sizes.filter((f) => !/\.(png|jpe?g|gif|webp|woff2?|ttf|otf)$/i.test(f.file) && f.size >= 256 * 1024);
    assert.deepEqual(big, []);
    assert.ok(sizes.length <= 512, `${sizes.length} files`);
});
