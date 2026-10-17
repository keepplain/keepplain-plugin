/**
 * A prompt that asks where code came from ("откуда взялся X", "who added this", "why is this here"): git answers what
 * changed and when, the session the change was made in answers why. Agents answered such questions from git alone and
 * never asked the person's memory (search_my_work with paths or a commit), so the prompt hook adds one line saying so.
 * Matched here, on the person's computer: the prompt never leaves it.
 */
import { commandIn } from './agent.mjs';

// Russian and English, the languages the site's users write prompts in most. Narrow on purpose: a question about a
// failing test ("почему падает") is not one about the origin of code.
const ASKS = [
    /откуда\s+(?:взял(?:ся|ась|ось|ись)|появил(?:ся|ась|ось|ись)|пришл[аио]?|это|этот|эта|эти|тут|здесь)/iu,
    /кто\s+(?:и\s+зачем\s+)?(?:добавил|написал|создал|поменял|изменил|удалил|убрал|внёс|внес)/iu,
    /зачем\s+(?:\S+\s+){0,3}?(?:добавил[аи]?|написал[аи]?|поменял[аи]?|изменил[аи]?|убрал[аи]?|нуж(?:ен|на|но|ны))/iu,
    /почему\s+(?:\S+\s+){0,3}?(?:так\s+)?(?:сделан[аоы]?|написан[аоы]?|устроен[аоы]?|реализован[аоы]?|добавил[аи]?|поменял[аи]?|изменил[аи]?|убрал[аи]?|удалил[аи]?)(?![\p{L}])/iu,
    /(?:в\s+каком|какой|каким)\s+коммит/iu,
    /истори[яюи]\s+(?:файла|класса|метода|функции|изменений)/iu,
    /where\s+(?:did|does|do)\s+.{1,80}?\s+come\s+from/iu,
    /who\s+(?:added|wrote|introduced|created|changed|removed|deleted)/iu,
    /why\s+(?:was|were|did\s+(?:we|you|they|i|someone))\s+.{1,80}?\s+(?:added|introduced|changed|written|removed|deleted|add|introduce|change|write|remove|delete)\b/iu,
    /why\s+(?:is|are|does)\s+.{1,60}?\s+(?:here|there|exist)\b/iu,
    /(?:which|what)\s+commit/iu,
    /\bgit\s+blame\b|\bprovenance\b|\borigin\s+of\b/iu,
];

/** Whether a prompt asks where code came from or why it is the way it is. */
export function asksProvenance(prompt) {
    const text = String(prompt ?? '').slice(0, 2000);

    return ASKS.some((re) => re.test(text));
}

/** The line for the agent's context. */
export function provenanceContext(agent) {
    return `KeepPlain: this prompt asks where code came from or why it is the way it is. Git shows only what changed; the reason is in the conversation the change was made in. After finding the commit (git log or git blame), call search_my_work with the project key, the file paths and the commit with its Agent-Session trailer values, as the ${commandIn(agent, 'resume')} skill says (its step on why code changed), and say what it found, or that no synced session made the change.`;
}
