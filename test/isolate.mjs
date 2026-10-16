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
    // The Claude app's own records of its conversations (lib/continuation.mjs), read by the import of past sessions.
    process.env.KEEPPLAIN_CLAUDE_APP_DIR ||= join(dir, 'claude-app');
    process.env.PI_CODING_AGENT_DIR ||= join(dir, 'pi');
    process.env.PI_CODING_AGENT_SESSION_DIR ||= join(dir, 'pi-sessions');
    // Antigravity's ~/.gemini, where its surfaces keep their conversations (lib/antigravity.mjs).
    process.env.KEEPPLAIN_GEMINI_DIR ||= join(dir, 'gemini');
    delete process.env.ANTIGRAVITY_CONVERSATION_ID;
    delete process.env.PI_SESSION_ID;
    delete process.env.PI_SESSION_FILE;
    delete process.env.CURSOR_TRANSCRIPT_PATH;
    delete process.env.CURSOR_PROJECT_DIR;
}
