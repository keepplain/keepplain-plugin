/**
 * The plugin's own options as Claude Code saved them (settings.json → pluginConfigs["keepplain@<marketplace>"]).
 * Read here directly: ${user_config.*} placeholders in skills are not expanded everywhere (the desktop app left
 * them as they were), and the CLAUDE_PLUGIN_OPTION_* variables did not reach commands the model runs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './session.mjs';

const isUrl = (value) => typeof value === 'string' && /^https?:\/\/[^\s$]+$/.test(value);

/**
 * The KeepPlain site: --site for scripts and tests, then the environment, then the plugin's "url" option as
 * Claude Code saved it. That option belongs to the Claude Code plugin: in Codex it would silently point at whatever
 * was set there. An unexpanded ${user_config.url} placeholder is not an address.
 */
export function siteUrl(explicit = null, codex = false, env = process.env) {
    return [explicit, env.KEEPPLAIN_URL, codex ? null : pluginOption('url'), 'https://keepplain.com'].find(isUrl).replace(/\/+$/, '');
}

export function pluginOption(name, dir = configDir()) {
    let settings;
    try {
        settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    } catch {
        return null;
    }
    for (const [id, config] of Object.entries(settings?.pluginConfigs ?? {})) {
        if (id.startsWith('keepplain@') && typeof config?.options?.[name] === 'string' && config.options[name].trim() !== '') {
            return config.options[name].trim();
        }
    }

    return null;
}
