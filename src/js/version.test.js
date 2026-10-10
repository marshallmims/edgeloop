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
        assert.equal(titles[1], '1.1.4.09');
        assert.equal(titles[2], '1.1.4.08');
        assert.equal(titles[3], '1.1.4.07');
        assert.equal(titles[4], '1.1.4.06');
        assert.equal(titles[5], '1.1.4.05');
        assert.equal(titles[6], '1.1.4.04');
        assert.equal(titles[7], '1.1.4.03');
        assert.equal(titles[8], '1.1.4.02');
        assert.equal(titles[9], '1.1.4.01');
        assert.equal(titles[10], '1.1.4');
        assert.equal(titles[11], '1.1.3');
        assert.equal(titles[12], '1.1.2');
        assert.equal(titles[13], '1.1.1');
        assert.equal(titles[14], '1.1.0');
        assert.ok(sections[0].blocks.some((block) => /Pre-Climax Ramp Up/.test(block.text)));
        assert.ok(sections[1].blocks.some((block) => /mild funscript/.test(block.text)));
        assert.ok(sections[2].blocks.some((block) => /Funscript morphing/.test(block.text)));
        assert.ok(sections[3].blocks.some((block) => /Warm-up is a number of minutes/.test(block.text)));
        assert.ok(sections[4].blocks.some((block) => /Warm-up sits with Session Length/.test(block.text)));
        assert.ok(sections[5].blocks.some((block) => /NNN dates/.test(block.text)));
        assert.ok(sections[6].blocks.some((block) => /Session Length/.test(block.text)));
        assert.ok(sections[7].blocks.some((block) => /Select your play style/.test(block.text)));
        assert.ok(sections[8].blocks.some((block) => /Edge Overlay/.test(block.text)));
        assert.ok(sections[9].blocks.some((block) => /Play Style/.test(block.text)));
        assert.ok(sections[10].blocks.some((block) => /dev\.edgeloop\.app/.test(block.text)));
        assert.ok(sections[11].blocks.some((block) => /Decay stays off during Calibration/.test(block.text)));
        assert.ok(sections[12].blocks.some((block) => /Survival/.test(block.text)));
        assert.ok(sections[13].blocks.some((block) => /Force Orgasm/.test(block.text)));
        assert.ok(sections[14].blocks.some((block) => /PATTERNS/.test(block.text)));
    });
});
