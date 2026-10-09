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

/* ---------- limitation de débit (compteur KV avec TTL) ---------- */
export async function rlCheck(env, key, limit) {
  const cur = await kv(env).get("rl:" + key, "json");
  if (!cur) return;
  const now = Math.floor(Date.now() / 1000);
  if (now >= cur.t0 + cur.w) return;
  if (cur.n >= limit) {
    const e = new HttpError(429, "rate_limited", "Trop de tentatives. Réessayez plus tard.");
    e.retryAfter = Math.max(1, cur.t0 + cur.w - now);
    throw e;
  }
}
export async function rlHit(env, key, windowS) {
  const now = Math.floor(Date.now() / 1000);
  const cur = await kv(env).get("rl:" + key, "json");
  let rec;
  if (cur && now < cur.t0 + cur.w) rec = { n: cur.n + 1, t0: cur.t0, w: cur.w };
  else rec = { n: 1, t0: now, w: windowS };
  const ttl = Math.max(60, rec.t0 + rec.w - now);
  await kv(env).put("rl:" + key, JSON.stringify(rec), { expirationTtl: ttl });
}
export async function rlClear(env, key) {
  await kv(env).delete("rl:" + key);
}
