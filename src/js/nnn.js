// No-November practice. A local quota, not an account. Missed days add their
// edges to the next day you open the app, and each missed day asks you to
// hold the edge longer before it counts. Works in any month so it can be
// tried before November.

export const NNN_STORAGE_KEY = 'edgeloop_nnn';

export const NNN_HOLD_STEP_SECONDS = 15;
export const NNN_HOLD_CAP_SECONDS = 60;
export const DEFAULT_DAILY_EDGES = 3;
export const DEFAULT_DENIAL_PERCENT = 50;

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

export function dateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function daysBetween(fromKey, toKey) {
    const a = Date.parse(`${fromKey}T00:00:00`);
    const b = Date.parse(`${toKey}T00:00:00`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    return Math.round((b - a) / 86400000);
}

export function freshNnn(date = new Date(), { dailyEdges = DEFAULT_DAILY_EDGES, denialPercent = DEFAULT_DENIAL_PERCENT } = {}) {
    const daily = clampInt(dailyEdges, 1, 20, DEFAULT_DAILY_EDGES);
    return {
        lastDate: dateKey(date),
        dailyEdges: daily,
        denialPercent: clampInt(denialPercent, 0, 100, DEFAULT_DENIAL_PERCENT),
        edgesToday: 0,
        quotaToday: daily,
        holdSeconds: 0,
        holdProgress: 0,
        finished: false,
        outcome: null
    };
}

export function sanitizeNnn(value, date = new Date()) {
    const base = freshNnn(date);
    if (!value || typeof value !== 'object') return base;
    const daily = clampInt(value.dailyEdges, 1, 20, base.dailyEdges);
    return {
        lastDate: typeof value.lastDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.lastDate) ? value.lastDate : base.lastDate,
        dailyEdges: daily,
        denialPercent: clampInt(value.denialPercent, 0, 100, base.denialPercent),
        edgesToday: clampInt(value.edgesToday, 0, 999, 0),
        quotaToday: clampInt(value.quotaToday, 1, 999, daily),
        holdSeconds: clampInt(value.holdSeconds, 0, NNN_HOLD_CAP_SECONDS, 0),
        holdProgress: clampInt(value.holdProgress, 0, NNN_HOLD_CAP_SECONDS, 0),
        finished: value.finished === true,
        outcome: value.outcome === 'permitted' || value.outcome === 'denied' ? value.outcome : null
    };
}

// Open the app on a later day. Yesterday still counts as having played.
// Each day skipped after that adds one day's edges and 15 seconds of hold.
export function catchUpNnn(state, date = new Date()) {
    const today = dateKey(date);
    const current = sanitizeNnn(state, date);
    if (current.lastDate === today) return current;
    const missed = Math.max(0, daysBetween(current.lastDate, today) - 1);
    return {
        ...current,
        lastDate: today,
        edgesToday: 0,
        quotaToday: current.dailyEdges + current.dailyEdges * missed,
        holdSeconds: Math.min(NNN_HOLD_CAP_SECONDS, missed * NNN_HOLD_STEP_SECONDS),
        holdProgress: 0,
        finished: false,
        outcome: null
    };
}

export function addMissedDay(state) {
    const current = sanitizeNnn(state);
    return {
        ...current,
        quotaToday: current.quotaToday + current.dailyEdges,
        holdSeconds: Math.min(NNN_HOLD_CAP_SECONDS, current.holdSeconds + NNN_HOLD_STEP_SECONDS),
        finished: false,
        outcome: null
    };
}

// One second on the edge. With no hold requirement the caller counts the
// edge itself. With a hold, the edge counts only after the pulse stays up.
export function tickNnnHold(state, edged) {
    const current = sanitizeNnn(state);
    if (current.finished || current.holdSeconds <= 0) {
        return { state: current, counted: false };
    }
    if (!edged) return { state: { ...current, holdProgress: 0 }, counted: false };
    const holdProgress = current.holdProgress + 1;
    if (holdProgress >= current.holdSeconds) {
        return { state: { ...current, holdProgress: 0 }, counted: true };
    }
    return { state: { ...current, holdProgress }, counted: false };
}

export function recordNnnEdge(state) {
    const current = sanitizeNnn(state);
    if (current.finished) return { state: current, justFinished: false };
    const edgesToday = current.edgesToday + 1;
    const finished = edgesToday >= current.quotaToday;
    return {
        state: { ...current, edgesToday, holdProgress: 0, finished },
        justFinished: finished
    };
}

export function rollNnnOutcome(denialPercent, rand = Math.random) {
    const p = clampInt(denialPercent, 0, 100, DEFAULT_DENIAL_PERCENT);
    return rand() * 100 < p ? 'denied' : 'permitted';
}
