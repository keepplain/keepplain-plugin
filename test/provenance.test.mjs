import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asksProvenance, provenanceContext } from '../scripts/lib/provenance.mjs';

test('questions of where code came from are told from other questions', () => {
    for (const prompt of [
        'Откуда взялся BackfillDailyProductMetrics ?',
        'откуда эта миграция',
        'Кто добавил этот флаг в конфиг?',
        'Зачем мы добавили retry в джобу?',
        'зачем здесь нужен этот костыль',
        'Почему этот метод так написан?',
        'В каком коммите поменяли тайм-аут?',
        'покажи историю файла routes/console.php',
        'Where did this helper come from?',
        'Who introduced the cache key prefix?',
        'Why was the timeout changed to 30s?',
        'why is this check here',
        'which commit removed the fallback',
    ]) assert.ok(asksProvenance(prompt), prompt);

    for (const prompt of [
        'Почему падает тест очередей?',
        'Почини воркеры очередей',
        'Добавь кнопку в шапку',
        'Why does the build fail on Windows?',
        'Who is the owner of this repo on GitHub? Just curious about the settings',
        'Add a commit hook',
        '',
    ]) assert.ok(!asksProvenance(prompt), prompt);
});

test('the line names the resume skill the way each agent calls it', () => {
    assert.match(provenanceContext('claude-code'), /\/keepplain:resume/);
    assert.match(provenanceContext('codex'), /\$keepplain:resume/);
    assert.match(provenanceContext('antigravity'), /\/keepplain-resume/);
});
