#!/usr/bin/env node
/**
 * Construit des lots SQL INSERT depuis l'export KV (list metadata + site/meta).
 * Usage: node build-d1-import.mjs <exportDir> <outDir>
 */
import fs from "fs";
import path from "path";

const exportDir = process.argv[2];
const outDir = process.argv[3];
if (!exportDir || !outDir) {
  console.error("Usage: node build-d1-import.mjs <exportDir> <outDir>");
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

function esc(s) {
  return String(s).replace(/'/g, "''");
}

function loadList(name) {
  const p = path.join(exportDir, name);
  const raw = fs.readFileSync(p, "utf8").trim();
  if (!raw || raw === "[]") return [];
  return JSON.parse(raw);
}

function stmtsFromList(list, table, keyPrefix) {
  const out = [];
  for (const item of list) {
    if (!item.metadata) throw new Error("missing metadata for " + item.name);
    const id = item.name.startsWith(keyPrefix) ? item.name.slice(keyPrefix.length) : item.metadata.id;
    const data = JSON.stringify(item.metadata);
    out.push(`INSERT OR REPLACE INTO ${table} (id, data) VALUES ('${esc(id)}', '${esc(data)}');`);
  }
  return out;
}

const batches = [];
function pushAll(stmts, label) {
  const SIZE = 40; // ~ stay under D1 query size
  for (let i = 0; i < stmts.length; i += SIZE) {
    batches.push({ label: `${label}_${i}`, sql: stmts.slice(i, i + SIZE).join("\n") });
  }
}

const site = JSON.parse(fs.readFileSync(path.join(exportDir, "site.json"), "utf8"));
batches.push({
  label: "site",
  sql: `INSERT OR REPLACE INTO site (id, data) VALUES ('site', '${esc(JSON.stringify(site))}');`
});

pushAll(stmtsFromList(loadList("accts-list.json"), "accounts", "acct:"), "accounts");
pushAll(stmtsFromList(loadList("clients-list.json"), "clients", "client:"), "clients");
pushAll(stmtsFromList(loadList("books-list.json"), "books", "book:"), "books");
pushAll(stmtsFromList(loadList("privates-list.json"), "privates", "private:"), "privates");
pushAll(stmtsFromList(loadList("leads-list.json"), "leads", "lead:"), "leads");
pushAll(stmtsFromList(loadList("payments-list.json"), "payments", "payment:"), "payments");
pushAll(stmtsFromList(loadList("docs-list.json"), "docs", "doc:"), "docs");

const rev = fs.readFileSync(path.join(exportDir, "meta_rev.txt"), "utf8").trim().replace(/^.*\n/, "").split("\n").pop().trim();
const seeded = fs.readFileSync(path.join(exportDir, "meta_seeded.txt"), "utf8").trim().replace(/^.*\n/, "").split("\n").pop().trim();
// strip possible wrangler noise: keep last non-empty line that looks like a value
function metaVal(txt) {
  const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1];
}
const revV = metaVal(fs.readFileSync(path.join(exportDir, "meta_rev.txt"), "utf8"));
const seededV = metaVal(fs.readFileSync(path.join(exportDir, "meta_seeded.txt"), "utf8"));
batches.push({
  label: "meta",
  sql: [
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('rev', '${esc(revV)}');`,
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('seeded', '${esc(seededV)}');`,
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_from_kv', '${esc(new Date().toISOString())}');`
  ].join("\n")
});

const manifest = [];
batches.forEach((b, i) => {
  const name = `batch_${String(i).padStart(4, "0")}_${b.label}.sql`;
  fs.writeFileSync(path.join(outDir, name), b.sql + "\n", "utf8");
  manifest.push(name);
});
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ count: manifest.length, files: manifest }, null, 2));
console.log("batches", manifest.length, "rev", revV, "seeded", seededV);
