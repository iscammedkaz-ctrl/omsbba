# omsbba

Salle omnisports de Bordj El Bahri. Site public.

https://iscammedkaz-ctrl.github.io/omsbba/

## Backend partagé (Cloudflare Pages Functions + KV)

- Fonctions : `functions/api/[[path]].js` (routeur) et `functions/_lib/*` (auth, stockage KV, seed, routes).
- KV : binding `BEB` (une clé par enregistrement : `book:`, `private:`, `lead:`, `payment:`, `client:`, `acct:`, `doc:`, `site`, `meta:*`, `rl:*`).
- Secret requis : `AUTH_SECRET` (signature des jetons HMAC), à créer comme secret Pages. Jamais dans le dépôt.
- Premier appel : si KV est vide, le seed intégré crée les canaux (PIN haché) et le compte `yasser` (mot de passe initial à changer dès la première connexion).
- Déploiement (depuis un dossier contenant `index.html`, `logo.jpg`, `logo-mark.png`, `_headers`, `functions/`, `wrangler.toml`) :
  `npx wrangler pages deploy . --project-name omsbeb --branch main`
