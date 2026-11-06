/**
 * Windows' manual Internet Settings proxy, also used by VPN clients.
 * Read on each request so a running hook worker notices VPN changes.
 * PAC/WPAD are handled only by the desktop's Chromium resolver.
 */
import { execFile } from 'node:child_process';
import { win32 } from 'node:path';

const SETTINGS = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const POLICY = 'HKLM\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

export function parseRegistry(text) {
    const values = {};
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*(ProxyEnable|ProxyServer|ProxyOverride|ProxySettingsPerUser)\s+REG_(DWORD|SZ)\s+(.*?)\s*$/i);
        if (match) values[match[1].toLowerCase()] = match[2].toUpperCase() === 'DWORD' ? Number(match[3]) : match[3];
    }
    return values;
}

export async function readWindowsProxy({ signal } = {}) {
    const executable = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const query = (key) => new Promise((resolve, reject) => {
        execFile(executable, ['query', key], { windowsHide: true, encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024, signal }, (error, stdout) => {
            if (signal?.aborted) return reject(signal.reason);
            // A missing or inaccessible settings key means no manual configuration.
            resolve(error ? {} : parseRegistry(stdout));
        });
    });
    const policy = await query(POLICY);
    return query((policy.proxysettingsperuser === 0 ? 'HKLM\\' : 'HKCU\\') + SETTINGS);
}

function excluded(url, rules) {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)) return true;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return String(rules || '').split(';').some((entry) => {
        entry = entry.trim().toLowerCase();
        if (!entry) return false;
        if (entry === '<local>') return !host.includes('.') && !host.includes(':');
        const pattern = entry.replace(/[.+?^\x24{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        const regex = new RegExp('^' + pattern + '$');
        return regex.test(host) || regex.test(url.hostname.toLowerCase() + ':' + port);
    });
}

export function windowsProxyFromSettings(target, settings) {
    const url = new URL(target);
    if (settings.proxyenable !== 1 || excluded(url, settings.proxyoverride)) return null;
    const raw = String(settings.proxyserver || '').trim();
    if (!raw) return null;
    let address = raw;
    let scheme = 'http';
    if (/^\w+\s*=/.test(raw)) {
        const entries = {};
        for (const entry of raw.split(';')) {
            const match = entry.trim().match(/^(\w+)\s*=\s*(.+)$/);
            if (match) entries[match[1].toLowerCase()] = match[2].trim();
        }
        address = entries[url.protocol.slice(0, -1)];
        if (!address) { address = entries.socks; scheme = 'socks5'; }
        if (!address) return null;
    }
    try {
        const proxy = new URL(address.includes('://') ? address : scheme + '://' + address);
        return ['http:', 'https:', 'socks:', 'socks5:', 'socks5h:'].includes(proxy.protocol) ? proxy : null;
    } catch {
        return null;
    }
}

export async function windowsProxyFor(target, { platform = process.platform, readSettings = readWindowsProxy, signal } = {}) {
    if (platform !== 'win32') return null;
    signal?.throwIfAborted();
    const settings = await readSettings({ signal });
    signal?.throwIfAborted();
    return windowsProxyFromSettings(target, settings);
}
