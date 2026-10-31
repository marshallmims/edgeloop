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

    it('the dev page and the install manifest use the DEV icon', () => {
        const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
        const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
        const worker = readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
        assert.match(html, /icon-dev\.svg/);
        assert.match(html, /id="devHostBadge"/);
        assert.equal(manifest.name, 'EdgeLoop DEV');
        assert.equal(manifest.short_name, 'EL DEV');
        assert.ok(manifest.icons.every((icon) => String(icon.src).includes('icon-dev')));
        assert.match(worker, /icon-dev/);
        assert.match(worker, /manifest-dev\.json/);
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
        assert.equal(titles[1], '1.1.5.25');
        assert.equal(titles[2], '1.1.5.24');
        assert.equal(titles[3], '1.1.5.23');
        assert.equal(titles[4], '1.1.5.22');
        assert.equal(titles[5], '1.1.5.21');
        assert.equal(titles[6], '1.1.5.20');
        assert.equal(titles[7], '1.1.5.19');
        assert.equal(titles[8], '1.1.5.18');
        assert.equal(titles[9], '1.1.5.17');
        assert.equal(titles[10], '1.1.5.16');
        assert.equal(titles[11], '1.1.5.15');
        assert.equal(titles[12], '1.1.5.14');
        assert.equal(titles[13], '1.1.5.13');
        assert.equal(titles[14], '1.1.5.12');
        assert.equal(titles[15], '1.1.5.11');
        assert.equal(titles[16], '1.1.5.10');
        assert.equal(titles[17], '1.1.5.09');
        assert.equal(titles[18], '1.1.5.08');
        assert.equal(titles[19], '1.1.5.07');
        assert.equal(titles[20], '1.1.5.06');
        assert.equal(titles[21], '1.1.5.05');
        assert.equal(titles[22], '1.1.5.04');
        assert.equal(titles[23], '1.1.5.03');
        assert.equal(titles[24], '1.1.5.02');
        assert.equal(titles[25], '1.1.5.01');
        assert.equal(titles[26], '1.1.4.32');
        assert.equal(titles[27], '1.1.4.31');
        assert.equal(titles[28], '1.1.4.30');
        assert.equal(titles[29], '1.1.4.29');
        assert.equal(titles[30], '1.1.4.28');        assert.equal(titles[31], '1.1.4.27');        assert.equal(titles[32], '1.1.4.26');        assert.equal(titles[33], '1.1.4.25');        assert.equal(titles[34], '1.1.4.24');        assert.equal(titles[35], '1.1.4.23');        assert.equal(titles[36], '1.1.4.22');        assert.equal(titles[37], '1.1.4.21');        assert.equal(titles[38], '1.1.4.20');        assert.equal(titles[39], '1.1.4.19');        assert.equal(titles[40], '1.1.4.18');        assert.equal(titles[41], '1.1.4.17');        assert.equal(titles[42], '1.1.4.16');        assert.equal(titles[43], '1.1.4.15');        assert.equal(titles[44], '1.1.4.14');        assert.equal(titles[45], '1.1.4.13');        assert.equal(titles[46], '1.1.4.12');        assert.equal(titles[47], '1.1.4.11');        assert.equal(titles[48], '1.1.4.10');        assert.equal(titles[49], '1.1.4.09');        assert.equal(titles[50], '1.1.4.08');        assert.equal(titles[51], '1.1.4.07');        assert.equal(titles[52], '1.1.4.06');        assert.equal(titles[53], '1.1.4.05');        assert.equal(titles[54], '1.1.4.04');        assert.equal(titles[55], '1.1.4.03');        assert.equal(titles[56], '1.1.4.02');        assert.equal(titles[57], '1.1.4.01');        assert.equal(titles[58], '1.1.4');        assert.equal(titles[59], '1.1.3');        assert.equal(titles[60], '1.1.2');        assert.equal(titles[61], '1.1.1');        assert.equal(titles[62], '1.1.0');        assert.ok(sections[0].blocks.some((block) => /This firmware is not sending the Handy battery percentage/.test(block.text)));
        assert.ok(sections[1].blocks.some((block) => /The Handy battery number comes from the live stream/.test(block.text)));
        assert.ok(sections[2].blocks.some((block) => /A slow Handy move glides/.test(block.text)));
        assert.ok(sections[3].blocks.some((block) => /The Handy battery percentage shows/.test(block.text)));
        assert.ok(sections[4].blocks.some((block) => /The controller graph follows faster/.test(block.text)));
        assert.ok(sections[5].blocks.some((block) => /A saved loop can be deleted/.test(block.text)));
        assert.ok(sections[6].blocks.some((block) => /A loop plays on the toy you picked/.test(block.text)));
        assert.ok(sections[7].blocks.some((block) => /A pause stops the channel bars/.test(block.text)));
        assert.ok(sections[8].blocks.some((block) => /Manual control reaches the toys again/.test(block.text)));
        assert.ok(sections[9].blocks.some((block) => /The focused-window warning no longer covers the page/.test(block.text)));
        assert.ok(sections[10].blocks.some((block) => /Every toy picks its own mode/.test(block.text)));
        assert.ok(sections[11].blocks.some((block) => /The session log includes Share Control/.test(block.text)));
        assert.ok(sections[12].blocks.some((block) => /The Handy follows faster/.test(block.text)));
        assert.ok(sections[13].blocks.some((block) => /The Handy uses the whole stroke again/.test(block.text)));
        assert.ok(sections[14].blocks.some((block) => /Manual follow no longer waits on a background timer/.test(block.text)));
        assert.ok(sections[15].blocks.some((block) => /Firmware 4 position is a fraction/.test(block.text)));
        assert.ok(sections[16].blocks.some((block) => /The Handy dot uses absolute position on firmware 4/.test(block.text)));
        assert.ok(sections[17].blocks.some((block) => /Came Early and Force Orgasm are one line each/.test(block.text)));
        assert.ok(sections[18].blocks.some((block) => /Each EdgeLoop toy keeps its own play style/.test(block.text)));
        assert.ok(sections[19].blocks.some((block) => /A slider holds the level it shows/.test(block.text)));
        assert.ok(sections[20].blocks.some((block) => /Traditional is the sliders/.test(block.text)));
        assert.ok(sections[21].blocks.some((block) => /Linux Chrome flag under Scan/.test(block.text)));
        assert.ok(sections[22].blocks.some((block) => /Solo, Video Player, and Share Control/.test(block.text)));
        assert.ok(sections[23].blocks.some((block) => /Share Control toggles back/.test(block.text)));
        assert.ok(sections[24].blocks.some((block) => /Share Control opens this page/.test(block.text)));
        assert.ok(sections[25].blocks.some((block) => /Share Control changes the page/.test(block.text)));
        assert.ok(sections[26].blocks.some((block) => /not the focused window/.test(block.text)));
        assert.ok(sections[27].blocks.some((block) => /No Nut November/.test(block.text)));
        assert.ok(sections[27].blocks.some((block) => /plain icon/.test(block.text)));
        assert.ok(sections[27].blocks.some((block) => /session log is there/.test(block.text)));
        assert.ok(sections[28].blocks.some((block) => /A choice closes the lists/.test(block.text)));
        assert.ok(sections[29].blocks.some((block) => /A choice stays open/.test(block.text)));
        assert.ok(sections[30].blocks.some((block) => /The video controls are one bar/.test(block.text)));
        assert.ok(sections[31].blocks.some((block) => /Session length sits with the heart rate/.test(block.text)));
        assert.ok(sections[32].blocks.some((block) => /Finisher holds the heart rate you set/.test(block.text)));
        assert.ok(sections[33].blocks.some((block) => /Edged stops the toys/.test(block.text)));
        assert.ok(sections[34].blocks.some((block) => /Tap the edge count/.test(block.text)));
        assert.ok(sections[35].blocks.some((block) => /Crawl speed is a number/.test(block.text)));
        assert.ok(sections[36].blocks.some((block) => /Stops and pauses are logged/.test(block.text)));
        assert.ok(sections[37].blocks.some((block) => /Bratty Tease/.test(block.text)));
        assert.ok(sections[38].blocks.some((block) => /easier to read/.test(block.text)));
        assert.ok(sections[39].blocks.some((block) => /Simple Ramp/.test(block.text)));
        assert.ok(sections[40].blocks.some((block) => /Session Length sits under Start and Stop/.test(block.text)));
        assert.ok(sections[41].blocks.some((block) => /Primary Ease/.test(block.text)));
        assert.ok(sections[42].blocks.some((block) => /left column/.test(block.text)));
        assert.ok(sections[43].blocks.some((block) => /main page uses the Player layout/.test(block.text)));
        assert.ok(sections[44].blocks.some((block) => /Warm-up sits with the heart rate/.test(block.text)));
        assert.ok(sections[45].blocks.some((block) => /Beat sync is in The Handy/.test(block.text)));
        assert.ok(sections[46].blocks.some((block) => /Tap to configure/.test(block.text)));
        assert.ok(sections[47].blocks.some((block) => /Devices are one row/.test(block.text)));
        assert.ok(sections[48].blocks.some((block) => /Pre-Climax Ramp Up/.test(block.text)));
        assert.ok(sections[49].blocks.some((block) => /mild funscript/.test(block.text)));
        assert.ok(sections[50].blocks.some((block) => /Funscript morphing/.test(block.text)));
        assert.ok(sections[51].blocks.some((block) => /Warm-up is a number of minutes/.test(block.text)));
        assert.ok(sections[52].blocks.some((block) => /Warm-up sits with Session Length/.test(block.text)));
        assert.ok(sections[53].blocks.some((block) => /NNN dates/.test(block.text)));
        assert.ok(sections[54].blocks.some((block) => /Session Length/.test(block.text)));
        assert.ok(sections[55].blocks.some((block) => /Select your play style/.test(block.text)));
        assert.ok(sections[56].blocks.some((block) => /Edge Overlay/.test(block.text)));
        assert.ok(sections[57].blocks.some((block) => /Play Style/.test(block.text)));
        assert.ok(sections[58].blocks.some((block) => /dev\.edgeloop\.app/.test(block.text)));
        assert.ok(sections[59].blocks.some((block) => /Decay stays off during Calibration/.test(block.text)));
        assert.ok(sections[60].blocks.some((block) => /Survival/.test(block.text)));
        assert.ok(sections[61].blocks.some((block) => /Force Orgasm/.test(block.text)));
        assert.ok(sections[62].blocks.some((block) => /PATTERNS/.test(block.text)));
    });
});
