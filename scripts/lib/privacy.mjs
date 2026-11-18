// Generated from the site's resources/js/lib/privacyScan.ts by `npm run plugin:sync`. Do not edit here: change the site's
// file and sync again. test/generated.test.mjs checks this hash of everything below, so an edit here fails the tests.
// sha256:9b8622dddec4eac1f0d017ef273db95f791f3838d6aa8657e507072798d87474

/**
 * The privacy check that runs where the session lives (plan: local-first privacy, stage 2): in the browser before an
 * upload, and in the Claude Code / Codex plugin before a send (keepplain-plugin, scripts/lib/privacy.mjs via
 * `npm run plugin:sync`). A secret is replaced with [REDACTED:TYPE] on the person's machine, so its value never
 * reaches KeepPlain, not even for a check.
 *
 * The rules are App\Services\Import\SecretScanner's, in the same order, run over the same strings the server's
 * TurnParser reads (the string values of each slimmed line). The server runs its own copy again and redacts anything
 * this one missed for good, without keeping the value. Three more rules exist only here: a home folder in a path
 * becomes ~, the user name that folder gave away is redacted as USER_NAME where a listing or git prints it, and the
 * person's own list of words (client names, internal services) is redacted as TERM.
 *
 * "Send it as it is" for a finding is decided here too. Only a SHA-256 of such a value goes to the server, so its
 * scanner leaves the value alone.
 */
/** An id as Claude writes it. On its own it says nothing (a session has one too): ACCOUNT_ID names the places. */
const UUID = '[0-9A-Fa-f]{8}-(?:[0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}(?![0-9A-Fa-f])';
/** Between two parts of a path: a separator, doubled or doubled twice inside JSON, or the dash of a project folder's name. */
const SEP = String.raw `(?:[\\/]{1,4}|-)`;
/**
 * Where an id is the Claude account's or its organization's:
 *   - the desktop app's folders, <account>/<organization> inside: a session it starts runs in
 *     …/Claude/scratch-workspaces/<account>/<organization>/…, so every path and command of it carries both;
 *   - ~/.claude/plugins/synced/<organization>_…, the plugins an organization gives its members;
 *   - named outright: organizationUuid and accountUuid (~/.claude.json, the transcript's own credential_org line),
 *     CLAUDE_CODE_ORGANIZATION_UUID in a printed environment, ?org= in a link the API answers with;
 *   - <account>/<organization>/local_<session>, a listing made inside the app's folder.
 */
const ACCOUNT_PLACE = [
    String.raw `\b(?:scratch-workspaces|local-agent-mode-sessions|claude-code-sessions)${SEP}(?:skills-plugin[\\/]{1,4})?`,
    String.raw `\bplugins[\\/]{1,4}synced[\\/]{1,4}`,
    String.raw `(?:(?:[Oo]rganization|[Aa]ccount)_?(?:[Uu]uid|UUID)|(?:ORGANIZATION|ACCOUNT)_UUID)\\*["']?\s*[:=]\s*\\*["']?`,
    String.raw `\b(?:anthropic\.com|claude\.ai)\/[^\s"'<>]*[?&]org(?:anization)?=`,
    String.raw `(?<![0-9A-Fa-f-])(?=${UUID}[\\/]{1,4}${UUID}[\\/]{1,4}local_)`,
].join('|');
/**
 * In SecretScanner::RULES order: specific token formats first, generic KEY=value assignments last. A token may start at
 * a word's start or right after a JSON string's \n, \r or \t (SecretScanner::B): that n is a letter, so \b alone sees no
 * word start at the token that opens the next line of a file being written.
 *
 * No rule may read one long run of characters again from each of its places: that costs the square of its length. So a
 * JWT and a host name start once, where their run does (SecretScanner::START); a private key runs to the next BEGIN or
 * END marker and no further; a variable's name, a URL's scheme and an OpenAI key up to its T3BlbkFJ have a length limit.
 */
const RULES = [
    // A key cut before its END (a tool's output keeps its first lines only) is one too: the lines of base64 after BEGIN go,
    // with what a diff or a numbered listing puts before each (a sign, cat -n's or grep -n's line number).
    { type: 'PRIVATE_KEY', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:(?:[^-]|-(?!----(?:BEGIN|END) ))*-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|(?:(?:\s|\\+[nr])+(?:[-+>]|\d+(?:→|[:|])|[^\s:\\]{1,60}:\d+[:-])?[ \t]*)?[A-Za-z0-9/+=]{40,}(?:(?:\s|\\+[nr])+(?:[-+>]|\d+(?:→|[:|])|[^\s:\\]{1,60}:\d+[:-])?[ \t]*[A-Za-z0-9/+=]{16,})*)/g },
    { type: 'ANTHROPIC_KEY', pattern: /(?:\b|(?<=\\[nrt]))sk-ant-(?:api|admin|oat)\d{0,2}-?[A-Za-z0-9_-]{20,}/g },
    { type: 'OPENAI_KEY', pattern: /(?:\b|(?<=\\[nrt]))sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,200}T3BlbkFJ[A-Za-z0-9_-]{20,}|(?:\b|(?<=\\[nrt]))sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|(?:\b|(?<=\\[nrt]))sk-[A-Za-z0-9]{48}\b/g },
    { type: 'STRIPE_KEY', pattern: /(?:\b|(?<=\\[nrt]))(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b|(?:\b|(?<=\\[nrt]))whsec_[0-9A-Za-z]{24,}\b/g },
    { type: 'GITHUB_TOKEN', pattern: /(?:\b|(?<=\\[nrt]))(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|(?:\b|(?<=\\[nrt]))github_pat_[A-Za-z0-9_]{50,}\b/g },
    { type: 'AWS_ACCESS_KEY', pattern: /(?:\b|(?<=\\[nrt]))(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
    // (?i:aws) in PHP: spelled out, Node 20 has no inline modifiers.
    { type: 'AWS_SECRET_KEY', pattern: /[Aa][Ww][Ss][\w\-.]{0,24}(?:[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee])[\w\-.]{0,24}[\\"'\s]*[:=]\s*(?:\\*["'])?([A-Za-z0-9/+]{40})(?![\w/+])/g, group: 1 },
    { type: 'GCP_API_KEY', pattern: /(?:\b|(?<=\\[nrt]))AIza[0-9A-Za-z\-_]{35}\b/g },
    { type: 'SLACK_TOKEN', pattern: /(?:\b|(?<=\\[nrt]))xox[abposr]-[A-Za-z0-9-]{10,}\b|https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
    { type: 'SENDGRID_KEY', pattern: /(?:\b|(?<=\\[nrt]))SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
    { type: 'NPM_TOKEN', pattern: /(?:\b|(?<=\\[nrt]))npm_[A-Za-z0-9]{36}\b/g },
    { type: 'KEEPPLAIN_TOKEN', pattern: /(?:\b|(?<=\\[nrt]))(?:kp|ct)_[A-Za-z0-9]{48}\b/g },
    { type: 'SIGNED_URL', pattern: /\bX-(?:Amz|Goog)-(?:Credential|Signature|Security-Token)=([^\s&"'<>]+)/g, group: 1 },
    { type: 'JWT', pattern: /(?:(?<![A-Za-z0-9_\-.\\])|(?<=\\[nrt]))eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { type: 'DATABASE_URL', pattern: /(?:\b|(?<=\\[nrt]))(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^\s:@/"'[\]]*:[^\s@/"'[\]]+@[^\s"'<>]*[^\s"'<>.,;:)\]]/gi },
    { type: 'URL_PASSWORD', pattern: /(?:\b|(?<=\\[nrt]))[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:@/"'[\]]+:([^\s@/"'[\]]+)@/gi, group: 1 },
    // A tool call's input is a JSON string here: a quote comes escaped (\"), and a value ends at \n, \r or \t as it does at
    // a real line break (or it takes the lines after it, and one "example" among them made the whole of it a
    // placeholder). A doubled backslash is a backslash of the value itself. How long a value must be: MIN_VALUE.
    // Between quotes the value runs to the closing one: a password may have a space, a #, a comma or a semicolon in it,
    // where a value with no quotes ends (a # , ; stays in that one only with more of the value right after it).
    { type: 'SECRET_ASSIGNMENT', pattern: /(?:\b|(?<=\\[nrt]))[A-Z0-9_]{0,64}(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY)[A-Z0-9_]{0,64}(?:\\*["'])?\s*[:=]\s*(?:\\*"([^"\\\s]*(?:(?:[ \t]|\\\\|\\(?=[^\s"\\nrt]))[^"\\\s]*)*)\\?"|\\*'([^'\\\s]*(?:(?:[ \t]|\\\\|\\(?=[^\s'\\nrt]))[^'\\\s]*)*)\\?'|(?:\\*["'])?((?:[^\s"'#,;\\]+|[#,;](?=[^\s"'\\])|\\\\|\\(?=[^\s"'\\nrt]))*))/g, group: [1, 2, 3] },
    // The user part of scheme://user@host is not an address: the first branch takes it whole and it is left as it is.
    // The address starts where PHP's \b[A-Za-z0-9._%+-]+@ starts it, at the first letter, digit or _ of its run, but is
    // tried there only: V8 tried \b at every hyphen and dot of a long run and read the rest of it each time. The look
    // back over the run's first dots and hyphens is made at a letter only, or a page of hyphens is read back from each.
    { type: 'EMAIL', pattern: /(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s@/"']*@)|(?=[A-Za-z0-9_])(?<=(?<![A-Za-z0-9._%+-])[.%+-]*)[A-Za-z0-9_][A-Za-z0-9._%+-]*@(?!(?:example|test|localhost)\.)(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g, severity: 'warning', skip: 1 },
    { type: 'IP_ADDRESS', pattern: /\b(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])\b/g, severity: 'warning' },
    // A company's own network: an address in a URL or after user@, or anything under .corp / .intranet.
    { type: 'INTERNAL_HOST', pattern: /(?<=:\/\/|@)(?:[A-Za-z0-9-]+\.){1,20}(?:internal|corp|intranet|lan|local|localdomain)\b|(?:(?<![A-Za-z0-9_\-.\\])|(?<=\\[nrt]))(?:[A-Za-z0-9-]+\.){1,20}(?:corp|intranet|svc\.cluster\.local)\b/g, severity: 'warning' },
    // The Claude account and its organization, by id: they name the person like an address does. Both when they come
    // as a pair, one after the other in a path.
    { type: 'ACCOUNT_ID', pattern: new RegExp(`(?:${ACCOUNT_PLACE})(${UUID}(?:${SEP}${UUID})?)`, 'g'), group: 1, severity: 'warning' },
];
const IGNORED_VALUES = new Set(['changeme', 'password', 'xxxxxxxx', 'your-secret-here', 'secret', 'null', 'undefined']);
const PLACEHOLDER = /example|placeholder|dummy|x{6,}|\*{4,}|\.{3}|…|^<.*>$/i;
const REFERENCE = /^(?:[$%{(<[]|process\.env|os\.environ|env\(|getenv|config\(|secrets\.)/i;
/** ${VAR:-value}: a reference that holds a value after all, the one used when the variable is not set. */
const DEFAULTED = /^\$\{\w+:?[-=+]([^}]{8,})\}?$/;
const MIN_VALUE = 8;
/** A value with spaces made of words alone is a sentence ("Enter your password"), not a secret. */
const SENTENCE = /^(?=.*\s)[A-Za-z\s.,!?:'-]+$/;
const IGNORED_EMAIL = /^(?:git|[^@]*no-?reply)@|@users\.noreply\./i;
/**
 * A home folder names the person: C:\Users\ann, /Users/ann, /home/ann become ~, and each counts in `paths`. Only
 * here: the server has no such rule, a session that came without this check keeps its paths as they are.
 *
 *   - Backslashes in any number: a path inside JSON has them doubled, JSON quoted inside JSON doubled again.
 *   - After a drive Users is read in any case, and the drive goes with it: c:\users\ann, and what Git Bash and WSL
 *     make of it, /c/Users/ann and /mnt/c/users/ann. Without a drive the case is exact: /users/42 is a route.
 *   - Folder names that are nobody's (Public, Shared, the CI runner, the stand-ins of documentation) stay.
 *
 * The name such a folder gave away is remembered for the session (`names`). With it, the same folder is found where
 * the pattern alone would not dare: Users\ann with nothing in front, \users\ann in any case. Never /users/ann,
 * which is a route or a link even when the name is the person's.
 */
const DRIVE = String.raw `\b[A-Za-z]:|(?<![\w.~-])\/(?:mnt\/)?[A-Za-z](?=\/users\/)`;
const HOME = new RegExp(String.raw `(?:(${DRIVE})(?:\\+|\/)|((?<!\\)\\+|\/)|(?<![A-Za-z0-9_]))(users|home)(\\+|\/)([^\\/\s"'\`:*?<>|]+)`, 'gi');
const NOBODY = new Set(['Public', 'Shared', 'Default', 'public', 'shared', 'default', 'runner', 'you', 'user', 'username', 'me', 'example']);
/**
 * Claude Code names a project's folder after its path, every character that is not a letter or a digit turned into a
 * dash: ~/.claude/projects/C--Users-ann-code-shop, -home-ann-code-shop, -mnt-c-Users-ann-code. The name in it goes like
 * the one in a path: ~-code-shop. A dash may be the name's own (john.smith is john-smith here), so a name already
 * learned from a path is taken whole; otherwise the name is the first part, and only where the folder's name starts:
 * after a drive (C--Users-), or as -home- / -Users- with no letter, digit or dash in front. So my-home-page, --home-dir
 * and a project called users-guide stay.
 */
const DASHED = /((?<![A-Za-z0-9])[A-Za-z]-|(?<![A-Za-z0-9-])-(?:mnt-)?[A-Za-z])?-(users|home)-([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/gi;
/** What a user name looks like: what HOME took for a folder is checked against it before it is remembered. */
const NAME = String.raw `[\p{L}\p{N}_][\p{L}\p{N}_.-]*`;
const IS_NAME = new RegExp(`^${NAME}$`, 'u');
/**
 * The same user name outside a path. Any name in these places is somebody's (a colleague's commit, root's file), so
 * a pattern alone would redact other people: only a name a home folder of this session gave away, or one the caller
 * knows (PrivacyOptions.names), is replaced, and only here, not wherever the word stands, since the name may be a
 * plain word (dev, node, admin).
 *
 *   - `ls -l`: the owner and the group column;
 *   - `ps -ef`, `ps aux`: the name that opens a line of numbers;
 *   - git: the name in front of its address, as in Author: ann <…>, Commit:, a shortlog, Signed-off-by;
 *   - named outright: user.name=ann, USER=ann, USERNAME=ann, LOGNAME=ann.
 *
 * A finding like any other: USER_NAME, a warning, the person may send it as it is (a git author is often public).
 * The server has no twin of this rule: it has no home folders to learn the name from.
 */
const NAME_PLACES = [
    { pattern: /([-dlcbps][-rwxsStT]{9}[+@.]?[ \t]+\d+[ \t]+)(\S+)([ \t]+)(\S+)(?=[ \t])/g, names: [2, 4] },
    { pattern: new RegExp(String.raw `((?:^|[\r\n]|\\n)[ \t]*)(${NAME})(?=[ \t]+\d+[ \t]+\d+(?:\.\d+)?[ \t])`, 'gu'), names: [2] },
    { pattern: new RegExp(String.raw `(?<![\p{L}\p{N}_.-])()(${NAME})(?=[ \t]+<(?:\[REDACTED:EMAIL\]|[^\s<>@]*@[^\s<>]*)>)`, 'gu'), names: [2] },
    { pattern: new RegExp(String.raw `(\buser\.name(?:=|[ \t]+)\\?["']?|\b(?:USER|USERNAME|LOGNAME)=)(${NAME})`, 'gu'), names: [2] },
];
export function placeholder(type) {
    return `[REDACTED:${type}]`;
}
function isPublicIp(ip) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 240)
        return false;
    if (a === 172 && b >= 16 && b <= 31)
        return false;
    if (a === 192 && b === 168)
        return false;
    if (a === 169 && b === 254)
        return false;
    return true;
}
/** The part of a match that is the secret: the match itself, or the default inside ${VAR:-default}. */
function held(type, value) {
    return (type === 'SECRET_ASSIGNMENT' && DEFAULTED.exec(value)?.[1]) || value;
}
function isNotASecret(type, value) {
    if (IGNORED_VALUES.has(value.toLowerCase()) || PLACEHOLDER.test(value))
        return true;
    if (type === 'IP_ADDRESS')
        return !isPublicIp(value);
    if (type === 'EMAIL')
        return IGNORED_EMAIL.test(value);
    // KEY=value shorter than MIN_VALUE is a flag or a word; so is a reference, or a short plain word like ct_wrong.
    if (type === 'SECRET_ASSIGNMENT' && ([...value].length < MIN_VALUE || SENTENCE.test(value)))
        return true;
    if (type === 'SECRET_ASSIGNMENT' || type === 'URL_PASSWORD')
        return REFERENCE.test(value) || (value.length < 16 && /^[a-z_-]+$/.test(value));
    return false;
}
/** Short enough to print into the session that is about to be sent: the kind of key shows, the key does not. */
function preview(value) {
    const v = value.replace(/\s+/g, ' ');
    return v.length <= 16 ? `${v.slice(0, 2)}…` : `${v.slice(0, 4)}…`;
}
/** Whether HOME matched a home folder by its own pattern: Users in any case after a drive, else spelled exactly. */
function isHome(drive, sep, folder) {
    const exact = folder === 'Users' || folder === 'home';
    return drive !== undefined ? exact || folder.toLowerCase() === 'users' : sep !== undefined && exact;
}
/** A name without the punctuation of the sentence around it: "(/home/ann)." names ann, /home/$(whoami) keeps its bracket. */
function bare(name) {
    let own = name;
    while (own !== '') {
        const last = own[own.length - 1];
        const opening = { ')': '(', ']': '[', '}': '{' }[last];
        if (!'.,;!'.includes(last) && (opening === undefined || own.includes(opening)))
            break;
        own = own.slice(0, -1);
    }
    return own === '' ? name : own;
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export class PrivacyScan {
    found = new Map();
    rules;
    keep;
    /** Paths with a home folder turned into ~. */
    paths = 0;
    /** The user names this session's home folders gave away, in lower case; `dashed` as a project folder's name has them. */
    names = new Set();
    dashed = [];
    constructor(options = {}) {
        this.keep = options.keep ?? (() => false);
        for (const name of options.names ?? [])
            this.know(name.trim());
        const terms = (options.terms ?? []).map((t) => t.trim()).filter((t) => t.length >= 2);
        this.rules = terms.length
            ? [
                ...RULES,
                {
                    type: 'TERM',
                    pattern: new RegExp(terms.map((t) => `${/^\w/.test(t) ? '\\b' : ''}${escapeRegExp(t)}${/\w$/.test(t) ? '\\b' : ''}`).join('|'), 'gi'),
                },
            ]
            : RULES;
    }
    /** One string with every finding replaced. */
    text(input) {
        this.learn(input);
        return this.redact(input);
    }
    redact(input) {
        let text = input;
        for (const rule of this.rules) {
            rule.pattern.lastIndex = 0;
            text = text.replace(rule.pattern, (...m) => {
                const whole = m[0];
                if (rule.skip && m[rule.skip] !== undefined)
                    return whole;
                // The capture that holds the secret; where a rule has several ways to read it, the one that matched.
                const captured = [rule.group ?? 0].flat().map((g) => m[g]).find((v) => v) ?? '';
                const value = held(rule.type, captured);
                if (value === '' || value.includes('[REDACTED:') || (rule.type !== 'TERM' && isNotASecret(rule.type, value)))
                    return whole;
                const kept = this.record(rule.type, rule.severity ?? 'secret', value);
                return kept ? whole : whole.split(value).join(placeholder(rule.type));
            });
        }
        return this.home(this.ownName(text));
    }
    /** Remembers the user name of every home folder in the text, so it is known wherever else it stands. */
    learn(text) {
        for (const [, drive, sep, folder, , name] of text.matchAll(HOME))
            if (isHome(drive, sep, folder))
                this.know(bare(name));
    }
    /** A user name, unless it is nobody's or no name at all (/home/$USER, a folder with spaces cut short). */
    know(name) {
        const own = name.toLowerCase();
        if (NOBODY.has(name) || this.names.has(own) || own.length > 64 || !IS_NAME.test(own))
            return;
        this.names.add(own);
        // Longest first: john-smith before john.
        this.dashed = [...this.names].map((n) => n.replace(/[^a-z0-9]/g, '-')).sort((a, b) => b.length - a.length);
    }
    learnIn(input) {
        if (typeof input === 'string')
            this.learn(input);
        else if (Array.isArray(input))
            for (const v of input)
                this.learnIn(v);
        else if (input && typeof input === 'object')
            for (const v of Object.values(input))
                this.learnIn(v);
    }
    /** The learned user name where a listing or git prints it (NAME_PLACES). */
    ownName(input) {
        if (this.names.size === 0)
            return input;
        let text = input;
        for (const place of NAME_PLACES) {
            text = text.replace(place.pattern, (...m) => {
                // The groups of a place make up its whole match; the last two arguments are the offset and the text.
                const parts = m.slice(1, -2);
                let replaced = false;
                for (const i of place.names) {
                    const own = bare(parts[i - 1]);
                    if (!this.names.has(own.toLowerCase()) || this.record('USER_NAME', 'warning', own))
                        continue;
                    parts[i - 1] = placeholder('USER_NAME') + parts[i - 1].slice(own.length);
                    replaced = true;
                }
                return replaced ? parts.join('') : m[0];
            });
        }
        return text;
    }
    /** Home folders, in a path and in the dashed name of a project folder, become ~. */
    home(input) {
        const text = input.replace(HOME, (whole, drive, sep, folder, after, name) => {
            // A word from the person's list that is their user name too: redacted already, nothing left to shorten.
            if (name.startsWith('[REDACTED'))
                return whole;
            const own = bare(name);
            if (isHome(drive, sep, folder)) {
                if (NOBODY.has(own))
                    return whole;
            }
            else if (!this.names.has(own.toLowerCase()) || (after[0] === '/' && folder !== 'Users' && folder !== 'home')) {
                // Not the known name; or users/ann with slashes and not spelled as the folder is: a route, a link.
                return whole;
            }
            this.paths++;
            return `~${name.slice(own.length)}`;
        });
        return text.replace(DASHED, (whole, drive, folder, rest, offset, source) => {
            const lower = rest.toLowerCase();
            const learned = this.dashed.find((n) => lower.startsWith(n) && (lower.length === n.length || lower[n.length] === '-'));
            // Where a project folder's name starts: after a drive, or -home- / -Users- with nothing of a longer name in front.
            const starts = drive !== undefined ? folder.toLowerCase() === 'users' : (folder === 'Users' || folder === 'home') && !/[A-Za-z0-9-]/.test(source[offset - 1] ?? '');
            const first = rest.split('-', 1)[0];
            if (learned === undefined && (!starts || NOBODY.has(first)))
                return whole;
            this.paths++;
            return `~${rest.slice((learned ?? first).length)}`;
        });
    }
    /** Every string inside a JSON value (a slimmed session line), keys left alone. */
    value(input) {
        this.learnIn(input);
        return this.walk(input);
    }
    walk(input) {
        if (typeof input === 'string')
            return this.redact(input);
        if (Array.isArray(input))
            return input.map((v) => this.walk(v));
        if (input && typeof input === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(input))
                out[k] = this.walk(v);
            return out;
        }
        return input;
    }
    /**
     * JSON lines, each scanned; a line that is not JSON is scanned as text. Read twice: first for the home folders, so
     * the user name is known from the first line on, wherever in the session its folder shows up.
     */
    jsonl(text) {
        const lines = text.split('\n');
        const parsed = (line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return undefined;
            }
        };
        for (const line of lines) {
            if (line.trim() === '')
                continue;
            const value = parsed(line);
            if (value === undefined)
                this.learn(line);
            else
                this.learnIn(value);
        }
        return lines
            .map((line) => {
            if (line.trim() === '')
                return line;
            const value = parsed(line);
            return value === undefined ? this.redact(line) : JSON.stringify(this.walk(value));
        })
            .join('\n');
    }
    findings() {
        return [...this.found.values()];
    }
    /** What the server is told: occurrences redacted by type, and the hashes of kept values (hash: SHA-256, hex). */
    summary(keptHashes = []) {
        const found = {};
        for (const f of this.found.values())
            if (!f.kept)
                found[f.type] = (found[f.type] ?? 0) + f.count;
        return { v: 1, found, paths: this.paths, kept: keptHashes };
    }
    record(type, severity, value) {
        const key = `${type}\u0000${value}`;
        let f = this.found.get(key);
        if (!f) {
            f = { n: this.found.size + 1, type, severity, preview: preview(value), count: 0, kept: this.keep(value, type), value };
            this.found.set(key, f);
        }
        f.count++;
        return f.kept;
    }
}
/** Plain words for a report: "GitHub token", "email address". */
export const PRIVACY_LABELS = {
    PRIVATE_KEY: 'private key',
    ANTHROPIC_KEY: 'Anthropic API key',
    OPENAI_KEY: 'OpenAI API key',
    STRIPE_KEY: 'Stripe key',
    GITHUB_TOKEN: 'GitHub token',
    AWS_ACCESS_KEY: 'AWS access key ID',
    AWS_SECRET_KEY: 'AWS secret key',
    GCP_API_KEY: 'Google API key',
    SLACK_TOKEN: 'Slack token',
    SENDGRID_KEY: 'SendGrid key',
    NPM_TOKEN: 'npm token',
    KEEPPLAIN_TOKEN: 'KeepPlain token',
    SIGNED_URL: 'signature of a signed storage link',
    JWT: 'JWT',
    DATABASE_URL: 'connection string with a password',
    URL_PASSWORD: 'password in a URL',
    SECRET_ASSIGNMENT: 'value of a *_TOKEN / *_SECRET variable',
    EMAIL: 'email address',
    IP_ADDRESS: 'public IP address',
    INTERNAL_HOST: 'internal hostname',
    ACCOUNT_ID: 'Claude account or organization id',
    USER_NAME: 'user name on this computer',
    TERM: 'word from your list',
};
