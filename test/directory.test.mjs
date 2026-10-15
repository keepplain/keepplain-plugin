// What Claude's plugin directory takes (claude.com/docs/plugins/pre-submission-checklist), checked on the files git
// tracks: the whole repository is the plugin folder. The directory's scanner stopped fetching this repository once it
// passed 2 MiB (021287d, 2.09 MiB: "Files in the repository the scanner won't accept"; every version up to 1.94 MiB
// passed), so the total is kept under 1.9 MiB to hear of it here first. Files over 256 KiB that are not images or fonts,
// and more than 512 files, hold a version for a reviewer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let files = null;
try {
    files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
    // Not a git checkout (an installed copy of the plugin): nothing to measure.
}
const sizes = (files ?? []).map((file) => ({ file, size: statSync(join(ROOT, file)).size }));
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
