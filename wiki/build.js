// Static wiki builder. No dependencies. `node wiki/build.js` writes wiki/dist.
// Pages are HTML fragments in wiki/content; the shell, nav, and search index
// are generated so a new page cannot forget the navigation.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = 'https://wiki.edgeloop.app';

export function stripTags(html) {
    return String(html)
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function slugify(text) {
    const s = stripTags(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return s || 'section';
}

export function decorateHeadings(html) {
    const used = new Set();
    return String(html).replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi, (full, level, attrs, inner) => {
        const explicit = /\bid\s*=\s*"([^"]+)"/i.exec(attrs);
        let id = explicit ? explicit[1] : slugify(inner);
        const base = id;
        let n = 2;
        while (used.has(id)) {
            id = `${base}-${n}`;
            n += 1;
        }
        used.add(id);
        const rest = attrs.replace(/\s*\bid\s*=\s*"[^"]*"/i, '');
        return `<h${level}${rest} id="${id}">${inner}</h${level}>`;
    });
}

export function headingsOf(html) {
    const out = [];
    const re = /<h([23])([^>]*)>([\s\S]*?)<\/h\1>/gi;
    let match;
    while ((match = re.exec(html))) {
        const id = (/\bid\s*=\s*"([^"]+)"/i.exec(match[2]) || [])[1];
        if (!id) continue;
        out.push({ level: Number(match[1]), id, text: stripTags(match[3]) });
    }
    return out;
}

export function pagePath(page) {
    if (page.out) return `/${page.out}`;
    const slug = page.slug ? `${page.slug}/` : '';
    return page.edition ? `/${page.edition}/${slug}` : `/${slug}`;
}

const ASSET_PATHS = new Set(['/icon.svg', '/wiki.css', '/wiki.js', '/search.json']);

export function prefixHrefs(html, editionId, slugs) {
    return String(html).replace(/href="(\/[^"]*)"/g, (full, href) => {
        const hashAt = href.indexOf('#');
        const path = hashAt === -1 ? href : href.slice(0, hashAt);
        const fragment = hashAt === -1 ? '' : href.slice(hashAt);
        if (ASSET_PATHS.has(path) || path.startsWith('/search.json')) return full;
        const normalized = path === '/' ? '/' : (path.endsWith('/') ? path : `${path}/`);
        const parts = normalized.split('/').filter(Boolean);
        if (parts.length > 1) return full;
        const slug = parts[0] || '';
        if (normalized !== '/' && !slugs.has(slug)) return full;
        const next = slug ? `/${editionId}/${slug}/` : `/${editionId}/`;
        return `href="${next}${fragment}"`;
    });
}

function outputFile(page) {
    if (page.out) return page.out;
    const slug = page.slug ? join(page.slug, 'index.html') : 'index.html';
    return page.edition ? join(page.edition, slug) : slug;
}

function renderToc(headings) {
    if (headings.length < 2) return '';
    const items = headings.map((heading) => {
        const cls = heading.level === 3 ? ' class="toc-sub"' : '';
        return `<li${cls}><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`;
    }).join('');
    return `<nav class="toc" aria-label="On this page"><details><summary>On this page</summary><ol>${items}</ol></details></nav>`;
}

function renderNav(pages, current) {
    const groups = [];
    for (const page of pages) {
        if (!page.nav) continue;
        let group = groups.find((item) => item.section === page.section);
        if (!group) {
            group = { section: page.section, pages: [] };
            groups.push(group);
        }
        group.pages.push(page);
    }
    return groups.map((group) => {
        const links = group.pages.map((page) => {
            const currentAttr = page === current ? ' aria-current="page"' : '';
            return `<a href="${pagePath(page)}"${currentAttr}>${escapeHtml(page.nav)}</a>`;
        }).join('');
        return `<p class="nav-label">${escapeHtml(group.section)}</p>${links}`;
    }).join('');
}

function searchRecords(page, html) {
    const path = pagePath(page);
    const chunks = html.split(/(?=<h2[\s>])/i);
    const records = [];
    chunks.forEach((chunk, index) => {
        const heading = headingsOf(chunk)[0];
        const text = stripTags(chunk).toLowerCase();
        if (!text) return;
        if (index === 0) {
            records.push({
                href: path,
                page: page.title,
                heading: page.nav || page.title,
                text: `${page.title} ${page.nav || ''} ${text}`.toLowerCase()
            });
            return;
        }
        if (!heading) return;
        records.push({
            href: `${path}#${heading.id}`,
            page: page.title,
            heading: heading.text,
            text: `${heading.text} ${text}`.toLowerCase()
        });
    });
    return records;
}

function renderEditions(editions, currentId, pageSlug, pathsByEdition) {
    const buttons = editions.map((edition) => {
        const paths = pathsByEdition.get(edition.id);
        const href = paths?.get(pageSlug) || paths?.get('') || `/${edition.id}/`;
        const on = edition.id === currentId;
        const currentAttr = on ? ' aria-current="page"' : '';
        return `<a class="edition" href="${href}"${currentAttr}><span class="edition-dot" aria-hidden="true"></span><span class="edition-copy"><span class="edition-kicker">${escapeHtml(edition.kicker)}</span><span class="edition-name">${escapeHtml(edition.label)}</span></span><span class="edition-meta">${escapeHtml(edition.version)}</span></a>`;
    }).join('');
    return `<nav class="editions" aria-label="Branches">${buttons}</nav>`;
}

function renderPage(page, body, toc, nav, edition, editionsBar) {
    const path = pagePath(page);
    const documentTitle = page.slug === '' ? page.title : `${page.title} — EdgeLoop wiki`;
    const shellClass = toc ? 'shell' : 'shell no-toc';
    const searchPath = edition ? `/${edition.id}/search.json` : '/dev/search.json';
    const home = edition ? `/${edition.id}/` : '/dev/';
    const appLink = edition?.app
        ? `<a class="app-link" href="${escapeHtml(edition.app)}">${escapeHtml(edition.appLabel || 'Open the app')}</a>`
        : '';
    const footer = edition?.footer || 'The session runs in your browser.';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(documentTitle)}</title>
  <meta name="description" content="${escapeHtml(page.description)}">
  <link rel="canonical" href="${SITE}${path}">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <meta name="theme-color" content="#020617">
  <link rel="stylesheet" href="/wiki.css">
</head>
<body data-search="${searchPath}">
  <a class="skip" href="#content">Skip to content</a>
  <header class="top">
    <a class="brand" href="${home}">
      <img src="/icon.svg" width="32" height="32" alt="">
      <span class="word">EDGE<span>LOOP</span></span>
      <span class="wiki-tag">wiki</span>
    </a>
    <div class="search">
      <label class="sr" for="q">Search this branch</label>
      <input id="q" type="search" placeholder="Search this branch" autocomplete="off" enterkeyhint="search">
      <div id="results" role="listbox" hidden></div>
    </div>
    ${appLink}
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Pages</button>
    ${editionsBar}
  </header>
  <div class="${shellClass}">
    <nav id="site-nav" aria-label="Wiki">${nav}</nav>
    <article id="content">
      <h1>${escapeHtml(page.title)}</h1>
      ${toc}
      ${body}
    </article>
  </div>
  <footer class="colophon">
    <p>${escapeHtml(footer)} The session runs in your browser.</p>
    <p>
      <a href="https://edgeloop.app">edgeloop.app</a>
      <a href="https://dev.edgeloop.app">dev.edgeloop.app</a>
      <a href="https://discord.gg/ZSqmV7ctcU">Discord</a>
      <a href="https://github.com/marshallmims/edgeloop">GitHub</a>
    </p>
  </footer>
  <script src="/wiki.js"></script>
</body>
</html>
`;
}

function contentFile(root, edition, page) {
    const specific = join(root, 'content', edition.id, page.file);
    if (existsSync(specific)) return specific;
    if (!edition.ready) return null;
    const common = join(root, 'content', 'common', page.file);
    return existsSync(common) ? common : null;
}

function withOverrides(page, edition) {
    return { ...page, ...(edition.overrides?.[page.slug] || {}), edition: edition.id };
}

export function buildSite({ root = here, outDir = join(here, 'dist') } = {}) {
    const catalog = JSON.parse(readFileSync(join(root, 'pages.json'), 'utf8'));
    const editions = JSON.parse(readFileSync(join(root, 'editions.json'), 'utf8'));
    const slugs = new Set(catalog.filter((page) => !page.out).map((page) => page.slug));
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    cpSync(join(root, 'public'), outDir, { recursive: true });
    cpSync(join(root, '..', 'icon.svg'), join(outDir, 'icon.svg'));

    const planned = [];
    for (const edition of editions) {
        for (const source of catalog) {
            if (source.out) continue;
            const file = contentFile(root, edition, source);
            if (!file) continue;
            const page = withOverrides(source, edition);
            planned.push({ page, file, edition });
        }
    }
    const pathsByEdition = new Map();
    for (const edition of editions) {
        const paths = new Map();
        for (const item of planned) {
            if (item.edition.id === edition.id) paths.set(item.page.slug, pagePath(item.page));
        }
        pathsByEdition.set(edition.id, paths);
    }

    const search = [];
    const built = [];
    const searchByEdition = new Map();
    for (const item of planned) {
        const raw = prefixHrefs(readFileSync(item.file, 'utf8'), item.edition.id, slugs);
        const body = decorateHeadings(raw.trim());
        const headings = headingsOf(body);
        const toc = renderToc(headings);
        const editionPages = planned.filter((other) => other.edition.id === item.edition.id).map((other) => other.page);
        const nav = renderNav(editionPages, item.page);
        const bar = renderEditions(editions, item.edition.id, item.page.slug, pathsByEdition);
        const html = renderPage(item.page, body, toc, nav, item.edition, bar);
        const file = outputFile(item.page);
        const dest = join(outDir, file);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, html);
        const records = item.page.nav ? searchRecords(item.page, body) : [];
        search.push(...records);
        const bucket = searchByEdition.get(item.edition.id) || [];
        bucket.push(...records);
        searchByEdition.set(item.edition.id, bucket);
        built.push({ ...item.page, file, path: pagePath(item.page), headings });
    }

    for (const [editionId, records] of searchByEdition) {
        const dest = join(outDir, editionId, 'search.json');
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, JSON.stringify(records));
    }
    const fallback = editions.find((edition) => edition.default) || editions[0];
    writeFileSync(join(outDir, 'search.json'), JSON.stringify(searchByEdition.get(fallback.id) || []));

    const missing = catalog.find((page) => page.out);
    if (missing) {
        const raw = readFileSync(join(root, 'content', 'common', missing.file), 'utf8');
        const body = decorateHeadings(prefixHrefs(raw.trim(), fallback.id, slugs));
        const bar = renderEditions(editions, '', '', pathsByEdition);
        const editionPages = planned.filter((other) => other.edition.id === fallback.id).map((other) => other.page);
        const html = renderPage(
            { ...missing, edition: '' },
            body,
            '',
            renderNav(editionPages, missing),
            fallback,
            bar
        );
        writeFileSync(join(outDir, missing.out), html);
        built.push({ ...missing, file: missing.out, path: `/${missing.out}`, headings: headingsOf(body) });
    }

    const redirects = [];
    for (const page of built) {
        if (page.edition !== fallback.id || page.out) continue;
        const from = page.slug ? `/${page.slug}` : '';
        if (!from) {
            redirects.push(`/ /${fallback.id}/ 302`);
            continue;
        }
        redirects.push(`${from} /${fallback.id}${from}/ 302`);
        redirects.push(`${from}/ /${fallback.id}${from}/ 302`);
    }
    writeFileSync(join(outDir, '_redirects'), `${redirects.join('\n')}\n`);
    return { pages: built, search, editions };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
    const result = buildSite();
    console.log(`wiki: ${result.pages.length} pages, ${result.search.length} search entries`);
}
