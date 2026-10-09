// Règles métier partagées : site, conflits de créneaux, formes de sortie (sans secrets).
import { HttpError, bad, str, obj, arr, bool, oneOf, int, date, slotOf, phone, SLOTS, STATUSES } from "./util.js";

const LANGS = ["fr", "ar", "en"];
const HERO_KEYS = { kicker: [200, false], h1: [300, false], lead: [1200, true], discTitle: [120, false], discSub: [600, true], spacesTitle: [120, false], spacesSub: [600, true], address: [600, true], hours: [100, false] };

function cleanItem(it, list) {
  obj(it, list);
  const id = str(it.id, 32, { required: true, name: "id" });
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw bad(list + " : identifiant invalide");
  const out = { id, on: bool(it.on, list + ".on") };
  for (const l of LANGS) {
    const x = obj(it[l] || {}, list + "." + l);
    out[l] = { t: str(x.t, 120, { name: "titre" }), p: str(x.p, 600, { name: "texte", multiline: true }) };
  }
  return out;
}
function cleanList(v, name) {
  const items = arr(v, 60, name).map((it) => cleanItem(it, name));
  if (new Set(items.map((i) => i.id)).size !== items.length) throw bad(name + " : identifiants en double");
  return items;
}
/** Valide et normalise tout le contenu éditable du site (liste blanche des champs). */
export function cleanSite(s) {
  obj(s, "site");
  const hero = {}, announce = {};
  obj(s.hero, "hero"); obj(s.announce, "announce");
  for (const l of LANGS) {
    const h = obj(s.hero[l] || {}, "hero." + l);
    hero[l] = {};
    for (const [k, [max, ml]] of Object.entries(HERO_KEYS)) hero[l][k] = str(h[k], max, { name: k, multiline: ml });
    announce[l] = str(s.announce[l], 600, { name: "annonce", multiline: true });
  }
  return {
    phone: str(s.phone, 40, { name: "téléphone" }),
    announceOn: bool(s.announceOn, "announceOn"), announce, hero,
    showDisc: bool(s.showDisc, "showDisc"), showSpaces: bool(s.showSpaces, "showSpaces"),
    showChannels: bool(s.showChannels, "showChannels"), showAutres: bool(s.showAutres, "showAutres"),
    disciplines: cleanList(s.disciplines, "disciplines"), spaces: cleanList(s.spaces, "spaces"), blocs: cleanList(s.blocs || [], "blocs")
  };
}
export function publicSite(site) {
  const { rev, updated, ...rest } = site || {};
  return rest;
}

/* ---------- formes de sortie ---------- */
export const stripCred = (rec) => { const { cred, ...rest } = rec; return rest; };
export function clientForAdmin(c, full) {
  const o = { id: c.id, type: c.type, name: c.name, code: c.code, active: c.active, contrat: !!c.contrat, rev: c.rev };
  if (full) { o.contact = c.contact || ""; o.phone = c.phone || ""; o.kind = c.kind || ""; }
  return o;
}
export function clientBookOut(b) {
  return { id: b.id, date: b.date, slot: b.slot, space: b.space, disc: b.disc, people: b.people, note: b.note || "", status: b.status, motif: b.motif || "", created: b.created };
}

/* ---------- conflits : même date + créneau + espace, déjà visé ---------- */
export function occupancy(data) {
  const map = new Map();
  const clientName = new Map(data.clients.map((c) => [c.id, c.name]));
  const add = (coll, x) => {
    if (x.status !== "vise") return;
    const k = x.date + "|" + x.slot + "|" + x.space;
    const list = map.get(k) || [];
    list.push({ coll, id: x.id, who: coll === "books" ? clientName.get(x.clientId) || "" : x.name || "" });
    map.set(k, list);
  };
  data.books.forEach((x) => add("books", x));
  data.privates.forEach((x) => add("privates", x));
  return map;
}
export function findConflicts(occ, items, ignore) {
  const out = [];
  for (const it of items) {
    const hit = (occ.get(it.date + "|" + it.slot + "|" + it.space) || []).find((h) => !(ignore && ignore.has(h.id)));
    if (hit) out.push({ date: it.date, slot: it.slot, space: it.space, who: hit.who });
  }
  return out;
}
export function conflictError(conflicts) {
  return new HttpError(409, "conflict", "Créneau déjà visé pour cet espace.", { conflicts: conflicts.slice(0, 400) });
}

/* ---------- champs communs d'une séance (admin) ---------- */
export function cleanSessionBase(coll, b, data, { partialPhone = false } = {}) {
  obj(b, "base");
  const ids = (list) => list.map((x) => x.id);
  const space = str(b.space, 32, { required: true, name: "espace" });
  if (!ids(data.site.spaces).includes(space)) throw bad("espace inconnu");
  const disc = str(b.disc, 32, { required: true, name: "discipline" });
  if (!ids(data.site.disciplines).includes(disc)) throw bad("discipline inconnue");
  const out = {
    slot: slotOf(b.slot), space, disc,
    people: int(b.people, 1, 5000, "effectif"),
    note: str(b.note, 200, { name: "note" }),
    status: oneOf(b.status, ["vise", "attente"], "statut")
  };
  if (coll === "books") {
    const clientId = str(b.clientId, 40, { required: true, name: "canal" });
    if (!data.clients.some((c) => c.id === clientId)) throw bad("canal inconnu");
    out.clientId = clientId;
  } else {
    out.name = str(b.name, 80, { required: true, name: "nom" });
    if (!partialPhone) out.phone = phone(b.phone, { required: false });
  }
  return out;
}
export { SLOTS, STATUSES, date };
