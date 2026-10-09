// Endpoints de Gestion : toutes les permissions sont vérifiées ICI, côté serveur.
import {
  HttpError, bad, str, obj, arr, bool, oneOf, int, money, date, isDate, slotOf, phone, code as cleanCode, pin as cleanPin, password as cleanPassword,
  nowISO, rid, randDigits, digits, hashSecret, verifySecret, credOf, SLOTS, TYPES, PERMS, DOC_TYPES, DOC_STATUS, ADMIN_USER, todayISO
} from "./util.js";
import { loadAll, getRec, putRec, delKey, touch, getRev, inChunks, kv, rlCheck, rlHit, rlClear, invalidate } from "./store.js";
import { issueAdminToken, requireAdmin, need, has, needAdmin, meOf } from "./auth.js";
import { cleanSite, stripCred, clientForAdmin, occupancy, findConflicts, conflictError, cleanSessionBase } from "./domain.js";
import { ipOf } from "./routes-public.js";

const WINDOW = 600;
const PREFIX = { books: "book:", privates: "private:" };
const MIME_OK = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"];
const MAX_FILE_DATA = 2_200_000; // ~1,5 Mo en base64

const stale = () => new HttpError(409, "stale", "Cet élément a été modifié ailleurs. Rafraîchissez puis recommencez.");
const notFound = (what = "élément") => new HttpError(404, "not_found", what + " introuvable.");
function checkRev(cur, body) {
  if (body && body.rev !== undefined && body.rev !== null && body.rev !== cur.rev) throw stale();
}
const bump = (rec) => ({ ...rec, rev: (rec.rev || 0) + 1, updated: nowISO() });
const canSeePriv = (me) => has(me, "others") || has(me, "suivi");

/* ---------- connexion ---------- */
export async function adminLogin(env, request, body) {
  obj(body);
  const user = String(body.user == null ? "" : body.user).trim().toLowerCase().slice(0, 40);
  const pw = String(body.password == null ? "" : body.password).slice(0, 200);
  if (!user || !pw) throw bad("identifiant et mot de passe requis");
  const k1 = "ad:" + ipOf(request) + ":" + user, k2 = "adc:" + user;
  await rlCheck(env, k1, 5);
  await rlCheck(env, k2, 30);
  const acct = await getRec(env, "acct:" + user);
  const ok = await verifySecret(pw, acct && acct.cred);
  if (!acct || !ok) {
    await rlHit(env, k1, WINDOW);
    await rlHit(env, k2, WINDOW);
    throw new HttpError(401, "bad_credentials", "Identifiant ou mot de passe incorrect.");
  }
  if (!acct.active) throw new HttpError(403, "account_disabled", "Compte désactivé.");
  await rlClear(env, k1);
  const { token, exp } = await issueAdminToken(env, acct);
  return { token, exp, me: meOf(acct) };
}

/* ---------- état filtré par permissions ---------- */
function privOut(p, full) {
  if (full) return p;
  const { phone: _p, code: _c, ...rest } = p;
  return rest;
}
function docOut(d) { return d; }
async function buildState(env, me) {
  const data = await loadAll(env);
  const rev = await getRev(env);
  const full = has(me, "channels") || has(me, "suivi");
  const st = {
    rev, serverTime: nowISO(), me, site: data.site,
    clients: data.clients.map((c) => clientForAdmin(c, full)).sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true })),
    books: [], privates: [], leads: [], payments: [], docs: [], accounts: []
  };
  if (has(me, "planView") || has(me, "suivi")) st.books = data.books;
  if (canSeePriv(me)) st.privates = data.privates;
  else if (has(me, "planView")) st.privates = data.privates.map((p) => privOut(p, false));
  if (has(me, "channels")) st.leads = data.leads;
  if (has(me, "pay")) st.payments = data.payments.map(payOut);
  if (has(me, "suivi")) st.docs = data.docs.map(docOut);
  if (me.role === "admin") st.accounts = data.accts.map((a) => { const o = stripCred(a); return o; });
  return st;
}
const payPaid = (p) => Math.round((p.entries || []).reduce((s, e) => s + (Number(e.amount) || 0), 0) * 100) / 100;
const payOut = (p) => ({ ...p, paid: payPaid(p) });

/* ---------- séances (books = canaux, privates = autres clients) ---------- */
async function createSessions(env, me, coll, body) {
  need(me, "planEdit");
  obj(body);
  const data = await loadAll(env);
  const base = cleanSessionBase(coll, obj(body.base, "base"), data);
  const dates = arr(body.dates, 400, "dates").map((d) => date(d, "date"));
  if (!dates.length) throw bad("aucune date");
  if (new Set(dates).size !== dates.length) throw bad("dates en double");
  const force = body.force === true;
  if (force) needAdmin(me);
  if (base.status === "vise" && !force) {
    const conf = findConflicts(occupancy(data), dates.map((d) => ({ date: d, slot: base.slot, space: base.space })));
    if (conf.length) throw conflictError(conf);
  }
  const series = body.series === true && dates.length > 1 ? rid("s") : "";
  const pcode = coll === "privates" ? "PRV-" + randDigits(4) : "";
  const now = nowISO();
  const recs = dates.map((d) => {
    const r = { id: rid(coll === "books" ? "b" : "p"), ...base, date: d, motif: "", by: me.user, created: now, rev: 1 };
    if (series) r.seriesId = series;
    if (pcode) r.code = pcode;
    return r;
  });
  await inChunks(recs, 25, (r) => putRec(env, PREFIX[coll] + r.id, r));
  const rev = await touch(env);
  return { ok: true, records: recs, rev };
}
async function updateSessions(env, me, coll, body) {
  need(me, "planEdit");
  obj(body);
  const data = await loadAll(env);
  const base = cleanSessionBase(coll, obj(body.base, "base"), data);
  if (coll === "privates" && !canSeePriv(me)) delete base.phone; // ne jamais effacer un numéro que ce compte ne voit pas
  const updates = arr(body.updates, 400, "updates").map((u) => ({ id: str(obj(u, "update").id, 60, { required: true, name: "id" }), date: date(u.date, "date") }));
  if (!updates.length) throw bad("aucune séance");
  const ids = new Set(updates.map((u) => u.id));
  const force = body.force === true;
  if (force) needAdmin(me);
  const cur = [];
  for (const u of updates) {
    const rec = await getRec(env, PREFIX[coll] + u.id);
    if (!rec) throw notFound("séance");
    cur.push({ rec, date: u.date });
  }
  if (base.status === "vise" && !force) {
    const conf = findConflicts(occupancy(data), cur.map((c) => ({ date: c.date, slot: base.slot, space: base.space })), ids);
    if (conf.length) throw conflictError(conf);
  }
  const out = cur.map(({ rec, date: d }) => {
    const r = bump({ ...rec, ...base, date: d, by: me.user });
    if (rec.status !== base.status) r.motif = "";
    if (coll === "privates" && !canSeePriv(me)) { /* phone/code conservés */ }
    return r;
  });
  await inChunks(out, 25, (r) => putRec(env, PREFIX[coll] + r.id, r));
  const rev = await touch(env);
  return { ok: true, records: out.map((r) => (coll === "privates" ? privOut(r, canSeePriv(me)) : r)), rev };
}
async function deleteSessions(env, me, coll, body) {
  need(me, "planEdit");
  obj(body);
  const ids = arr(body.ids, 400, "ids").map((i) => str(i, 60, { required: true, name: "id" }));
  await inChunks(ids, 25, (id) => delKey(env, PREFIX[coll] + id));
  const rev = await touch(env);
  return { ok: true, deleted: ids, rev };
}
async function setStatus(env, me, coll, id, body) {
  if (coll === "books") need(me, "planEdit");
  else if (!(has(me, "others") || has(me, "planEdit"))) need(me, "others");
  obj(body);
  const status = oneOf(body.status, ["vise", "refuse", "attente"], "statut");
  const motif = status === "refuse" ? str(body.motif, 200, { name: "motif" }) : "";
  const rec = await getRec(env, PREFIX[coll] + id);
  if (!rec) throw notFound("demande");
  if (status === "vise") {
    const force = body.force === true;
    if (force) needAdmin(me);
    if (!force) {
      const data = await loadAll(env);
      const conf = findConflicts(occupancy(data), [rec], new Set([rec.id]));
      if (conf.length) throw conflictError(conf);
    }
  }
  const out = bump({ ...rec, status, motif, by: me.user });
  await putRec(env, PREFIX[coll] + id, out);
  const rev = await touch(env);
  return { ok: true, record: coll === "privates" ? privOut(out, canSeePriv(me)) : out, rev };
}

/* ---------- canaux (clients) ---------- */
async function uniqueCode(data, c) {
  if (data.clients.some((x) => String(x.code).toUpperCase() === c)) throw new HttpError(409, "code_taken", "Ce code de canal existe déjà.");
}
async function createClient(env, me, body) {
  need(me, "channels");
  obj(body);
  const data = await loadAll(env);
  const c = cleanCode(body.code);
  await uniqueCode(data, c);
  const rec = {
    id: rid("c"), type: oneOf(body.type, TYPES, "type"), name: str(body.name, 80, { required: true, name: "nom" }), code: c,
    kind: "", contrat: false, contact: str(body.contact, 80, { name: "contact" }), phone: str(body.phone, 30, { name: "téléphone" }),
    active: true, cred: await hashSecret(cleanPin(body.pin)), created: nowISO(), rev: 1
  };
  await putRec(env, "client:" + rec.id, rec);
  const rev = await touch(env);
  return { ok: true, client: clientForAdmin(rec, true), rev };
}
async function updateClient(env, me, id, body) {
  need(me, "channels");
  obj(body);
  const cur = await getRec(env, "client:" + id);
  if (!cur) throw notFound("canal");
  checkRev(cur, body);
  const next = { ...cur };
  if (body.pin !== undefined) next.cred = await hashSecret(cleanPin(body.pin));
  if (body.active !== undefined) next.active = bool(body.active, "active");
  if (body.name !== undefined) next.name = str(body.name, 80, { required: true, name: "nom" });
  if (body.type !== undefined) next.type = oneOf(body.type, TYPES, "type");
  if (body.contact !== undefined) next.contact = str(body.contact, 80, { name: "contact" });
  if (body.phone !== undefined) next.phone = str(body.phone, 30, { name: "téléphone" });
  const out = bump(next);
  await putRec(env, "client:" + id, out);
  const rev = await touch(env);
  return { ok: true, client: clientForAdmin(out, true), rev };
}
async function openLead(env, me, id) {
  need(me, "channels");
  const lead = await getRec(env, "lead:" + id);
  if (!lead) throw notFound("demande d'ouverture");
  const data = await loadAll(env);
  const prefix = lead.type === "federation" ? "FED-" : lead.type === "ligue" ? "LIG-" : lead.type === "prive" ? "PRV-" : lead.type === "ecole" ? "GS-" : "CLB-";
  let c;
  do { c = prefix + randDigits(4); } while (data.clients.some((x) => String(x.code).toUpperCase() === c));
  const pin = randDigits(6);
  const rec = {
    id: rid("c"), type: TYPES.includes(lead.type) ? lead.type : "club", name: str(lead.org, 80, { name: "nom" }) || "Sans nom", code: c, kind: "", contrat: false,
    contact: str(lead.contact, 80, { name: "contact" }), phone: str(lead.phone, 30, { name: "téléphone" }), active: true,
    cred: await hashSecret(pin), created: nowISO(), rev: 1
  };
  await putRec(env, "client:" + rec.id, rec);
  await delKey(env, "lead:" + id);
  const rev = await touch(env);
  return { ok: true, client: clientForAdmin(rec, true), code: c, pin, deleted: id, rev };
}
async function deleteLead(env, me, id) {
  need(me, "channels");
  await delKey(env, "lead:" + id);
  const rev = await touch(env);
  return { ok: true, deleted: id, rev };
}

/* ---------- paiements ---------- */
function cleanEntry(e, name = "versement") {
  obj(e, name);
  return {
    id: str(e.id, 60, { name: "id" }) || rid("e"), date: date(e.date, "date du versement", { optional: true }) || todayISO(0),
    amount: money(e.amount, "montant"), method: str(e.method, 40, { name: "mode" }), note: str(e.note, 200, { name: "note" })
  };
}
function clientExists(data, id) {
  const cid = str(id, 40, { required: true, name: "client" });
  if (!data.clients.some((c) => c.id === cid)) throw bad("client inconnu");
  return cid;
}
async function createPayment(env, me, body) {
  need(me, "pay");
  obj(body);
  const data = await loadAll(env);
  const due = money(body.due, "dû");
  const paid = Math.min(due, money(body.paid === undefined || body.paid === "" ? 0 : body.paid, "payé"));
  const id = rid("p");
  const method = str(body.method, 40, { name: "mode" });
  const rec = {
    id, clientId: clientExists(data, body.clientId), label: str(body.label, 120, { required: true, name: "motif" }), due,
    date: date(body.date, "échéance", { optional: true }), method,
    entries: paid > 0 ? [{ id: id + "-e0", date: todayISO(0), amount: paid, method, note: "", by: me.user }] : [], created: nowISO(), rev: 1
  };
  await putRec(env, "payment:" + id, rec);
  const rev = await touch(env);
  return { ok: true, payment: payOut(rec), rev };
}
async function updatePayment(env, me, id, body) {
  need(me, "pay");
  obj(body);
  const cur = await getRec(env, "payment:" + id);
  if (!cur) throw notFound("paiement");
  checkRev(cur, body);
  const data = await loadAll(env);
  const next = { ...cur };
  if (body.clientId !== undefined) next.clientId = clientExists(data, body.clientId);
  if (body.label !== undefined) next.label = str(body.label, 120, { required: true, name: "motif" });
  if (body.due !== undefined) next.due = money(body.due, "dû");
  if (body.date !== undefined) next.date = date(body.date, "échéance", { optional: true });
  const out = bump(next);
  await putRec(env, "payment:" + id, out);
  const rev = await touch(env);
  return { ok: true, payment: payOut(out), rev };
}
async function deletePayment(env, me, id) {
  need(me, "pay");
  await delKey(env, "payment:" + id);
  const rev = await touch(env);
  return { ok: true, deleted: id, rev };
}
async function addEntry(env, me, id, body) {
  need(me, "pay");
  const cur = await getRec(env, "payment:" + id);
  if (!cur) throw notFound("paiement");
  const e = cleanEntry({ ...obj(body), id: undefined });
  if (e.amount <= 0) throw bad("montant invalide");
  const rest = Math.max(0, Math.round((cur.due - payPaid(cur)) * 100) / 100);
  const capped = e.amount > rest;
  if (rest <= 0) throw new HttpError(409, "settled", "Ce paiement est déjà soldé.");
  if (capped) e.amount = rest;
  const next = bump({ ...cur, entries: [...(cur.entries || []), { ...e, by: me.user }], method: e.method || cur.method });
  await putRec(env, "payment:" + id, next);
  const rev = await touch(env);
  return { ok: true, payment: payOut(next), capped, rev };
}
async function deleteEntry(env, me, id, eid) {
  need(me, "pay");
  const cur = await getRec(env, "payment:" + id);
  if (!cur) throw notFound("paiement");
  const next = bump({ ...cur, entries: (cur.entries || []).filter((e) => e.id !== eid) });
  await putRec(env, "payment:" + id, next);
  const rev = await touch(env);
  return { ok: true, payment: payOut(next), rev };
}

/* ---------- documents (suivi clients) ---------- */
function cleanFile(f) {
  obj(f, "fichier");
  const data = typeof f.data === "string" ? f.data : "";
  if (data.length > MAX_FILE_DATA) throw bad("fichier trop lourd (1,5 Mo maximum)", { field: "file" });
  const m = /^data:([A-Za-z0-9.+\/-]{0,100});base64,[A-Za-z0-9+\/]+={0,2}$/.exec(data);
  if (!m) throw bad("fichier invalide");
  const mime = MIME_OK.includes(m[1]) ? m[1] : "application/octet-stream";
  const approx = Math.floor((data.length - data.indexOf(",") - 1) * 3 / 4);
  return { meta: { name: str(f.name, 200, { name: "nom du fichier" }) || "document", mime, size: approx }, data: "data:" + mime + ";base64," + data.slice(data.indexOf(",") + 1) };
}
async function createDoc(env, me, body) {
  need(me, "suivi");
  obj(body);
  const data = await loadAll(env);
  const id = rid("d");
  const f = body.file ? cleanFile(body.file) : null;
  const rec = {
    id, clientId: clientExists(data, body.clientId), type: oneOf(body.type, DOC_TYPES, "type"), name: str(body.name, 120, { required: true, name: "intitulé" }),
    date: date(body.date, "date", { optional: true }), expiry: date(body.expiry, "expiration", { optional: true }), status: oneOf(body.status, DOC_STATUS, "statut"),
    note: str(body.note, 300, { name: "note" }), file: f ? f.meta : null, created: nowISO(), rev: 1
  };
  if (f) await kv(env).put("docfile:" + id, f.data);
  await putRec(env, "doc:" + id, rec);
  const rev = await touch(env);
  return { ok: true, doc: rec, rev };
}
async function updateDoc(env, me, id, body) {
  need(me, "suivi");
  obj(body);
  const cur = await getRec(env, "doc:" + id);
  if (!cur) throw notFound("document");
  checkRev(cur, body);
  const next = { ...cur };
  if (body.name !== undefined) next.name = str(body.name, 120, { name: "intitulé" });
  if (body.type !== undefined) next.type = oneOf(body.type, DOC_TYPES, "type");
  if (body.status !== undefined) next.status = oneOf(body.status, DOC_STATUS, "statut");
  if (body.date !== undefined) next.date = date(body.date, "date", { optional: true });
  if (body.expiry !== undefined) next.expiry = date(body.expiry, "expiration", { optional: true });
  if (body.note !== undefined) next.note = str(body.note, 300, { name: "note" });
  if (body.file) {
    const f = cleanFile(body.file);
    await kv(env).put("docfile:" + id, f.data);
    next.file = f.meta;
  } else if (body.removeFile === true) {
    await delKey(env, "docfile:" + id);
    next.file = null;
  }
  const out = bump(next);
  await putRec(env, "doc:" + id, out);
  const rev = await touch(env);
  return { ok: true, doc: out, rev };
}
async function deleteDoc(env, me, id) {
  need(me, "suivi");
  await delKey(env, "doc:" + id);
  await delKey(env, "docfile:" + id);
  const rev = await touch(env);
  return { ok: true, deleted: id, rev };
}
async function getDocFile(env, me, id) {
  need(me, "suivi");
  const doc = await getRec(env, "doc:" + id);
  if (!doc || !doc.file) throw notFound("fichier");
  const data = await kv(env).get("docfile:" + id);
  if (!data) throw notFound("fichier");
  return { name: doc.file.name, mime: doc.file.mime, data };
}

/* ---------- site ---------- */
async function putSite(env, me, body) {
  need(me, "site");
  obj(body);
  const cur = await getRec(env, "site");
  if (!cur) throw notFound("site");
  if (body.rev !== cur.rev) throw stale();
  const clean = cleanSite(body.site);
  const out = { ...clean, rev: cur.rev + 1, updated: nowISO(), by: me.user };
  await putRec(env, "site", out);
  const rev = await touch(env);
  return { ok: true, site: out, rev };
}

/* ---------- comptes de gestion ---------- */
function cleanPerms(v) {
  const ps = arr(v, 20, "droits").map((p) => oneOf(p, PERMS, "droit"));
  return Array.from(new Set(ps));
}
function cleanUser(v) {
  const u = str(v, 32, { required: true, name: "identifiant" }).toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(u)) throw bad("identifiant : 3 à 32 caractères (minuscules, chiffres, . _ -)", { field: "user" });
  return u;
}
async function createAccount(env, me, body) {
  needAdmin(me);
  obj(body);
  const user = cleanUser(body.user);
  if (user === ADMIN_USER || (await getRec(env, "acct:" + user))) throw new HttpError(409, "user_taken", "Cet identifiant existe déjà ou est réservé.");
  const rec = {
    id: rid("a"), user, name: str(body.name, 80, { name: "nom" }), role: "staff", perms: cleanPerms(body.perms || []),
    active: body.active === undefined ? true : bool(body.active, "actif"), cred: await hashSecret(cleanPassword(body.password)), created: nowISO(), rev: 1
  };
  await putRec(env, "acct:" + user, rec);
  const rev = await touch(env);
  return { ok: true, account: stripCred(rec), rev };
}
async function findAcctById(env, id) {
  const data = await loadAll(env);
  const a = data.accts.find((x) => x.id === id);
  if (!a) throw notFound("compte");
  return (await getRec(env, "acct:" + a.user)) || a;
}
async function updateAccount(env, me, id, body) {
  needAdmin(me);
  obj(body);
  const cur = await findAcctById(env, id);
  if (cur.role === "admin") throw new HttpError(403, "admin_protected", "Le compte administrateur ne peut pas être modifié ici.");
  checkRev(cur, body);
  const next = { ...cur };
  if (body.name !== undefined) next.name = str(body.name, 80, { name: "nom" });
  if (body.perms !== undefined) next.perms = cleanPerms(body.perms);
  if (body.active !== undefined) next.active = bool(body.active, "actif");
  if (body.password) next.cred = await hashSecret(cleanPassword(body.password));
  let user = cur.user;
  if (body.user !== undefined) {
    user = cleanUser(body.user);
    if (user !== cur.user && (user === ADMIN_USER || (await getRec(env, "acct:" + user)))) throw new HttpError(409, "user_taken", "Cet identifiant existe déjà ou est réservé.");
  }
  next.user = user;
  const out = bump(next);
  await putRec(env, "acct:" + user, out);
  if (user !== cur.user) await delKey(env, "acct:" + cur.user);
  const rev = await touch(env);
  return { ok: true, account: stripCred(out), previousUser: cur.user, rev };
}
async function deleteAccount(env, me, id) {
  needAdmin(me);
  const cur = await findAcctById(env, id);
  if (cur.role === "admin" || cur.user === ADMIN_USER) throw new HttpError(403, "admin_protected", "Le compte administrateur ne peut pas être supprimé.");
  await delKey(env, "acct:" + cur.user);
  const rev = await touch(env);
  return { ok: true, deleted: id, rev };
}
async function changeOwnPassword(env, request, me, acct, body) {
  if (me.role !== "admin") need(me, "accounts");
  obj(body);
  const key = "pw:" + acct.user;
  await rlCheck(env, key, 5);
  if (!(await verifySecret(String(body.current == null ? "" : body.current), acct.cred))) {
    await rlHit(env, key, WINDOW);
    throw new HttpError(401, "bad_credentials", "Mot de passe actuel incorrect.");
  }
  await rlClear(env, key);
  const fresh = (await getRec(env, "acct:" + acct.user)) || acct;
  const out = bump({ ...fresh, cred: await hashSecret(cleanPassword(body.password)) });
  await putRec(env, "acct:" + acct.user, out);
  const rev = await touch(env);
  const { token, exp } = await issueAdminToken(env, out); // l'ancien jeton devient invalide
  return { ok: true, token, exp, rev };
}

/* ---------- exports CSV : données fraîches + droits « export » + droit du module ---------- */
async function exportPayments(env, me) {
  need(me, "export"); need(me, "pay");
  const data = await loadAll(env);
  return { payments: data.payments.map(payOut), clients: data.clients.map((c) => clientForAdmin(c, false)), serverTime: nowISO() };
}
async function exportPlanning(env, me, url) {
  need(me, "export"); need(me, "planView");
  const from = url.searchParams.get("from") || "", to = url.searchParams.get("to") || "";
  if ((from && !isDate(from)) || (to && !isDate(to))) throw bad("période invalide");
  const data = await loadAll(env);
  const full = canSeePriv(me);
  const inRange = (x) => (x.status === "vise" || x.status === "attente") && (!from || x.date >= from) && (!to || x.date <= to);
  return {
    books: data.books.filter(inRange), privates: data.privates.filter(inRange).map((p) => privOut(p, full)),
    clients: data.clients.map((c) => clientForAdmin(c, false)), serverTime: nowISO()
  };
}

/* ---------- import des anciennes données localStorage (admin) ---------- */
function normDate(d) {
  const s = String(d || "").trim();
  if (isDate(s)) return s;
  let m = s.match(/^(\d{4}-\d{2}-\d{2})T/); if (m && isDate(m[1])) return m[1];
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) { const x = m[3] + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0"); if (isDate(x)) return x; }
  return "";
}
function normSlot(s) {
  const v = String(s || "").trim().replace(/\s+/g, "").replace(/[-\u2010-\u2015\u2212]/g, "\u2013");
  if (SLOTS.includes(v)) return v;
  return SLOTS.find((x) => x.slice(0, 5) === v.slice(0, 5)) || "";
}
const soft = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, max);
const normStatus = (st) => {
  const s = String(st || "").toLowerCase();
  if (["vise", "valide", "validé", "visé", "ok", "accepte", "accepté"].includes(s)) return "vise";
  if (s === "refuse" || s === "refusé") return "refuse";
  return "attente";
};
async function importLegacy(env, me, body) {
  needAdmin(me);
  obj(body);
  const data = await loadAll(env);
  const stats = { clients: 0, books: 0, privates: 0, leads: 0, payments: 0, docs: 0, skipped: 0, downgraded: 0, site: false };
  const total = ["clients", "books", "privates", "leads", "payments", "docs"].reduce((n, k) => n + (Array.isArray(body[k]) ? body[k].length : 0), 0);
  if (total > 450) throw bad("trop d'éléments dans un seul envoi (450 maximum)");
  const list = (k) => (Array.isArray(body[k]) ? body[k].filter((x) => x && typeof x === "object") : []);
  const writes = [];
  const put = (key, rec) => writes.push([key, rec]);
  const spaces = data.site.spaces.map((s) => s.id), discs = data.site.disciplines.map((s) => s.id);
  const map = { ...(body.clientMap && typeof body.clientMap === "object" ? body.clientMap : {}) };
  const clients = data.clients.slice();
  let newClients = 0;
  for (const c of list("clients")) {
    const codeRaw = soft(c.code, 32).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{1,31}$/.test(codeRaw)) { stats.skipped++; continue; }
    const ex = clients.find((x) => String(x.code).toUpperCase() === codeRaw);
    if (ex) { if (c.id) map[String(c.id)] = ex.id; continue; }
    if (++newClients > 30) throw bad("trop de nouveaux canaux dans un seul envoi (30 maximum)");
    let id = soft(c.id, 40);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id) || clients.some((x) => x.id === id)) id = rid("c");
    let p = soft(c.pin, 32);
    if (p.length < 4 || /\s/.test(p)) p = randDigits(6);
    const rec = {
      id, type: TYPES.includes(c.type) ? c.type : "club", name: soft(c.name, 80) || codeRaw, code: codeRaw, kind: "", contrat: false,
      contact: soft(c.contact, 80), phone: soft(c.phone, 30), active: c.active !== false, cred: await hashSecret(p), created: nowISO(), rev: 1, imported: true
    };
    clients.push(rec); put("client:" + id, rec); map[String(c.id || id)] = id; stats.clients++;
  }
  const mapC = (id) => { id = String(id || ""); return map[id] || (clients.some((x) => x.id === id) ? id : ""); };
  const occ = occupancy(data);
  const occKey = (x) => x.date + "|" + x.slot + "|" + x.space;
  const claim = (x, coll) => {
    if (x.status !== "vise") return;
    if ((occ.get(occKey(x)) || []).length) { x.status = "attente"; x.note = (x.note ? x.note + " · " : "") + "conflit à l'import"; x.note = x.note.slice(0, 200); stats.downgraded++; return; }
    occ.set(occKey(x), [{ coll, id: x.id, who: "" }]);
  };
  const common = (x) => {
    const d = normDate(x.date), slot = normSlot(x.slot);
    if (!d || !slot) return null;
    return {
      date: d, slot, space: spaces.includes(x.space) ? x.space : spaces[0], disc: discs.includes(x.disc) ? x.disc : discs[0],
      people: Math.min(5000, Math.max(1, parseInt(x.people, 10) || 1)), note: soft(x.note, 200), status: normStatus(x.status), motif: soft(x.motif, 200)
    };
  };
  const newId = (x, prefix, existing) => {
    const id = soft(x.id, 60);
    return /^[A-Za-z0-9._-]{1,60}$/.test(id) && !existing.some((e) => e.id === id) ? id : null;
  };
  const sameId = (x, existing) => existing.some((e) => e.id === soft(x.id, 60));
  const bookSeen = data.books.slice(), privSeen = data.privates.slice();
  for (const x of list("books")) {
    const cid = mapC(x.clientId), cm = common(x);
    if (!cid || !cm || sameId(x, bookSeen) || bookSeen.some((b) => b.clientId === cid && b.date === cm.date && b.slot === cm.slot && b.space === cm.space)) { stats.skipped++; continue; }
    const rec = { id: newId(x, "b", bookSeen) || rid("b"), clientId: cid, ...cm, by: soft(x.by, 40), created: soft(x.created, 40) || nowISO(), rev: 1, imported: true };
    if (/^[A-Za-z0-9]{1,30}$/.test(soft(x.seriesId, 30))) rec.seriesId = soft(x.seriesId, 30);
    claim(rec, "books"); bookSeen.push(rec); put("book:" + rec.id, rec); stats.books++;
  }
  for (const x of list("privates")) {
    const cm = common(x), name = soft(x.name, 80), ph = soft(x.phone, 30);
    if (!cm || !name || sameId(x, privSeen) || privSeen.some((p) => digits(p.phone) === digits(ph) && p.date === cm.date && p.slot === cm.slot && p.space === cm.space && String(p.name).toLowerCase() === name.toLowerCase())) { stats.skipped++; continue; }
    let c = soft(x.code, 20).toUpperCase();
    if (!/^[A-Z0-9-]{3,20}$/.test(c)) c = "PRV-" + randDigits(4);
    const rec = { id: newId(x, "p", privSeen) || rid("p"), code: c, name, phone: ph, ...cm, by: soft(x.by, 40), created: soft(x.created, 40) || nowISO(), rev: 1, imported: true };
    if (/^[A-Za-z0-9]{1,30}$/.test(soft(x.seriesId, 30))) rec.seriesId = soft(x.seriesId, 30);
    claim(rec, "privates"); privSeen.push(rec); put("private:" + rec.id, rec); stats.privates++;
  }
  const leadSeen = data.leads.slice();
  for (const x of list("leads")) {
    const org = soft(x.org, 120), msg = soft(x.message, 1000);
    if (!org || sameId(x, leadSeen) || leadSeen.some((l) => String(l.org).toLowerCase() === org.toLowerCase() && digits(l.phone) === digits(x.phone) && l.message === msg)) { stats.skipped++; continue; }
    const rec = { id: newId(x, "l", leadSeen) || rid("l"), org, type: TYPES.includes(x.type) ? x.type : "club", contact: soft(x.contact, 80), phone: soft(x.phone, 30), message: msg, created: nowISO(), rev: 1, imported: true };
    leadSeen.push(rec); put("lead:" + rec.id, rec); stats.leads++;
  }
  const paySeen = data.payments.slice();
  for (const x of list("payments")) {
    const cid = mapC(x.clientId);
    if (!cid || sameId(x, paySeen)) { stats.skipped++; continue; }
    const num = (v) => { const n = Number(String(v == null ? "" : v).replace(/\s/g, "").replace(",", ".").replace(/[^\d.\-]/g, "")); return isFinite(n) && n >= 0 && n < 1e10 ? Math.round(n * 100) / 100 : 0; };
    const id = newId(x, "p", paySeen) || rid("p");
    const due = num(x.due != null ? x.due : x.amount);
    let entries = Array.isArray(x.entries) ? x.entries : [];
    if (!entries.length && num(x.paid) > 0) entries = [{ date: x.paidDate || x.date, amount: x.paid, method: x.method }];
    entries = entries.filter((e) => e && num(e.amount) > 0).slice(0, 200).map((e, j) => ({ id: soft(e.id, 60) || id + "-e" + j, date: normDate(e.date) || todayISO(0), amount: num(e.amount), method: soft(e.method, 40), note: soft(e.note, 200), by: soft(e.by, 40) }));
    const rec = { id, clientId: cid, label: soft(x.label, 120), due, date: normDate(x.date), method: soft(x.method, 40), entries, created: nowISO(), rev: 1, imported: true };
    paySeen.push(rec); put("payment:" + id, rec); stats.payments++;
  }
  const docsSeen = data.docs.slice();
  const files = [];
  for (const x of list("docs")) {
    const cid = mapC(x.clientId);
    const type = DOC_TYPES.includes(x.type) ? x.type : "autre";
    if (!cid) { stats.skipped++; continue; }
    let f = null;
    if (x.file && typeof x.file === "object" && x.file.data) { try { f = cleanFile(x.file); } catch (e) { f = null; } }
    const st = DOC_STATUS.includes(x.status) ? x.status : "manquant";
    const name = soft(x.name, 120);
    const id0 = soft(x.id, 60);
    const same = docsSeen.find((d) => d.id === id0) || docsSeen.find((d) => d.clientId === cid && d.type === type && d.name.toLowerCase() === name.toLowerCase() && name);
    const placeholder = (d) => d.status === "manquant" && !d.file && !d.name;
    const rich = f || st !== "manquant" || name;
    const target = same && (placeholder(same) && rich ? same : null) || (!same && rich ? docsSeen.find((d) => d.clientId === cid && d.type === type && placeholder(d)) : null);
    if (same && !target) { stats.skipped++; continue; }
    if (!target && !rich) { stats.skipped++; continue; }
    const base = target || { id: newId(x, "d", docsSeen) || rid("d"), clientId: cid, created: nowISO(), rev: 0 };
    const rec = { ...base, clientId: cid, type, name, date: normDate(x.date), expiry: normDate(x.expiry), status: st, note: soft(x.note, 300), file: f ? f.meta : (target ? target.file : null), rev: (base.rev || 0) + 1, imported: true };
    if (f) files.push(["docfile:" + rec.id, f.data]);
    if (target) docsSeen[docsSeen.indexOf(target)] = rec; else docsSeen.push(rec);
    put("doc:" + rec.id, rec); stats.docs++;
  }
  if (body.site && typeof body.site === "object" && data.site.rev === 1) {
    try { const s = cleanSite(body.site); put("site", { ...s, rev: 2, updated: nowISO(), by: me.user }); stats.site = true; } catch (e) { /* site ignoré s'il est invalide */ }
  }
  await inChunks(files, 5, ([k, v]) => kv(env).put(k, v));
  await inChunks(writes, 25, ([k, r]) => putRec(env, k, r));
  const rev = await touch(env);
  return { ok: true, stats, clientMap: map, rev };
}

/* ---------- routeur admin ---------- */
export async function adminRoute(env, request, method, segs, url, readBody) {
  const [a, b, c, d] = segs;
  if (a === "login" && method === "POST" && !b) return adminLogin(env, request, await readBody());
  const { acct, me } = await requireAdmin(request, env);
  const SESS = (coll) => {
    if (!b && method === "POST") return async () => createSessions(env, me, coll, await readBody());
    if (!b && method === "PUT") return async () => updateSessions(env, me, coll, await readBody());
    if (b === "delete" && !c && method === "POST") return async () => deleteSessions(env, me, coll, await readBody());
    if (b && c === "status" && !d && method === "POST") return async () => setStatus(env, me, coll, b, await readBody());
    return null;
  };
  let h = null;
  if (a === "rev" && method === "GET" && !b) h = async () => ({ rev: await getRev(env) });
  else if (a === "me" && !b && method === "GET") h = async () => ({ me });
  else if (a === "state" && !b && method === "GET") h = () => buildState(env, me);
  else if (a === "books") h = SESS("books");
  else if (a === "privates") h = SESS("privates");
  else if (a === "clients") {
    if (!b && method === "POST") h = async () => createClient(env, me, await readBody());
    else if (b && !c && method === "PUT") h = async () => updateClient(env, me, b, await readBody());
  } else if (a === "leads") {
    if (b && c === "open" && method === "POST") h = () => openLead(env, me, b);
    else if (b && !c && method === "DELETE") h = () => deleteLead(env, me, b);
  } else if (a === "payments") {
    if (!b && method === "POST") h = async () => createPayment(env, me, await readBody());
    else if (b && !c && method === "PUT") h = async () => updatePayment(env, me, b, await readBody());
    else if (b && !c && method === "DELETE") h = () => deletePayment(env, me, b);
    else if (b && c === "entries" && !d && method === "POST") h = async () => addEntry(env, me, b, await readBody());
    else if (b && c === "entries" && d && method === "DELETE") h = () => deleteEntry(env, me, b, d);
  } else if (a === "docs") {
    if (!b && method === "POST") h = async () => createDoc(env, me, await readBody());
    else if (b && !c && method === "PUT") h = async () => updateDoc(env, me, b, await readBody());
    else if (b && !c && method === "DELETE") h = () => deleteDoc(env, me, b);
    else if (b && c === "file" && !d && method === "GET") h = () => getDocFile(env, me, b);
  } else if (a === "site" && !b && method === "PUT") h = async () => putSite(env, me, await readBody());
  else if (a === "accounts") {
    if (!b && method === "POST") h = async () => createAccount(env, me, await readBody());
    else if (b && !c && method === "PUT") h = async () => updateAccount(env, me, b, await readBody());
    else if (b && !c && method === "DELETE") h = () => deleteAccount(env, me, b);
  } else if (a === "password" && !b && method === "POST") h = async () => changeOwnPassword(env, request, me, acct, await readBody());
  else if (a === "export" && b === "payments" && !c && method === "GET") h = () => exportPayments(env, me);
  else if (a === "export" && b === "planning" && !c && method === "GET") h = () => exportPlanning(env, me, url);
  else if (a === "import" && !b && method === "POST") h = async () => importLegacy(env, me, await readBody());
  if (!h) throw new HttpError(404, "not_found", "Route inconnue.");
  return h();
}
