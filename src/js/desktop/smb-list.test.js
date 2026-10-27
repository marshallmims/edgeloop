import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSmbListing } from './smb-list.js';

const SAMPLE = `
  .                                   D        0  Wed Sep  4 10:00:00 2024
  ..                                  D        0  Wed Sep  4 10:00:00 2024
  Scene Name.mp4                      A  1048576  Wed Sep  4 10:00:00 2024
  Scene Name.funscript                A     2048  Wed Sep  4 10:00:00 2024
  Scene Name.v0.funscript             A      512  Wed Sep  4 10:00:00 2024
  extras                              D        0  Wed Sep  4 10:00:00 2024

                123456 blocks of size 1024. 12345 blocks available
`;

describe('smbclient listings', () => {
    it('reads files and folders, and skips . and ..', () => {
        const entries = parseSmbListing(SAMPLE);
        assert.deepEqual(entries, [
            { name: 'Scene Name.mp4', directory: false, size: 1048576 },
            { name: 'Scene Name.funscript', directory: false, size: 2048 },
            { name: 'Scene Name.v0.funscript', directory: false, size: 512 },
            { name: 'extras', directory: true, size: 0 }
        ]);
    });

    it('an empty reply is an empty folder', () => {
        assert.deepEqual(parseSmbListing(''), []);
    });
});
