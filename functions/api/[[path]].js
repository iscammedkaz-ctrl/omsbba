// Routeur unique de l'API (Cloudflare Pages Functions). Toutes les routes : /api/...
// Même origine uniquement : aucun en-tête CORS n'est émis ; les écritures exigent JSON + Origin identique.
import { HttpError, bad, json, errorResponse } from "../_lib/util.js";
import { ensureSeed } from "../_lib/seed.js";
import { getPublic, postLead, postOtherRequest, postOtherTrack, clientLogin, clientMe, clientBook } from "../_lib/routes-public.js";
import { adminRoute } from "../_lib/routes-admin.js";

const MAX_BODY = 100 * 1024;
const MAX_BODY_BIG = 3.5 * 1024 * 1024; // documents (≈1,5 Mo en base64) et import

export async function onRequest({ request, env }) {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    let segs;
    try { segs = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent); }
    catch (e) { throw bad("URL invalide"); }
    if (segs.some((s) => s.length > 128)) throw new HttpError(404, "not_found", "Route inconnue.");

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "GET, POST, PUT, DELETE", "cache-control": "no-store" } });
    if (method !== "GET" && method !== "HEAD") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) throw new HttpError(403, "bad_origin", "Origine non autorisée.");
    }
    const big = (segs[0] === "admin" && (segs[1] === "docs" || segs[1] === "import"));
    const readBody = async () => {
      if (method === "GET" || method === "DELETE") return {};
      const ct = (request.headers.get("content-type") || "").toLowerCase();
      if (!ct.startsWith("application/json")) throw new HttpError(415, "unsupported_media_type", "Content-Type application/json requis.");
      const max = big ? MAX_BODY_BIG : MAX_BODY;
      const len = Number(request.headers.get("content-length") || 0);
      if (len > max) throw new HttpError(413, "too_large", "Requête trop volumineuse.");
      const text = await request.text();
      if (text.length > max) throw new HttpError(413, "too_large", "Requête trop volumineuse.");
      if (!text.trim()) return {};
      try { return JSON.parse(text); } catch (e) { throw bad("JSON invalide"); }
    };

    const [a, b, c] = segs;
    if (a === "health" && !b && method === "GET") {
      return json({ ok: true, kv: !!(env.BEB && env.BEB.get), authSecret: typeof env.AUTH_SECRET === "string" && env.AUTH_SECRET.length >= 16 });
    }
    await ensureSeed(env);
    if (a === "public" && !b && method === "GET") return json(await getPublic(env));
    if (a === "lead" && !b && method === "POST") return json(await postLead(env, request, await readBody()), 201);
    if (a === "other-request" && !b && method === "POST") return json(await postOtherRequest(env, request, await readBody()), 201);
    if (a === "other-track" && !b && method === "POST") return json(await postOtherTrack(env, request, await readBody()));
    if (a === "client") {
      if (b === "login" && !c && method === "POST") return json(await clientLogin(env, request, await readBody()));
      if (b === "me" && !c && method === "GET") return json(await clientMe(env, request));
      if (b === "book" && !c && method === "POST") return json(await clientBook(env, request, await readBody()), 201);
    }
    if (a === "admin") return json(await adminRoute(env, request, method, segs.slice(1), url, readBody));
    throw new HttpError(404, "not_found", "Route inconnue.");
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e);
    console.error("API error", e && e.stack || e);
    return errorResponse(new HttpError(500, "server_error", "Erreur serveur."));
  }
}
