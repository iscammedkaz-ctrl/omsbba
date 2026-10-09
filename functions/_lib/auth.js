// Jetons HMAC-SHA256 (secret AUTH_SECRET), expiration 12 h. Les droits sont relus en KV à chaque requête :
// désactiver un compte ou changer un PIN / mot de passe invalide immédiatement les anciens jetons.
import { HttpError, PERMS, TOKEN_TTL_S, signToken, verifyToken } from "./util.js";
import { getRec } from "./store.js";

export function secretOf(env) {
  const s = env && env.AUTH_SECRET;
  if (typeof s !== "string" || s.length < 16) {
    throw new HttpError(500, "server_misconfigured", "Le secret AUTH_SECRET n'est pas configuré (16 caractères minimum).");
  }
  return s;
}
const pvOf = (rec) => String((rec.cred && rec.cred.hash) || "").slice(0, 16);
const bearer = (request) => {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m ? m[1] : "";
};
const unauthorized = (msg = "Authentification requise.") => new HttpError(401, "unauthorized", msg);

export async function issueClientToken(env, client) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_S;
  return { token: await signToken(secretOf(env), { k: "c", id: client.id, pv: pvOf(client), iat, exp }), exp };
}
export async function issueAdminToken(env, acct) {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + TOKEN_TTL_S;
  return { token: await signToken(secretOf(env), { k: "a", u: acct.user, id: acct.id, pv: pvOf(acct), iat, exp }), exp };
}
export async function requireClient(request, env) {
  const p = await verifyToken(secretOf(env), bearer(request));
  if (!p || p.k !== "c") throw unauthorized();
  const client = await getRec(env, "client:" + p.id);
  if (!client || !client.active || pvOf(client) !== p.pv) throw unauthorized("Session expirée ou canal désactivé.");
  return client;
}
export function effectivePerms(acct) {
  if (acct.role === "admin") return PERMS.slice();
  const ps = (Array.isArray(acct.perms) ? acct.perms : []).filter((p) => PERMS.includes(p));
  if (ps.includes("planEdit") && !ps.includes("planView")) ps.push("planView");
  return ps;
}
export function meOf(acct) {
  return { id: acct.id, user: acct.user, name: acct.name || acct.user, role: acct.role === "admin" ? "admin" : "staff", perms: effectivePerms(acct) };
}
export async function requireAdmin(request, env) {
  const p = await verifyToken(secretOf(env), bearer(request));
  if (!p || p.k !== "a") throw unauthorized();
  const acct = await getRec(env, "acct:" + p.u);
  if (!acct || acct.id !== p.id || !acct.active || pvOf(acct) !== p.pv) throw unauthorized("Session expirée ou compte désactivé.");
  return { acct, me: meOf(acct) };
}
export function need(me, perm) {
  if (me.role === "admin" || me.perms.includes(perm)) return;
  throw new HttpError(403, "forbidden", "Action non autorisée pour ce compte.", { need: perm });
}
export const has = (me, perm) => me.role === "admin" || me.perms.includes(perm);
export function needAdmin(me) {
  if (me.role !== "admin") throw new HttpError(403, "forbidden", "Réservé à l'administrateur.");
}
