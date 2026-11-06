/**
 * The stacks a repository is on (KeepPlain plan: personal rules, stage 37), from its manifests: composer.json,
 * package.json, pyproject.toml and the like, at its root and one folder down (a monorepo's apps). Read here, on the
 * person's computer; only the stacks' names go to the site, to ask for the rules of those stacks.
 *
 * Names are the site's stack slugs (config/stacks.php), the most specific first: a framework before its language,
 * the language before the tools around it. At most MAX_STACKS.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_STACKS = 12;

/** Folders one level down worth a look: not dependencies, builds or hidden ones. */
const SKIP = /^(\.|node_modules$|vendor$|dist$|build$|out$|target$|storage$|public$|coverage$|tmp$|temp$)/;

const SUBFOLDERS = 40;

/** Frameworks first, then libraries, languages, tools. */
const RANK = {
    laravel: 1, symfony: 1, django: 1, flask: 1, fastapi: 1, rails: 1, nextjs: 1, nuxt: 1, sveltekit: 1, remix: 1, astro: 1, angular: 1, spring: 1, flutter: 1, 'react-native': 1, electron: 1,
    vue: 2, react: 2, svelte: 2, inertia: 2, livewire: 2, alpinejs: 2, prisma: 2, graphql: 2, supabase: 2, firebase: 2, stripe: 2, swiftui: 2,
    php: 3, python: 3, ruby: 3, go: 3, rust: 3, java: 3, kotlin: 3, dotnet: 3, csharp: 3, dart: 3, swift: 3, typescript: 3, javascript: 3, nodejs: 3, deno: 3, bun: 3,
};
const rank = (slug) => RANK[slug] ?? 4;

const readJson = (path) => {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
};
const readText = (path) => {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return '';
    }
};

/** Stacks of one folder's manifests, as a Set. */
export function folderStacks(dir) {
    const found = new Set();
    const add = (...slugs) => slugs.forEach((s) => found.add(s));
    const has = (name) => existsSync(join(dir, name));

    const composer = readJson(join(dir, 'composer.json'));
    if (composer) {
        add('php');
        const deps = { ...composer.require, ...composer['require-dev'] };
        if (deps['laravel/framework']) add('laravel');
        if (deps['symfony/framework-bundle'] || deps['symfony/symfony']) add('symfony');
        if (deps['livewire/livewire']) add('livewire');
        if (deps['inertiajs/inertia-laravel']) add('inertia');
        if (deps['stripe/stripe-php'] || deps['laravel/cashier']) add('stripe');
    }

    const pkg = readJson(join(dir, 'package.json'));
    if (pkg) {
        const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
        const any = (...names) => names.some((n) => deps[n] !== undefined);
        const scoped = (scope) => Object.keys(deps).some((n) => n.startsWith(scope));
        if (any('next')) add('nextjs');
        if (any('nuxt')) add('nuxt');
        if (any('@sveltejs/kit')) add('sveltekit');
        if (any('astro')) add('astro');
        if (scoped('@remix-run/')) add('remix');
        if (any('@angular/core')) add('angular');
        if (any('react-native')) add('react-native');
        if (any('electron')) add('electron');
        if (any('react')) add('react');
        if (any('vue')) add('vue');
        if (any('svelte')) add('svelte');
        if (scoped('@inertiajs/')) add('inertia');
        if (any('alpinejs')) add('alpinejs');
        if (any('prisma', '@prisma/client')) add('prisma');
        if (any('graphql')) add('graphql');
        if (any('@supabase/supabase-js')) add('supabase');
        if (any('firebase', 'firebase-admin')) add('firebase');
        if (any('stripe', '@stripe/stripe-js')) add('stripe');
        if (any('vite')) add('vite');
        if (any('tailwindcss')) add('tailwind');
        if (any('@playwright/test', 'playwright')) add('playwright');
        if (any('vitest')) add('vitest');
        if (any('jest')) add('jest');
        if (any('express', 'fastify', '@nestjs/core', 'koa', 'hono')) add('nodejs');
        add(any('typescript') || has('tsconfig.json') ? 'typescript' : 'javascript');
    } else if (has('tsconfig.json')) {
        add('typescript');
    }
    if (has('deno.json') || has('deno.jsonc')) add('deno');
    if (has('bun.lockb') || has('bun.lock')) add('bun');

    const python = ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt', 'Pipfile', 'setup.py'].map((f) => readText(join(dir, f))).join('\n');
    if (python.trim() || has('setup.cfg')) {
        add('python');
        const lower = python.toLowerCase();
        const dep = (name) => new RegExp(`(^|[\\s"'\\[,])${name}([\\s"'=<>~!\\[,;]|$)`, 'm').test(lower);
        if (dep('django')) add('django');
        if (dep('flask')) add('flask');
        if (dep('fastapi')) add('fastapi');
        if (dep('pytest')) add('pytest');
        if (dep('pandas')) add('pandas');
        if (dep('torch')) add('pytorch');
    }

    const gemfile = readText(join(dir, 'Gemfile'));
    if (gemfile) {
        add('ruby');
        if (/^\s*gem\s+["']rails["']/m.test(gemfile)) add('rails');
    }
    if (has('go.mod')) add('go');
    if (has('Cargo.toml')) add('rust');

    const gradle = readText(join(dir, 'build.gradle')) + readText(join(dir, 'build.gradle.kts'));
    const pom = readText(join(dir, 'pom.xml'));
    if (gradle || pom) {
        add(has('build.gradle.kts') || /kotlin/i.test(gradle + pom) ? 'kotlin' : 'java');
        if (/spring-boot|org\.springframework/i.test(gradle + pom)) add('spring');
    }
    let entries = [];
    try {
        entries = readdirSync(dir);
    } catch {
        // An unreadable folder has no manifests.
    }
    if (entries.some((f) => /\.(csproj|sln|fsproj)$/i.test(f))) add('dotnet', ...(entries.some((f) => /\.(csproj|sln)$/i.test(f)) ? ['csharp'] : []));
    const pubspec = readText(join(dir, 'pubspec.yaml'));
    if (pubspec) add('dart', ...(/^\s*flutter\s*:/m.test(pubspec) ? ['flutter'] : []));
    if (has('Package.swift')) add('swift');

    if (has('Dockerfile') || entries.some((f) => /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(f))) add('docker');
    if (existsSync(join(dir, '.github', 'workflows'))) add('github-actions');
    if (entries.some((f) => /\.tf$/i.test(f))) add('terraform');

    return found;
}

/** The repository's stacks: its root's and its subfolders', the most specific first. */
export function detectStacks(root) {
    if (!root) return [];
    const found = folderStacks(root);
    let dirs = [];
    try {
        dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !SKIP.test(d.name)).slice(0, SUBFOLDERS);
    } catch {
        return [];
    }
    for (const d of dirs) {
        try {
            if (statSync(join(root, d.name)).isDirectory()) folderStacks(join(root, d.name)).forEach((s) => found.add(s));
        } catch {
            // A folder that went away while being read.
        }
    }
    // A JavaScript guess loses to TypeScript found elsewhere in the repository.
    if (found.has('typescript')) found.delete('javascript');

    return [...found].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, MAX_STACKS);
}
