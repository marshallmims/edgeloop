import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('the dev worker can relay Share Control', () => {
    it('gives the dev environment the agent room binding', () => {
        const text = readFileSync(new URL('../../wrangler.jsonc', import.meta.url), 'utf8');
        const dev = text.split('"env"')[1] || '';
        assert.match(dev, /"name": "AGENT_ROOMS"/);
        assert.match(dev, /"class_name": "AgentRoom"/);
        assert.match(dev, /new_sqlite_classes/);
    });
});
