// Données initiales : une seule fois si D1 vide (meta.seeded absent ET pas de site).
// PIN / mot de passe seed hachés (PBKDF2) avant écriture. Ne jamais ré-écraser une migration.
import { SEED_SITE } from "./seed-site.js";
import { hashSecret, nowISO, ADMIN_USER } from "./util.js";
import { getMeta, setMeta, putRec, getRec, inChunks, touch, db } from "./store.js";

const SEED_PIN = "2026";
const SEED_ADMIN_PASSWORD = "yasse2026";
const CONTRAT = [
  { type: "ecole", kind: "Groupe scolaire", name: "El Wouroud", code: "GS-ELWOUROUD" },
  { type: "ecole", kind: "Groupe scolaire", name: "Sabil El Nadjah", code: "GS-SABIL" },
  { type: "ecole", kind: "Groupe scolaire", name: "Ennour", code: "GS-ENNOUR" },
  { type: "ecole", kind: "Groupe scolaire", name: "El Alam Essaghir", code: "GS-ALAM" },
  { type: "club", kind: "C.S.A", name: "AOAH", code: "CSA-AOAH" },
  { type: "club", kind: "C.S.A", name: "F.B.B.", code: "CSA-FBB" },
  { type: "club", kind: "C.S.A", name: "J.S.M.", code: "CSA-JSM" },
  { type: "club", kind: "C.S.A", name: "Art El Marsa", code: "CSA-MARS" },
  { type: "club", kind: "C.S.A", name: "A.R.B.B.", code: "CSA-ARBB" },
  { type: "club", kind: "C.S.A", name: "CRAP-BEB", code: "CSA-CRAP" },
  { type: "club", kind: "C.S.A", name: "M.B.B.", code: "CSA-MBB" },
  { type: "club", kind: "C.S.A", name: "N.R.B.B.", code: "CSA-NRBB" },
  { type: "club", kind: "C.S.A", name: "AAS", code: "CSA-AAS" },
  { type: "club", kind: "C.S.A", name: "ABB", code: "CSA-ABB" }
];
const DOC_BASE = ["demande", "agrement", "assurance", "convprev", "convention", "statuts", "entrainement"];

let seededMemo = false;
export async function ensureSeed(env) {
  if (seededMemo) return;
  if (await getMeta(env, "seeded")) { seededMemo = true; return; }
  // Déjà migré / peuplé sans flag : ne pas écraser.
  const existing = await db(env).prepare("SELECT id FROM site WHERE id = 'site'").first();
  if (existing) {
    await setMeta(env, "seeded", nowISO());
    seededMemo = true;
    return;
  }
  const now = nowISO();
  const pinCred = await hashSecret(SEED_PIN);
  const adminCred = await hashSecret(SEED_ADMIN_PASSWORD);
  const writes = [];
  const add = (key, rec) => writes.push([key, rec]);
  add("site", { ...SEED_SITE, rev: 1, updated: now });
  add("acct:" + ADMIN_USER, { id: "a-" + ADMIN_USER, user: ADMIN_USER, name: "Gérant", role: "admin", perms: [], active: true, cred: adminCred, created: now, rev: 1 });
  CONTRAT.forEach((c, i) => {
    const id = "c" + (i + 1);
    add("client:" + id, { id, type: c.type, name: c.name, code: c.code, kind: c.kind, contrat: true, contact: c.kind, phone: "", active: true, cred: pinCred, created: now, rev: 1 });
    const extra = c.type === "ecole" ? ["rc", "agrementecole"] : [];
    DOC_BASE.concat(extra).forEach((type, n) => {
      const did = "d" + (i + 1) + "-" + n;
      add("doc:" + did, { id: did, clientId: id, type, name: "", date: "2026-10-09", expiry: "2027-06-30", status: "manquant", note: "", file: null, created: now, rev: 1 });
    });
  });
  await inChunks(writes, 20, async ([key, rec]) => {
    if (await getRec(env, key) == null) await putRec(env, key, rec);
  });
  await setMeta(env, "seeded", now);
  await touch(env);
  seededMemo = true;
}
