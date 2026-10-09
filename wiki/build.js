// Static wiki builder. No dependencies. `node wiki/build.js` writes wiki/dist.
// Pages are HTML fragments in wiki/content; the shell, nav, and search index
// are generated so a new page cannot forget the navigation.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    return page.slug ? `/${page.slug}/` : '/';
}

function outputFile(page) {
    if (page.out) return page.out;
    return page.slug ? join(page.slug, 'index.html') : 'index.html';
}

function renderToc(headings) {
    if (headings.length < 2) return '';
    const items = headings.map((heading) => {
        const cls = heading.level === 3 ? ' class="toc-sub"' : '';
        return `<li${cls}><a href="#${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a></li>`;
    }).join('');
    return `<nav class="toc" aria-label="Contents"><details><summary>Contents</summary><ol>${items}</ol></details></nav>`;
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

function renderPage(page, body, toc, nav) {
    const path = pagePath(page);
    const documentTitle = page.slug === '' ? page.title : `${page.title} — EdgeLoop wiki`;
    const shellClass = toc ? 'shell' : 'shell no-toc';
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
<body>
  <a class="skip" href="#content">Skip to content</a>
  <header class="top">
    <a class="brand" href="/">
      <img src="/icon.svg" width="32" height="32" alt="">
      <span class="word">EDGE<span>LOOP</span></span>
      <span class="wiki-tag">wiki</span>
    </a>
    <div class="search">
      <label class="sr" for="q">Search the wiki</label>
      <input id="q" type="search" placeholder="Search" autocomplete="off" enterkeyhint="search">
      <div id="results" role="listbox" hidden></div>
    </div>
    <a class="app-link" href="https://edgeloop.app">Open the app</a>
    <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Pages</button>
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
    <p>Notes for EdgeLoop 1.1.3. The session stays in your browser.</p>
    <p>
      <a href="https://edgeloop.app">edgeloop.app</a>
      <a href="https://dev.edgeloop.app">dev.edgeloop.app</a>
      <a href="https://discord.gg/ZFrkehxAC">Discord</a>
      <a href="https://github.com/marshallmims/edgeloop">GitHub</a>
    </p>
  </footer>
  <script src="/wiki.js"></script>
</body>
</html>
`;
}

export function buildSite({ root = here, outDir = join(here, 'dist') } = {}) {
    const pages = JSON.parse(readFileSync(join(root, 'pages.json'), 'utf8'));
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    cpSync(join(root, 'public'), outDir, { recursive: true });
    cpSync(join(root, '..', 'icon.svg'), join(outDir, 'icon.svg'));

    const search = [];
    const built = [];
    for (const page of pages) {
        const raw = readFileSync(join(root, 'content', page.file), 'utf8');
        const body = decorateHeadings(raw.trim());
        const headings = headingsOf(body);
        const toc = renderToc(headings);
        const nav = renderNav(pages, page);
        const html = renderPage(page, body, toc, nav);
        const file = outputFile(page);
        const dest = join(outDir, file);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, html);
        if (page.nav) search.push(...searchRecords(page, body));
        built.push({ ...page, file, path: pagePath(page), headings });
    }
    writeFileSync(join(outDir, 'search.json'), JSON.stringify(search));
    return { pages: built, search };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
    const result = buildSite();
    console.log(`wiki: ${result.pages.length} pages, ${result.search.length} search entries`);
}
