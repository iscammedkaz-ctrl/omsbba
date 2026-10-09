// Utilitaires communs : erreurs HTTP, validation stricte, crypto (WebCrypto uniquement).

export const SLOTS = ["08:00–10:00", "10:00–12:00", "14:00–16:00", "16:00–18:00", "18:00–20:00", "20:00–22:00"];
export const STATUSES = ["attente", "vise", "refuse"];
export const TYPES = ["federation", "ligue", "club", "ecole", "prive"];
export const PERMS = ["suivi", "pay", "planView", "planEdit", "channels", "others", "site", "accounts", "export"];
export const DOC_TYPES = ["demande", "agrement", "assurance", "convprev", "convention", "statuts", "entrainement", "rc", "agrementecole", "licence", "medical", "facture", "autre"];
export const DOC_STATUS = ["recu", "manquant", "expire"];
export const ADMIN_USER = "yasser";
export const PBKDF2_ITER = 100000; // maximum accepté par Cloudflare Workers
export const TOKEN_TTL_S = 12 * 3600;

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status; this.code = code; this.details = details;
  }
}
export const bad = (message, details) => new HttpError(400, "invalid", message, details);

const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY"
};
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...BASE_HEADERS, ...extra } });
}
export function errorResponse(e) {
  const extra = {};
  if (e.retryAfter) extra["retry-after"] = String(e.retryAfter);
  return json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }, e.status, extra);
}

/* ---------- validation ---------- */
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
export function str(v, max, { required = false, name = "champ", multiline = false } = {}) {
  if (v === undefined || v === null) v = "";
  if (typeof v === "number" && isFinite(v)) v = String(v);
  if (typeof v !== "string") throw bad(`${name} : texte attendu`);
  let s = v.replace(CTRL, "");
  if (!multiline) s = s.replace(/[\r\n\t]+/g, " ");
  s = s.trim();
  if (s.length > max) throw bad(`${name} : ${max} caractères maximum`);
  if (required && !s) throw bad(`${name} : requis`);
  return s;
}
export function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
export function date(v, name = "date", { optional = false } = {}) {
  if (optional && (v === undefined || v === null || v === "")) return "";
  if (!isDate(v)) throw bad(`${name} : date AAAA-MM-JJ invalide`);
  return v;
}
export function oneOf(v, list, name) {
  if (!list.includes(v)) throw bad(`${name} : valeur non autorisée`);
  return v;
}
export function int(v, min, max, name) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) throw bad(`${name} : entier entre ${min} et ${max} attendu`);
  return n;
}
export function money(v, name) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : v;
  if (typeof n !== "number" || !isFinite(n) || n < 0 || n > 1e10) throw bad(`${name} : montant invalide`);
  return Math.round(n * 100) / 100;
}
export function bool(v, name) {
  if (typeof v !== "boolean") throw bad(`${name} : booléen attendu`);
  return v;
}
export function obj(v, name = "corps") {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad(`${name} : objet attendu`);
  return v;
}
export function arr(v, max, name) {
  if (!Array.isArray(v)) throw bad(`${name} : liste attendue`);
  if (v.length > max) throw bad(`${name} : ${max} éléments maximum`);
  return v;
}
export const slotOf = (v) => oneOf(v, SLOTS, "créneau");
export function phone(v, { required = true } = {}) {
  const s = str(v, 30, { required, name: "téléphone" });
  if (s && !/^[0-9+()\-. ]{6,30}$/.test(s)) throw bad("téléphone invalide");
  return s;
}
export const digits = (v) => String(v || "").replace(/\D/g, "");
export function code(v) {
  const s = str(v, 32, { required: true, name: "code" }).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{1,31}$/.test(s)) throw bad("code : lettres, chiffres, . _ - (2 à 32 caractères)");
  return s;
}
export function pin(v) {
  const s = typeof v === "number" ? String(v) : v;
  if (typeof s !== "string") throw bad("PIN : texte attendu");
  const p = s.trim();
  if (p.length < 4 || p.length > 32 || /\s/.test(p)) throw bad("PIN : 4 à 32 caractères sans espace");
  return p;
}
export function password(v, name = "mot de passe") {
  if (typeof v !== "string") throw bad(`${name} : texte attendu`);
  const p = v.trim();
  if (p.length < 6) throw bad(`${name} : 6 caractères minimum`, { field: "short" });
  if (p.length > 128) throw bad(`${name} : 128 caractères maximum`);
  return p;
}
export const nowISO = () => new Date().toISOString();
export function todayISO(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}
export function rid(prefix) {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return prefix + Date.now().toString(36) + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}
export function randDigits(n) {
  const a = new Uint32Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => String(x % 10)).join("");
}

/* ---------- crypto ---------- */
const enc = new TextEncoder();
export const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
export function unhex(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
export function b64u(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s) {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let d = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
async function pbkdf2(secret, saltHex, iter) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unhex(saltHex), iterations: iter }, key, 256);
  return hex(bits);
}
export function newSalt() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return hex(a);
}
/** Hachage salé PBKDF2-SHA256 (100 000 itérations). */
export async function hashSecret(secret, salt = newSalt()) {
  return { salt, hash: await pbkdf2(secret, salt, PBKDF2_ITER), iter: PBKDF2_ITER, algo: "pbkdf2-sha256" };
}
const DUMMY_SALT = "00112233445566778899aabbccddeeff";
/** Vérifie en temps constant ; si rec est absent, fait quand même un calcul équivalent (anti-énumération). */
export async function verifySecret(secret, rec) {
  const iter = rec && rec.iter ? Math.min(rec.iter, PBKDF2_ITER) : PBKDF2_ITER;
  const h = await pbkdf2(String(secret), rec && rec.salt ? rec.salt : DUMMY_SALT, iter);
  if (!rec || !rec.hash) return false;
  return timingSafeEqual(h, rec.hash);
}
export function credOf(rec) { return { salt: rec.salt, hash: rec.hash, iter: rec.iter, algo: rec.algo }; }

async function hmacKey(secret, usages) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}
export async function signToken(secret, payload) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(body));
  return body + "." + b64u(sig);
}
export async function verifyToken(secret, token) {
  if (typeof token !== "string" || token.length > 2000) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), unb64u(parts[1]), enc.encode(parts[0]));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(unb64u(parts[0])));
    if (!p || typeof p.exp !== "number" || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch (e) { return null; }
}
