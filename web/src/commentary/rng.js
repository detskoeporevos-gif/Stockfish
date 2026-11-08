/*
  GambitFish — детерминированный ГПСЧ для выбора фраз.
  Один и тот же ход всегда комментируется одинаково, но разные ходы —
  по-разному. GPL-3.0.
*/

export function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

export function makeRng(seed) {
    let s = (typeof seed === 'string' ? hashString(seed) : seed) >>> 0;
    if (!s) s = 0x9e3779b9;
    return function next() {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
    };
}

export function pick(rng, list) {
    if (!list || !list.length) return '';
    return list[Math.floor(rng() * list.length) % list.length];
}

export function pickWeighted(rng, entries) {
    const total = entries.reduce((a, e) => a + (e.w ?? 1), 0);
    let r = rng() * total;
    for (const e of entries) {
        r -= e.w ?? 1;
        if (r <= 0) return e.v ?? e;
    }
    return entries[entries.length - 1].v ?? '';
}

export function shuffle(rng, list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
