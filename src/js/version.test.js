import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APP_VERSION, parseChangelog } from './version.js';

describe('the version has one number', () => {
    it('matches package.json and the footer', () => {
        const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        assert.equal(pkg.version, APP_VERSION);
        assert.match(html, new RegExp(`id="appVersion"[^>]*>v${APP_VERSION}<`));
        assert.match(html, /id="footerChangelogBtn"/);
    });
});

describe('parseChangelog', () => {
    it('keeps numbered releases and drops an empty Unreleased heading', () => {
        const sections = parseChangelog([
            '# Changelog',
            '',
            '## Unreleased',
            '',
            '## 1.1.0',
            '',
            '### Patterns',
            '- Stroke length wanders.',
            '',
            '## 1.0.0',
            '- The footer gained Discord.'
        ].join('\n'));
        assert.deepEqual(sections.map((section) => section.title), ['1.1.0', '1.0.0']);
        assert.equal(sections[0].blocks[0].type, 'area');
        assert.equal(sections[0].blocks[1].text, 'Stroke length wanders.');
        assert.equal(sections[1].blocks[0].text, 'The footer gained Discord.');
    });

    it('reads the real changelog as the current version, then 1.1.2, then 1.1.1, then 1.1.0', () => {
        const text = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
        const sections = parseChangelog(text);
        const titles = sections.map((section) => section.title);
        assert.equal(titles[0], APP_VERSION);
        assert.equal(titles[1], '1.1.2');
        assert.equal(titles[2], '1.1.1');
        assert.equal(titles[3], '1.1.0');
        assert.ok(sections[0].blocks.some((block) => /dev\.edgeloop\.app/.test(block.text)));
        assert.ok(sections[0].blocks.some((block) => /Decay stays off during Calibration/.test(block.text)));
        assert.ok(sections[1].blocks.some((block) => /Survival/.test(block.text)));
        assert.ok(sections[2].blocks.some((block) => /Force Orgasm/.test(block.text)));
        assert.ok(sections[3].blocks.some((block) => /PATTERNS/.test(block.text)));
    });
});
