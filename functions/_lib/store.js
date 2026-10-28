// Accès D1 (binding DB). Clés logiques inchangées pour les routes :
//   book:<id> private:<id> lead:<id> payment:<id> client:<id> acct:<user> doc:<id> docfile:<id> site
//   meta:rev, meta:seeded
// Rate-limit : Cache API + mémoire uniquement (pas d'écritures D1 / KV).
import { HttpError, rid } from "./util.js";

export const COLL = {
  books: "book:", privates: "private:", leads: "lead:", payments: "payment:",
  clients: "client:", accts: "acct:", docs: "doc:"
};

const TABLE_BY_PREFIX = [
  ["book:", "books"],
  ["private:", "privates"],
  ["lead:", "leads"],
  ["payment:", "payments"],
  ["client:", "clients"],
  ["acct:", "accounts"],
  ["doc:", "docs"],
  ["docfile:", "docfiles"]
];

export function db(env) {
  if (!env || !env.DB || typeof env.DB.prepare !== "function") {
    throw new HttpError(500, "db_missing", "La base D1 (binding DB) n'est pas configurée.");
  }
  return env.DB;
}

/** @deprecated alias pour les rares appels historiques ; préférer db(). */
export function kv(env) {
  return {
    async get(key, type) {
      if (key.startsWith("docfile:")) {
        const v = await getBlob(env, key);
        return type === "json" && v ? JSON.parse(v) : v;
      }
      if (key.startsWith("meta:")) return getMeta(env, key.slice(5));
      if (key.startsWith("rl:")) return null;
      const rec = await getRec(env, key);
      if (type === "json" || type === undefined) return rec;
      return rec == null ? null : JSON.stringify(rec);
    },
    async put(key, value) {
      if (key.startsWith("docfile:")) return putBlob(env, key, value);
      if (key.startsWith("meta:")) return setMeta(env, key.slice(5), String(value));
      if (key.startsWith("rl:")) return; // no-op : RL hors D1
      const rec = typeof value === "string" ? JSON.parse(value) : value;
      return putRec(env, key, rec);
    },
    async delete(key) {
      if (key.startsWith("rl:")) return;
      return delKey(env, key);
    }
  };
}

function parseKey(key) {
  if (key === "site") return { table: "site", id: "site", kind: "site" };
  if (key.startsWith("meta:")) return { table: "meta", id: key.slice(5), kind: "meta" };
  for (const [prefix, table] of TABLE_BY_PREFIX) {
    if (key.startsWith(prefix)) return { table, id: key.slice(prefix.length), kind: "row" };
  }
  return null;
}

export async function putRec(env, key, rec) {
  const p = parseKey(key);
  if (!p || p.kind === "meta") throw new HttpError(500, "bad_key", "Clé store invalide: " + key);
  const data = JSON.stringify(rec);
  if (p.kind === "site") {
    await db(env).prepare("INSERT INTO site (id, data) VALUES ('site', ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").bind(data).run();
    return;
  }
  await db(env).prepare(
    `INSERT INTO ${p.table} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`
  ).bind(p.id, data).run();
}

export async function getRec(env, key) {
  const p = parseKey(key);
  if (!p || p.kind === "meta") return null;
  if (p.kind === "site") {
    const row = await db(env).prepare("SELECT data FROM site WHERE id = 'site'").first();
    return row ? JSON.parse(row.data) : null;
  }
  if (p.table === "docfiles") {
    const row = await db(env).prepare("SELECT data FROM docfiles WHERE id = ?").bind(p.id).first();
    return row ? row.data : null;
  }
  const row = await db(env).prepare(`SELECT data FROM ${p.table} WHERE id = ?`).bind(p.id).first();
  return row ? JSON.parse(row.data) : null;
}

export async function delKey(env, key) {
  const p = parseKey(key);
  if (!p) return;
  if (p.kind === "meta") {
    await db(env).prepare("DELETE FROM meta WHERE key = ?").bind(p.id).run();
    return;
  }
  if (p.kind === "site") {
    await db(env).prepare("DELETE FROM site WHERE id = 'site'").run();
    return;
  }
  await db(env).prepare(`DELETE FROM ${p.table} WHERE id = ?`).bind(p.id).run();
}

export async function putBlob(env, key, value) {
  const p = parseKey(key);
  if (!p || p.table !== "docfiles") throw new HttpError(500, "bad_key", "Blob attendu sous docfile:");
  await db(env).prepare(
    "INSERT INTO docfiles (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data"
  ).bind(p.id, String(value)).run();
}

export async function getBlob(env, key) {
  const p = parseKey(key);
  if (!p || p.table !== "docfiles") return null;
  const row = await db(env).prepare("SELECT data FROM docfiles WHERE id = ?").bind(p.id).first();
  return row ? row.data : null;
}

export async function getMeta(env, key) {
  const row = await db(env).prepare("SELECT value FROM meta WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

export async function setMeta(env, key, value) {
  await db(env).prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, String(value)).run();
}

/** Exécute des tâches asynchrones par paquets. */
export async function inChunks(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/* ---------- révision globale + cache mémoire par isolat ---------- */
let mem = null;
export const invalidate = () => { mem = null; };
export async function getRev(env) {
  return (await getMeta(env, "rev")) || "0";
}
export async function touch(env) {
  const rev = rid("r");
  mem = null;
  await setMeta(env, "rev", rev);
  return rev;
}

async function loadTable(env, table) {
  const res = await db(env).prepare(`SELECT data FROM ${table}`).all();
  const rows = (res && res.results) || [];
  return rows.map((r) => JSON.parse(r.data));
}

export async function readAll(env) {
  const [siteRow, clients, accts, books, privates, leads, payments, docs] = await Promise.all([
    db(env).prepare("SELECT data FROM site WHERE id = 'site'").first(),
    loadTable(env, "clients"),
    loadTable(env, "accounts"),
    loadTable(env, "books"),
    loadTable(env, "privates"),
    loadTable(env, "leads"),
    loadTable(env, "payments"),
    loadTable(env, "docs")
  ]);
  return {
    site: siteRow ? JSON.parse(siteRow.data) : null,
    clients, accts, books, privates, leads, payments, docs
  };
}

/** Lecture complète avec cache de 30 s tant que meta:rev ne change pas. Ne pas modifier le résultat. */
export async function loadAll(env) {
  const rev = await getRev(env);
  if (mem && mem.rev === rev && Date.now() - mem.t < 30000) return mem.data;
  const data = await readAll(env);
  mem = { rev, t: Date.now(), data };
  return data;
}

/* ---------- limitation de débit (Cache API colo + mémoire, pas de D1/KV) ---------- */
const memRl = new Map();
const rlReq = (key) => new Request("https://omsbeb-rl.internal/" + encodeURIComponent(key));
function rlBlocked(cur, now, limit) {
  if (!cur || now >= cur.t0 + cur.w) return null;
  if (cur.n < limit) return null;
  const e = new HttpError(429, "rate_limited", "Trop de tentatives. Réessayez plus tard.");
  e.retryAfter = Math.max(1, cur.t0 + cur.w - now);
  return e;
}
async function rlCacheGet(key) {
  try {
    const res = await caches.default.match(rlReq(key));
    if (!res) return null;
    return await res.json();
  } catch (e) { return null; }
}
async function rlCachePut(key, rec) {
  try {
    const ttl = Math.max(60, rec.t0 + rec.w - Math.floor(Date.now() / 1000));
    await caches.default.put(rlReq(key), new Response(JSON.stringify(rec), {
      headers: { "content-type": "application/json", "cache-control": "max-age=" + ttl }
    }));
  } catch (e) { console.error("rl cache put failed", e && e.message || e); }
}
async function rlCacheDel(key) {
  try { await caches.default.delete(rlReq(key)); } catch (e) { /* ignore */ }
}
function rlMerge(a, b, now, windowS) {
  const cands = [a, b].filter((x) => x && now < x.t0 + x.w);
  if (!cands.length) return { n: 1, t0: now, w: windowS };
  const t0 = Math.min(...cands.map((x) => x.t0));
  const w = cands[0].w || windowS;
  const n = Math.max(...cands.map((x) => x.n)) + 1;
  return { n, t0, w };
}
export async function rlCheck(env, key, limit) {
  const now = Math.floor(Date.now() / 1000);
  const memHit = rlBlocked(memRl.get(key), now, limit);
  if (memHit) throw memHit;
  const cacheCur = await rlCacheGet(key);
  const cacheHit = rlBlocked(cacheCur, now, limit);
  if (cacheHit) throw cacheHit;
}
export async function rlHit(env, key, windowS) {
  const now = Math.floor(Date.now() / 1000);
  const cacheCur = await rlCacheGet(key);
  const rec = rlMerge(memRl.get(key), cacheCur, now, windowS);
  memRl.set(key, rec);
  await rlCachePut(key, rec);
}
export async function rlClear(env, key) {
  memRl.delete(key);
  await rlCacheDel(key);
}
