// The version the footer shows. It matches package.json. 1.0.0 is the app
// as it stood when numbers started appearing there. A new feature release
// bumps the middle number. A bug fix bumps the last number. While a release
// is still on dev, the fourth number is the build: 1.1.4.01, then 1.1.4.02.
export const APP_VERSION = '1.1.4.01';

export const GITHUB_CHANGELOG_URL = 'https://github.com/marshallmims/edgeloop/blob/main/CHANGELOG.md';
export const GITHUB_RELEASES_URL = 'https://github.com/marshallmims/edgeloop/releases';

// CHANGELOG.md, grouped under its ## headings. A heading with nothing under
// it (the empty Unreleased slot) is left out. Inline markup is not interpreted
// here; the painter treats **bold** as text styling and nothing else.
export function parseChangelog(markdown) {
    const sections = [];
    let current = null;
    for (const raw of String(markdown ?? '').split(/\r?\n/)) {
        const line = raw.trim();
        if (line.startsWith('## ')) {
            current = { title: line.slice(3).trim(), blocks: [] };
            sections.push(current);
            continue;
        }
        if (!current || !line || line.startsWith('# ')) continue;
        if (line.startsWith('### ')) current.blocks.push({ type: 'area', text: line.slice(4).trim() });
        else if (line.startsWith('- ')) current.blocks.push({ type: 'item', text: line.slice(2).trim() });
        else current.blocks.push({ type: 'text', text: line });
    }
    return sections.filter((section) => section.blocks.length > 0);
}
