// The big BPM number. 70 is the resting default the engine keeps before a
// monitor has spoken. Painting that number looks like a live pulse.

export function formatLiveHr({ bpm = null, linked = false, simulated = false, seen = false } = {}) {
    if (!simulated && (!linked || !seen)) return '--';
    const n = Number(bpm);
    if (!Number.isFinite(n) || n < 35 || n > 250) return '--';
    return String(Math.round(n));
}
