/**
 * Which of a repository's rules a prompt is about (KeepPlain plan: personal rules, stage 41): first the task, then
 * the rules for it. Matched here, on the person's computer, so the prompt never leaves it: the rule's keywords (the
 * site has a model write them, in English and in the language the person writes prompts in) count twice, the words
 * of the rule itself once. Words are cut to their first five letters, which is enough for "queues" to meet "queue"
 * and "очереди" to meet "очередь" without a dictionary.
 */

/** The most a prompt adds, and how much of a match it takes. */
export const MAX_PER_PROMPT = 6;
export const MIN_SCORE = 2;

const STEM = 5;

// Words that say nothing about the task, in English and Russian (the languages the site's users write prompts in most).
const STOP = new Set(`
the and for with from that this these those into onto your you are was were have has had will can could should would
please make also then than just some any all not but use using used need needs want get got let lets about what when
where which while there their them they its our out way how why one two new add fix code file files work task tasks
do does did done now here like more most very much only same each every other again still yet into over under after
before because so if it is be been being an as at by in of on or to up we me my i
и в во не что он на я с со как а то все всё она так его но да ты к у же вы за бы по только ее её мне было вот от меня
еще ещё нет о из ему теперь когда даже ну ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом
себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет
ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем
всех никогда можно при об другой хоть после над больше тот через эти нас про всего них какая много разве эту моя
хорошо свою этой перед лучше чуть том нельзя такой им более всегда конечно всю между пожалуйста сделай сделать давай
нужно посмотри проверь давайте пусть это эта`.split(/\s+/).filter(Boolean));

const stem = (word) => (word.length > STEM ? word.slice(0, STEM) : word);

/** The words of a text that may tell what it is about, as stems. */
export function terms(text) {
    const found = new Set();
    for (const word of String(text ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (word.length < 3 || STOP.has(word) || /^\d+$/.test(word)) continue;
        found.add(stem(word));
    }

    return found;
}

/**
 * The rules this prompt is about, the best match first, at most $limit, leaving out the ones in $given (already said
 * in this session). A rule: {id, line, keywords}.
 */
export function matchRules(prompt, rules, given = new Set(), limit = MAX_PER_PROMPT) {
    const asked = terms(prompt);
    if (!asked.size) return [];

    return (rules ?? [])
        .filter((rule) => rule?.id && !given.has(rule.id))
        .map((rule) => {
            const keywords = terms((rule.keywords ?? []).join(' '));
            const own = terms(rule.line);
            let score = 0;
            for (const t of asked) {
                if (keywords.has(t)) score += 2;
                else if (own.has(t)) score += 1;
            }

            return { rule, score };
        })
        .filter(({ score }) => score >= MIN_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ rule }) => rule);
}
