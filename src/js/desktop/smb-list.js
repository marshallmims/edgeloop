// The text `smbclient` prints for `ls`, turned into names. Pure.
//
// A line looks like:
//   Movie.mp4                           A  1048576  Wed Sep  4 10:00:00 2024
// The name is on the left. Then a type letter (D directory, A file, and a
// few others), a size, and a date. "." and ".." are the folder itself.

const LINE = /^  (.*)\s{2,}([DAHNRS])\s+(\d+)\s{2,}(\S.*)$/;

export function parseSmbListing(text) {
    const entries = [];
    for (const line of String(text ?? '').split(/\r?\n/)) {
        const match = LINE.exec(line);
        if (!match) continue;
        const name = match[1].trim();
        if (!name || name === '.' || name === '..') continue;
        entries.push({
            name,
            directory: match[2] === 'D',
            size: Number(match[3])
        });
    }
    return entries;
}
