// Preloaded into every test process (npm test: node --import ./test/isolate.mjs --test). The agents that keep their files
// in the person's home are pointed at throwaway folders, so a test that meets a real Cursor or Pi on this computer
// never reads or writes its files: enable writes hooks, skills and a library entry into Cursor's folder, and the
// sessions of a Pi that is really here would be listed among a test's. Tests that set these themselves keep theirs.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.CT_TEST_ISOLATED) {
    const dir = mkdtempSync(join(tmpdir(), 'ct-agents-'));
    process.env.CT_TEST_ISOLATED = dir;
    process.env.CURSOR_CONFIG_DIR ||= join(dir, 'cursor');
    // Cursor's own User folder, whose workspaces the import of past sessions reads (lib/past.mjs).
    process.env.KEEPPLAIN_CURSOR_USER_DIR ||= join(dir, 'cursor-user');
    process.env.PI_CODING_AGENT_DIR ||= join(dir, 'pi');
    process.env.PI_CODING_AGENT_SESSION_DIR ||= join(dir, 'pi-sessions');
    delete process.env.PI_SESSION_ID;
    delete process.env.PI_SESSION_FILE;
    delete process.env.CURSOR_TRANSCRIPT_PATH;
    delete process.env.CURSOR_PROJECT_DIR;
}
