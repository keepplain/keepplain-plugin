/**
 * Requests to the site, through the proxy the environment names. Node's fetch ignores HTTPS_PROXY (before 22.21 and
 * 24, and after them unless NODE_USE_ENV_PROXY is set), and some networks only let a large upload through a proxy:
 * a direct connection to the site is reset after the first 16 KB. So with a proxy set, the request goes through an
 * HTTP CONNECT tunnel built here on node:http and node:tls, with no dependencies, and comes back as a Response.
 *
 * HTTPS_PROXY for https:// sites, HTTP_PROXY for http:// ones, ALL_PROXY for both; lower-case names too. NO_PROXY
 * lists hosts that go direct: "*", a host, ".domain" or "domain" (with its subdomains), an optional ":port".
 * http://, https:// and SOCKS5 proxies (socks5://, socks5h://, socks://: the VPN clients that set a system proxy offer
 * one or the other). Through SOCKS5 the site's name goes to the proxy, which resolves it, as socks5h does; a socks4://
 * one is left alone and the request goes direct.
 *
 * A proxy that looks inside TLS (Claude Code on the web runs every session behind one) signs the site's certificate
 * with its own CA. The tunnel trusts it when the environment names its file the way other tools read it
 * (SSL_CERT_FILE, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE), when it is in the system store, or at ~/.ccr/ca-bundle.crt,
 * where Claude Code on the web keeps it.
 */
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net, { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { windowsProxyFor } from './windows-proxy.mjs';

const SOCKS = ['socks:', 'socks5:', 'socks5h:'];
const isSocks = (proxy) => SOCKS.includes(proxy.protocol);

/** The proxy for a URL as a URL, or null for a direct connection. */
export function proxyFor(target, env = process.env) {
    const url = new URL(target);
    const variable = (name) => env[name.toLowerCase()] || env[name] || '';
    const raw = (url.protocol === 'https:' ? variable('HTTPS_PROXY') : variable('HTTP_PROXY')) || variable('ALL_PROXY');
    if (!raw.trim() || bypassed(url, variable('NO_PROXY'))) return null;

    let proxy;
    try {
        proxy = new URL(raw.includes('://') ? raw.trim() : `http://${raw.trim()}`);
    } catch {
        return null;
    }

    return ['http:', 'https:', ...SOCKS].includes(proxy.protocol) ? proxy : null;
}

/** fetch(), through an environment proxy or Windows' manual system proxy. */
export async function request(target, { method = 'GET', headers = {}, body, signal } = {}, { env = process.env, ca, systemProxy = windowsProxyFor } = {}) {
    const explicit = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'].some((name) => env[name] || env[name.toLowerCase()]);
    const proxy = explicit || bypassed(new URL(target), env.no_proxy || env.NO_PROXY || '')
        ? proxyFor(target, env)
        : await systemProxy(target, { signal });
    if (!proxy) return fetch(target, { method, headers, body, signal });

    try {
        return await throughProxy(new URL(target), proxy, { method, headers, body, signal }, ca ?? trusted(env));
    } catch (e) {
        if (e.name === 'AbortError' || e.name === 'TimeoutError') throw e;
        // No credentials in the message: only the proxy's host and port. The code and status stay for callers.
        throw Object.assign(new Error(`${e.message} (through the proxy ${proxy.host})`), { code: e.code, status: e.status });
    }
}

/**
 * What the tunnel trusts: Node's own CAs (NODE_EXTRA_CA_CERTS included) plus the system store and the files named
 * above, or undefined, Node's defaults, when there is nothing to add. Passing `ca` replaces Node's list, so it
 * goes in too.
 */
export function trusted(env = process.env, home = homedir()) {
    const key = JSON.stringify([env.SSL_CERT_FILE, env.REQUESTS_CA_BUNDLE, env.CURL_CA_BUNDLE, env.NODE_EXTRA_CA_CERTS, home]);
    if (!trustedCache.has(key)) trustedCache.set(key, readTrusted(env, home));

    return trustedCache.get(key);
}

// Read once per process: the system store can hold hundreds of certificates.
const trustedCache = new Map();

function readTrusted(env, home) {
    const read = (file) => {
        try {
            return file && existsSync(file) ? [readFileSync(file, 'utf8')] : [];
        } catch {
            return [];
        }
    };
    const files = [...new Set([env.SSL_CERT_FILE, env.REQUESTS_CA_BUNDLE, env.CURL_CA_BUNDLE, join(home, '.ccr', 'ca-bundle.crt')])].flatMap(read);
    let system = [];
    try {
        // Node 22.15 and 23.10 on; older ones cannot read it.
        system = tls.getCACertificates?.('system') ?? [];
    } catch {
        // No system store to read here.
    }
    if (!files.length && !system.length) return undefined;

    return [...tls.rootCertificates, ...system, ...read(env.NODE_EXTRA_CA_CERTS), ...files];
}

async function throughProxy(url, proxy, { method, headers, body, signal }, ca) {
    // Request serialises the body the way fetch would: FormData becomes multipart with its boundary.
    const prepared = new Request(url, { method, headers, body });
    const payload = body == null ? null : Buffer.from(await prepared.arrayBuffer());
    const sent = Object.fromEntries(prepared.headers);
    sent.host = url.host;
    if (payload) sent['content-length'] = String(payload.length);

    let options;
    if (isSocks(proxy)) {
        // The SOCKS proxy hands over a socket to the site itself: TLS on it for https, the plain request for http.
        const socket = await socksTunnel(proxy, url, signal);
        const servername = isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname;
        // The socket comes paused, so nothing is lost before the request reads it; http does not resume it by itself.
        const connection = url.protocol === 'https:' ? () => tls.connect({ socket, servername, ca }) : () => socket.resume();
        options = { host: url.hostname, port: url.port || defaultPort(url), path: url.pathname + url.search, createConnection: connection };
    } else if (url.protocol === 'https:') {
        const socket = await tunnel(proxy, url, signal);
        const servername = isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname;
        options = { host: url.hostname, port: url.port || 443, path: url.pathname + url.search, createConnection: () => tls.connect({ socket, servername, ca }) };
    } else {
        // A plain http:// site: the proxy takes the whole URL as the path.
        Object.assign(sent, authorization(proxy));
        options = { host: proxy.hostname, port: proxy.port || defaultPort(proxy), path: url.href, agent: false };
    }

    const transport = url.protocol === 'https:' ? https : !isSocks(proxy) && proxy.protocol === 'https:' ? https : http;
    const response = await new Promise((resolve, reject) => {
        const req = transport.request({ ...options, method, headers: sent, signal }, resolve);
        req.on('error', reject);
        req.end(payload ?? undefined);
    });

    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    const received = new Headers();
    for (const [name, value] of Object.entries(response.headers)) received.set(name, Array.isArray(value) ? value.join(', ') : String(value));
    const empty = [204, 205, 304].includes(response.statusCode) || method === 'HEAD';

    return new Response(empty ? null : Buffer.concat(chunks), { status: response.statusCode, statusText: response.statusMessage ?? '', headers: received });
}

/** A socket to the site through the proxy, once it has answered CONNECT with 200. */
function tunnel(proxy, url, signal) {
    const authority = `${url.hostname}:${url.port || 443}`;

    return new Promise((resolve, reject) => {
        const req = (proxy.protocol === 'https:' ? https : http).request({
            host: proxy.hostname,
            port: proxy.port || defaultPort(proxy),
            method: 'CONNECT',
            path: authority,
            headers: { host: authority, ...authorization(proxy) },
            agent: false,
            signal,
        });
        req.on('connect', (response, socket) => {
            if (response.statusCode === 200) return resolve(socket);
            socket.destroy();
            reject(Object.assign(new Error(`the proxy answered ${response.statusCode} to CONNECT ${authority}`), { code: 'EPROXYREFUSED', status: response.statusCode }));
        });
        req.on('error', reject);
        req.end();
    });
}

const SOCKS_REPLIES = { 1: 'a general failure', 2: 'not allowed by its rules', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported' };

/**
 * A socket to the site through a SOCKS5 proxy (RFC 1928), with the username and password of the proxy's URL when it has
 * them (RFC 1929). The site goes by its name, for the proxy to resolve.
 */
function socksTunnel(proxy, url, signal) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const port = Number(url.port || defaultPort(url));
    const authority = `${host}:${port}`;

    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port || 1080) });
        let buffer = Buffer.alloc(0);
        let waiting = null;
        const fail = (e) => {
            socket.destroy();
            reject(e);
        };
        const refused = (reason) => fail(Object.assign(new Error(`the SOCKS proxy refused ${authority}: ${reason}`), { code: 'EPROXYREFUSED', status: reason }));
        const pump = () => {
            if (!waiting || buffer.length < waiting.n) return;
            const { n, done } = waiting;
            waiting = null;
            const out = buffer.subarray(0, n);
            buffer = buffer.subarray(n);
            done(out);
        };
        const take = (n) => new Promise((done) => {
            waiting = { n, done };
            pump();
        });
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            pump();
        };
        const onAbort = () => fail(signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' }));
        socket.on('data', onData);
        socket.on('error', fail);
        const onClose = () => fail(new Error(`the SOCKS proxy closed the connection to ${authority}`));
        socket.on('close', onClose);
        signal?.addEventListener('abort', onAbort, { once: true });

        socket.once('connect', async () => {
            const user = proxy.username ? Buffer.from(decodeURIComponent(proxy.username)) : null;
            const password = Buffer.from(decodeURIComponent(proxy.password ?? ''));
            socket.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]));
            const [, method] = await take(2);
            if (method === 2 && user) {
                socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([password.length]), password]));
                const [, status] = await take(2);
                if (status !== 0) return refused('wrong username or password');
            } else if (method !== 0) return refused(user ? 'it accepts none of the sign-ins offered' : 'it wants a username and password');

            const name = Buffer.from(host);
            const address = net.isIPv4(host)
                ? Buffer.from([1, ...host.split('.').map(Number)])
                : Buffer.concat([Buffer.from([3, name.length]), name]);
            socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 255])]));
            const [, reply, , type] = await take(4);
            if (reply !== 0) return refused(SOCKS_REPLIES[reply] ?? `reply ${reply}`);
            const length = type === 1 ? 4 : type === 4 ? 16 : (await take(1))[0];
            await take(length + 2);

            // The handshake is over: the socket is the site's from here on, with whatever came after the reply.
            socket.removeListener('data', onData);
            socket.removeListener('close', onClose);
            socket.removeListener('error', fail);
            signal?.removeEventListener('abort', onAbort);
            socket.pause();
            if (buffer.length) socket.unshift(buffer);
            resolve(socket);
        });
    });
}

function authorization(proxy) {
    if (!proxy.username) return {};
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;

    return { 'proxy-authorization': `Basic ${Buffer.from(credentials).toString('base64')}` };
}

function defaultPort(url) {
    return url.protocol === 'https:' ? 443 : 80;
}

function bypassed(url, noProxy) {
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = url.port || String(defaultPort(url));

    return noProxy.split(/[\s,]+/).filter(Boolean).some((entry) => {
        if (entry === '*') return true;
        let [name, entryPort] = [entry.toLowerCase(), null];
        const bracketed = name.match(/^\[([^\]]+)\](?::(\d+))?$/);
        if (bracketed) [name, entryPort] = [bracketed[1], bracketed[2] ?? null];
        else if (name.split(':').length === 2) [name, entryPort] = name.split(':');
        if (entryPort && entryPort !== port) return false;
        name = name.replace(/^\*/, '');
        if (name.startsWith('.')) return host.endsWith(name) || host === name.slice(1);

        return host === name || host.endsWith(`.${name}`);
    });
}
