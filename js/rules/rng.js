/**
 * Seeded random streams and stable hashing.
 *
 * Three independent streams are used across the product so cosmetic
 * randomness can never perturb rules outcomes:
 *   - 'rules'  : layout generation and anything rules-visible
 *   - 'decor'  : environment decoration, particle placement
 *   - 'audio'  : pitch/variant selection for sound effects
 */

/** FNV-1a 32-bit hash of a string. Returns an unsigned 32-bit integer. */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** cyrb53 — 53-bit string hash, returned as a hex string (for ids/seeds). */
export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

/** Canonical JSON with stable key order — the only JSON we ever hash. */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

/** Stable 32-bit hash of any JSON-serializable value. */
export function hashValue(value) {
  return fnv1a(canonicalJSON(value));
}

/** mulberry32 — small fast deterministic PRNG. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  const next = function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.state = () => a >>> 0;
  return next;
}

/**
 * A named deterministic random stream.
 * Streams are derived from a root seed so rules/decoration/audio never share
 * a sequence even when seeded from the same content.
 */
export class RandomStream {
  constructor(rootSeed, name) {
    this.name = name;
    this._rand = mulberry32((fnv1a(String(rootSeed)) ^ fnv1a('stream:' + name)) >>> 0);
  }
  /** Float in [0, 1). */
  next() {
    return this._rand();
  }
  /** Integer in [min, max] inclusive. */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  /** Float in [min, max). */
  range(min, max) {
    return min + this.next() * (max - min);
  }
  /** Pick one element. */
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
  /** In-place Fisher–Yates shuffle; returns the same array. */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }
  /** True with probability p. */
  chance(p) {
    return this.next() < p;
  }
  /** Serializable stream position (for snapshot/debug). */
  state() {
    return this._rand.state();
  }
}

export function rulesStream(seed) {
  return new RandomStream(seed, 'rules');
}
export function decorStream(seed) {
  return new RandomStream(seed, 'decor');
}
export function audioStream(seed) {
  return new RandomStream(seed, 'audio');
}
