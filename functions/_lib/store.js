// Accès KV (binding BEB). Une clé par enregistrement :
//   book:<id> private:<id> lead:<id> payment:<id> client:<id> acct:<user> doc:<id> docfile:<id> site
//   meta:rev (révision globale), meta:seeded, rl:* (limitation de débit, TTL)
// Chaque enregistrement est écrit en valeur ET en métadonnée KV (si < 1000 octets) : une seule
// opération list() ramène alors toute la collection sans un get() par clé.
import { HttpError, rid } from "./util.js";

export const COLL = {
  books: "book:", privates: "private:", leads: "lead:", payments: "payment:",
  clients: "client:", accts: "acct:", docs: "doc:"
};
const PREFIXES = Object.entries(COLL);
const encoder = new TextEncoder();

export function kv(env) {
  if (!env || !env.BEB || typeof env.BEB.get !== "function") {
    throw new HttpError(500, "kv_missing", "Le namespace KV (binding BEB) n'est pas configuré.");
  }
  return env.BEB;
}

export async function putRec(env, key, rec) {
  const value = JSON.stringify(rec);
  const opts = {};
  if (encoder.encode(value).length <= 1000) opts.metadata = rec;
  await kv(env).put(key, value, opts);
}
export async function getRec(env, key) {
  return kv(env).get(key, "json");
}
export async function delKey(env, key) {
  await kv(env).delete(key);
}
/** Exécute des tâches asynchrones par paquets (limite la rafale de requêtes KV). */
export async function inChunks(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/* ---------- révision globale + cache mémoire par isolat ---------- */
let mem = null;
export const invalidate = () => { mem = null; };
export async function getRev(env) {
  return (await kv(env).get("meta:rev")) || "0";
}
export async function touch(env) {
  const rev = rid("r");
  mem = null;
  await kv(env).put("meta:rev", rev);
  return rev;
}

export async function readAll(env) {
  const store = kv(env);
  const out = { site: null, clients: [], accts: [], books: [], privates: [], leads: [], payments: [], docs: [] };
  const missing = [];
  let cursor;
  do {
    const r = await store.list({ limit: 1000, cursor });
    for (const k of r.keys) {
      const name = k.name;
      if (name === "site") { missing.push({ name, coll: "site" }); continue; }
      const hit = PREFIXES.find(([, p]) => name.startsWith(p));
      if (!hit) continue;
      if (k.metadata && typeof k.metadata === "object") out[hit[0]].push(k.metadata);
      else missing.push({ name, coll: hit[0] });
    }
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  await inChunks(missing, 25, async (m) => {
    const rec = await store.get(m.name, "json");
    if (!rec) return;
    if (m.coll === "site") out.site = rec; else out[m.coll].push(rec);
  });
  return out;
}
/** Lecture complète avec cache de 30 s tant que meta:rev ne change pas. Ne pas modifier le résultat. */
export async function loadAll(env) {
  const rev = await getRev(env);
  if (mem && mem.rev === rev && Date.now() - mem.t < 30000) return mem.data;
  const data = await readAll(env);
  mem = { rev, t: Date.now(), data };
  return data;
}

/* ---------- limitation de débit (Cache API colo + mémoire + KV, best-effort) ---------- */
/* Si le quota KV put() journalier est épuisé, Cache API + mémoire conservent le rate-limit sans 500. */
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
  try {
    const cur = await kv(env).get("rl:" + key, "json");
    const kvHit = rlBlocked(cur, now, limit);
    if (kvHit) throw kvHit;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error("rlCheck KV get failed", e && e.message || e);
  }
}
export async function rlHit(env, key, windowS) {
  const now = Math.floor(Date.now() / 1000);
  const cacheCur = await rlCacheGet(key);
  let rec = rlMerge(memRl.get(key), cacheCur, now, windowS);
  memRl.set(key, rec);
  await rlCachePut(key, rec);
  try {
    const cur = await kv(env).get("rl:" + key, "json");
    if (cur && now < cur.t0 + cur.w) rec = { n: Math.max(rec.n, cur.n + 1), t0: cur.t0, w: cur.w };
    memRl.set(key, rec);
    await rlCachePut(key, rec);
    const ttl = Math.max(60, rec.t0 + rec.w - now);
    await kv(env).put("rl:" + key, JSON.stringify(rec), { expirationTtl: ttl });
  } catch (e) {
    console.error("rlHit KV put failed (best-effort)", e && e.message || e);
  }
}
export async function rlClear(env, key) {
  memRl.delete(key);
  await rlCacheDel(key);
  try { await kv(env).delete("rl:" + key); }
  catch (e) { console.error("rlClear KV delete failed", e && e.message || e); }
}
