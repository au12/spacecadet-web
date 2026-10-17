// High scores: a per-browser table plus the shared table kept by the server.

const LOCAL_KEY = (kind) => `spacecadet.scores.${kind}`;
const LOCAL_MAX = 10;

export class Scores {
  constructor() {
    this.serverAvailable = false;
    this.cache = new Map(); // kind -> server list
  }

  local(kind) {
    try {
      const list = JSON.parse(localStorage.getItem(LOCAL_KEY(kind)) || '[]');
      return Array.isArray(list) ? list.filter((e) => e && typeof e.score === 'number') : [];
    } catch {
      return [];
    }
  }

  _saveLocal(kind, list) {
    try { localStorage.setItem(LOCAL_KEY(kind), JSON.stringify(list.slice(0, LOCAL_MAX))); } catch { /* quota */ }
  }

  async server(kind, { force = false } = {}) {
    if (!this.serverAvailable) return null;
    if (!force && this.cache.has(kind)) return this.cache.get(kind);
    try {
      const res = await fetch(`api/scores?table=${encodeURIComponent(kind)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(res.statusText);
      const { scores } = await res.json();
      this.cache.set(kind, scores);
      return scores;
    } catch {
      return this.cache.get(kind) || null;
    }
  }

  /** Best list to show: the shared one when there is a server. */
  async best(kind) {
    const shared = await this.server(kind);
    return { list: shared ?? this.local(kind), shared: shared !== null };
  }

  /** Would this score make either list? Returns the rank it would take (1-based) or 0. */
  async qualifies(kind, score) {
    if (score <= 0) return 0;
    const rankIn = (list, max) => {
      const i = list.findIndex((e) => score > e.score);
      if (i >= 0) return i + 1;
      return list.length < max ? list.length + 1 : 0;
    };
    const shared = await this.server(kind, { force: true });
    const localRank = rankIn(this.local(kind), LOCAL_MAX);
    const sharedRank = shared ? rankIn(shared, 25) : 0;
    return { local: localRank, shared: sharedRank, any: localRank || sharedRank };
  }

  async submit(kind, entry) {
    const record = { name: entry.name, score: entry.score, players: entry.players || 1, date: Date.now() };
    const list = this.local(kind);
    list.push(record);
    list.sort((a, b) => b.score - a.score || a.date - b.date);
    this._saveLocal(kind, list);
    const localRank = list.indexOf(record) + 1;

    let sharedRank = 0;
    if (this.serverAvailable) {
      try {
        const res = await fetch('api/scores', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ table: kind, name: record.name, score: record.score, players: record.players }),
        });
        if (res.ok) {
          const body = await res.json();
          sharedRank = body.rank || 0;
          this.cache.set(kind, body.scores);
        }
      } catch { /* offline: the local copy still counts */ }
    }
    return { localRank: localRank <= LOCAL_MAX ? localRank : 0, sharedRank };
  }

  clearLocal(kind) {
    try { localStorage.removeItem(LOCAL_KEY(kind)); } catch { /* ignore */ }
  }
}

export const formatScore = (n) => Math.max(0, Math.floor(n)).toLocaleString('en-US');
