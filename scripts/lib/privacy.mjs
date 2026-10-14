// Generated from the site's resources/js/lib/privacyScan.ts by `npm run plugin:sync`. Do not edit here: change the site's
// file and sync again. test/generated.test.mjs checks this hash of everything below, so an edit here fails the tests.
// sha256:6c21ebe3c68bb9dc2fcd2e139ed0e48e454ec56c9d0c201888204aa3c200d60f

/**
 * The privacy check that runs where the session lives (plan: local-first privacy, stage 2): in the browser before an
 * upload, and in the Claude Code / Codex plugin before a send (keepplain-plugin, scripts/lib/privacy.mjs via
 * `npm run plugin:sync`). A secret is replaced with [REDACTED:TYPE] on the person's machine, so its value never
 * reaches KeepPlain, not even for a check.
 *
 * The rules are App\Services\Import\SecretScanner's, in the same order, run over the same strings the server's
 * TurnParser reads (the string values of each slimmed line). The server runs its own copy again and redacts anything
 * this one missed for good, without keeping the value. Two more rules exist only here: a home folder in a path
 * becomes ~, and the person's own list of words (client names, internal services) is redacted as TERM.
 *
 * "Send it as it is" for a finding is decided here too. Only a SHA-256 of such a value goes to the server, so its
 * scanner leaves the value alone.
 */
/** In SecretScanner::RULES order: specific token formats first, generic KEY=value assignments last. */
const RULES = [
    { type: 'PRIVATE_KEY', pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
    { type: 'ANTHROPIC_KEY', pattern: /\bsk-ant-(?:api|admin|oat)\d{0,2}-?[A-Za-z0-9_-]{20,}/g },
    { type: 'OPENAI_KEY', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|\bsk-[A-Za-z0-9]{48}\b/g },
    { type: 'STRIPE_KEY', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b|\bwhsec_[0-9A-Za-z]{24,}\b/g },
    { type: 'GITHUB_TOKEN', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/g },
    { type: 'AWS_ACCESS_KEY', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
    // (?i:aws) in PHP: spelled out, Node 20 has no inline modifiers.
    { type: 'AWS_SECRET_KEY', pattern: /[Aa][Ww][Ss][\w\-.]{0,24}(?:[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Rr][Ii][Vv][Aa][Tt][Ee])[\w\-.]{0,24}["'\s]*[:=]\s*["']?([A-Za-z0-9/+]{40})\b/g, group: 1 },
    { type: 'GCP_API_KEY', pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
    { type: 'SLACK_TOKEN', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b|https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
    { type: 'SENDGRID_KEY', pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
    { type: 'NPM_TOKEN', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
    { type: 'KEEPPLAIN_TOKEN', pattern: /\b(?:kp|ct)_[A-Za-z0-9]{48}\b/g },
    { type: 'SIGNED_URL', pattern: /\bX-(?:Amz|Goog)-(?:Credential|Signature|Security-Token)=([^\s&"'<>]+)/g, group: 1 },
    { type: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
    { type: 'DATABASE_URL', pattern: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/[^\s:@/"'[\]]*:[^\s@/"'[\]]+@[^\s"'<>]*[^\s"'<>.,;:)\]]/gi },
    { type: 'URL_PASSWORD', pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'[\]]+:([^\s@/"'[\]]+)@/gi, group: 1 },
    { type: 'SECRET_ASSIGNMENT', pattern: /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|AUTH_KEY)[A-Z0-9_]*["']?\s*[:=]\s*["']?([^\s"'#,;]{8,})/g, group: 1 },
    // The user part of scheme://user@host is not an address: the first branch takes it whole and it is left as it is.
    { type: 'EMAIL', pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s@/"']*@)|\b[A-Za-z0-9._%+-]+@(?!(?:example|test|localhost)\.)(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g, severity: 'warning', skip: 1 },
    { type: 'IP_ADDRESS', pattern: /\b(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])\b/g, severity: 'warning' },
    // A company's own network: an address in a URL or after user@, or anything under .corp / .intranet.
    { type: 'INTERNAL_HOST', pattern: /(?<=:\/\/|@)(?:[A-Za-z0-9-]+\.)+(?:internal|corp|intranet|lan|local|localdomain)\b|\b(?:[A-Za-z0-9-]+\.)+(?:corp|intranet|svc\.cluster\.local)\b/g, severity: 'warning' },
];
const IGNORED_VALUES = new Set(['changeme', 'password', 'xxxxxxxx', 'your-secret-here', 'secret', 'null', 'undefined']);
const PLACEHOLDER = /example|placeholder|dummy|x{6,}|\*{4,}|\.{3}|…|^<.*>$/i;
const REFERENCE = /^(?:[$%{(<[]|process\.env|os\.environ|env\(|getenv|config\(|secrets\.)/i;
const IGNORED_EMAIL = /^(?:git|[^@]*no-?reply)@|@users\.noreply\./i;
/**
 * A home folder names the person: C:\Users\ann, /Users/ann, /home/ann become ~. Doubled backslashes are JSON inside a
 * string. Folder names that are nobody's (Public, Shared, the CI runner) stay.
 */
const HOME = /(?:\b[A-Za-z]:)?(?:\\{1,2}|\/)(?:Users|home)(?:\\{1,2}|\/)(?!(?:Public|Shared|Default|runner|you|user|username|me|example)(?:[\\/"'\s]|$))[^\\/\s"'`:*?<>|]+/g;
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
function isNotASecret(type, value) {
    if (IGNORED_VALUES.has(value.toLowerCase()) || PLACEHOLDER.test(value))
        return true;
    if (type === 'IP_ADDRESS')
        return !isPublicIp(value);
    if (type === 'EMAIL')
        return IGNORED_EMAIL.test(value);
    if (type === 'SECRET_ASSIGNMENT' || type === 'URL_PASSWORD')
        return REFERENCE.test(value) || (value.length < 16 && /^[a-z_-]+$/.test(value));
    return false;
}
/** Short enough to print into the session that is about to be sent: the kind of key shows, the key does not. */
function preview(value) {
    const v = value.replace(/\s+/g, ' ');
    return v.length <= 16 ? `${v.slice(0, 2)}…` : `${v.slice(0, 4)}…`;
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
    constructor(options = {}) {
        this.keep = options.keep ?? (() => false);
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
        let text = input;
        for (const rule of this.rules) {
            rule.pattern.lastIndex = 0;
            text = text.replace(rule.pattern, (...m) => {
                const whole = m[0];
                if (rule.skip && m[rule.skip] !== undefined)
                    return whole;
                const value = m[rule.group ?? 0] ?? '';
                if (value === '' || value.includes('[REDACTED:') || (rule.type !== 'TERM' && isNotASecret(rule.type, value)))
                    return whole;
                const kept = this.record(rule, value);
                return kept ? whole : whole.split(value).join(placeholder(rule.type));
            });
        }
        return text.replace(HOME, () => {
            this.paths++;
            return '~';
        });
    }
    /** Every string inside a JSON value (a slimmed session line), keys left alone. */
    value(input) {
        if (typeof input === 'string')
            return this.text(input);
        if (Array.isArray(input))
            return input.map((v) => this.value(v));
        if (input && typeof input === 'object') {
            const out = {};
            for (const [k, v] of Object.entries(input))
                out[k] = this.value(v);
            return out;
        }
        return input;
    }
    /** JSON lines, each scanned; a line that is not JSON is scanned as text. */
    jsonl(text) {
        return text
            .split('\n')
            .map((line) => {
            if (line.trim() === '')
                return line;
            try {
                return JSON.stringify(this.value(JSON.parse(line)));
            }
            catch {
                return this.text(line);
            }
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
    record(rule, value) {
        const key = `${rule.type}\u0000${value}`;
        let f = this.found.get(key);
        if (!f) {
            f = { n: this.found.size + 1, type: rule.type, severity: rule.severity ?? 'secret', preview: preview(value), count: 0, kept: this.keep(value, rule.type), value };
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
    TERM: 'word from your list',
};
