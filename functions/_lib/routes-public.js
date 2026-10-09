// Endpoints publics et espace client (canal).
import {
  HttpError, bad, str, obj, oneOf, int, date, slotOf, phone, code as cleanCode, digits, nowISO, todayISO, rid, randDigits,
  verifySecret, TYPES, SLOTS
} from "./util.js";
import { loadAll, putRec, touch, rlCheck, rlHit, rlClear } from "./store.js";
import { issueClientToken, requireClient } from "./auth.js";
import { publicSite, clientBookOut } from "./domain.js";

const WINDOW = 600; // 10 minutes
export const LOGIN_MAX = 5; // essais ratés / 10 min / IP+code
const CODE_MAX = 40; // essais ratés / 10 min / code, toutes IP confondues
const PUBLIC_POST_MAX = 15; // dépôts publics / 10 min / IP
const TRACK_MAX = 10;

export const ipOf = (request) => request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";

async function publicPostGuard(env, request) {
  const key = "pub:" + ipOf(request);
  await rlCheck(env, key, PUBLIC_POST_MAX);
  await rlHit(env, key, WINDOW);
}

/** GET /api/public : contenu du site + planning public (séances visées uniquement, « Autres clients » masqués). */
export async function getPublic(env) {
  const data = await loadAll(env);
  const clientById = new Map(data.clients.map((c) => [c.id, c]));
  const plan = [];
  for (const b of data.books) {
    if (b.status !== "vise") continue;
    const c = clientById.get(b.clientId);
    if (c && c.type !== "prive") plan.push({ d: b.date, s: b.slot, sp: b.space, k: "busy", w: c.name });
    else plan.push({ d: b.date, s: b.slot, sp: b.space, k: "resv", w: "" });
  }
  for (const p of data.privates) if (p.status === "vise") plan.push({ d: p.date, s: p.slot, sp: p.space, k: "resv", w: "" });
  plan.sort((a, b) => (a.d + a.s).localeCompare(b.d + b.s));
  const clients = data.clients.slice().sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))
    .filter((c) => c.active && (c.type === "club" || c.type === "ecole"))
    .map((c) => ({ name: c.name, type: c.type, contrat: !!c.contrat, kind: c.contrat ? c.kind || "" : "" }));
  return { site: publicSite(data.site), clients, plan, slots: SLOTS, serverTime: nowISO() };
}

/** POST /api/lead */
export async function postLead(env, request, body) {
  await publicPostGuard(env, request);
  obj(body);
  const data = await loadAll(env);
  if (data.leads.length >= 1000) throw new HttpError(429, "too_many", "Trop de demandes en attente. Réessayez plus tard.");
  const rec = {
    id: rid("l"), org: str(body.org, 120, { required: true, name: "structure" }), type: oneOf(body.type, TYPES, "type"),
    contact: str(body.contact, 80, { required: true, name: "contact" }), phone: phone(body.phone),
    message: str(body.message, 1000, { required: true, name: "besoin", multiline: true }), created: nowISO(), rev: 1
  };
  await putRec(env, "lead:" + rec.id, rec);
  await touch(env);
  return { ok: true };
}

function checkFuture(d) {
  if (d < todayISO(-1)) throw bad("date : dans le passé");
  if (d > todayISO(800)) throw bad("date : trop lointaine");
}
function checkSpaceDisc(data, space, disc) {
  const sp = data.site.spaces.find((s) => s.id === space && s.on);
  if (!sp) throw bad("espace indisponible");
  if (!data.site.disciplines.some((s) => s.id === disc && s.on)) throw bad("discipline indisponible");
}

/** POST /api/other-request : demande « Autres clients » (sans canal). Renvoie le code de suivi PRV-xxxx. */
export async function postOtherRequest(env, request, body) {
  await publicPostGuard(env, request);
  obj(body);
  const data = await loadAll(env);
  if (data.privates.filter((p) => p.status === "attente").length >= 500) throw new HttpError(429, "too_many", "Trop de demandes en attente. Réessayez plus tard.");
  const space = str(body.space, 32, { required: true, name: "espace" });
  const disc = str(body.disc, 32, { required: true, name: "discipline" });
  const d = date(body.date);
  checkFuture(d);
  checkSpaceDisc(data, space, disc);
  const used = new Set(data.privates.map((p) => String(p.code).toUpperCase()));
  let c;
  do { c = "PRV-" + randDigits(4); } while (used.has(c));
  const rec = {
    id: rid("p"), code: c, name: str(body.name, 80, { required: true, name: "nom" }), phone: phone(body.phone),
    date: d, slot: slotOf(body.slot), space, disc, people: int(body.people, 1, 5000, "effectif"),
    note: str(body.note, 200, { name: "note" }), status: "attente", motif: "", by: "", created: nowISO(), rev: 1
  };
  await putRec(env, "private:" + rec.id, rec);
  await touch(env);
  return { ok: true, code: c };
}

/** POST /api/other-track {code, phone} : suivi d'une demande « Autres clients ». */
export async function postOtherTrack(env, request, body) {
  obj(body);
  const key = "trk:" + ipOf(request);
  await rlCheck(env, key, TRACK_MAX);
  const c = str(body.code, 20, { required: true, name: "code" }).toUpperCase();
  const ph = digits(phone(body.phone));
  const data = await loadAll(env);
  const hit = data.privates.find((p) => String(p.code).toUpperCase() === c && digits(p.phone) === ph);
  if (!hit) {
    await rlHit(env, key, WINDOW);
    throw new HttpError(404, "not_found", "Code ou téléphone incorrect.");
  }
  return { ok: true, item: { date: hit.date, slot: hit.slot, space: hit.space, disc: hit.disc, status: hit.status, motif: hit.motif || "" } };
}

/** POST /api/client/login {code, pin} */
export async function clientLogin(env, request, body) {
  obj(body);
  const c = String(body.code == null ? "" : body.code).trim().toUpperCase().slice(0, 40);
  const pin = String(body.pin == null ? "" : body.pin).trim().slice(0, 64);
  if (!c || !pin) throw bad("code et PIN requis");
  const ip = ipOf(request);
  const k1 = "cl:" + ip + ":" + c, k2 = "clc:" + c;
  await rlCheck(env, k1, LOGIN_MAX);
  await rlCheck(env, k2, CODE_MAX);
  const data = await loadAll(env);
  const client = data.clients.find((x) => String(x.code).toUpperCase() === c);
  const ok = await verifySecret(pin, client && client.cred);
  if (!client || !ok || !client.active) {
    await rlHit(env, k1, WINDOW);
    await rlHit(env, k2, WINDOW);
    throw new HttpError(401, "bad_credentials", "Code ou PIN incorrect.");
  }
  await rlClear(env, k1);
  const { token, exp } = await issueClientToken(env, client);
  return { token, exp, client: { id: client.id, type: client.type, name: client.name, code: client.code } };
}

/** GET /api/client/me */
export async function clientMe(env, request) {
  const client = await requireClient(request, env);
  const data = await loadAll(env);
  const books = data.books.filter((b) => b.clientId === client.id).map(clientBookOut)
    .sort((a, b) => (a.date + a.slot).localeCompare(b.date + b.slot));
  return { client: { id: client.id, type: client.type, name: client.name, code: client.code, active: client.active }, books };
}

/** POST /api/client/book : nouvelle demande, statut « attente ». */
export async function clientBook(env, request, body) {
  const client = await requireClient(request, env);
  obj(body);
  const data = await loadAll(env);
  const mine = data.books.filter((b) => b.clientId === client.id && b.status === "attente");
  if (mine.length >= 60) throw new HttpError(429, "too_many", "Trop de demandes en attente pour ce canal.");
  const space = str(body.space, 32, { required: true, name: "espace" });
  const disc = str(body.disc, 32, { required: true, name: "discipline" });
  const d = date(body.date);
  checkFuture(d);
  checkSpaceDisc(data, space, disc);
  const rec = {
    id: rid("b"), clientId: client.id, date: d, slot: slotOf(body.slot), space, disc,
    people: int(body.people, 1, 5000, "effectif"), note: str(body.note, 200, { name: "note" }),
    status: "attente", motif: "", by: "", created: nowISO(), rev: 1
  };
  await putRec(env, "book:" + rec.id, rec);
  await touch(env);
  return { ok: true, book: clientBookOut(rec) };
}
