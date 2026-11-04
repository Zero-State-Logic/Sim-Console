# Deploying SIM CONSOLE online for free

SIM CONSOLE is a **static site**. The simulators, the Arduino compiler and VM, the code
sandbox, firmware codegen, recording and the hardware bridge all run in the visitor's
browser, so there is no server to pay for or keep alive. Any static host works. Four
free ones are pre-configured.

| Host | Cost | Setup effort | Best for |
|---|---|---|---|
| **GitHub Pages** | Free (public repo) | Lowest: push and flip one setting | The portfolio repo and live demo in one place. **Recommended.** |
| Cloudflare Pages | Free, unlimited bandwidth | Connect the repo | Heavy traffic |
| Netlify | Free, 100 GB/month | Connect the repo | Preview deploys per branch |
| Vercel | Free Hobby plan (non-commercial) | Connect the repo | If you already use Vercel |

Every host serves HTTPS, which Web Serial and Web Bluetooth require, so USB and BLE
hardware linking work straight from the live URL in Chrome or Edge.

---

## Option A: GitHub Pages (recommended)

The repo already contains `.github/workflows/deploy.yml`. It runs the typecheck,
all tests and the production build, then publishes `dist/` on every push to `main`.

1. Fork **[Zero-State-Logic/Sim-Console](https://github.com/Zero-State-Logic/Sim-Console)**, or create an empty **public** repository and push this folder to it. Don't add a README.
2. Push this folder:

   ```bash
   git remote add origin https://github.com/<your-user>/Sim-Console.git
   ```

   ```bash
   git push -u origin main
   ```

3. On GitHub, open the repo → **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Open the **Actions** tab and wait for "Deploy to GitHub Pages" to go green (about 2 minutes).
5. Your app is live at `https://<your-user>.github.io/Sim-Console/` (the official copy runs at [zero-state-logic.github.io/Sim-Console](https://zero-state-logic.github.io/Sim-Console/)).

Every later `git push` to `main` redeploys automatically. Pull requests run
`.github/workflows/ci.yml` (checks only, no deploy).

**Custom domain (optional):** Settings → Pages → Custom domain, then add the DNS record
GitHub shows you. Keep "Enforce HTTPS" on, because the hardware bridge needs it.

## Option B: Cloudflare Pages

1. dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git → pick the repo.
2. Framework preset: **Vite**. Build command `npm run build`. Output directory `dist`.
3. Environment variable `NODE_VERSION` = `22`.
4. Deploy. The security headers come from `public/_headers`.

## Option C: Netlify

1. app.netlify.com → Add new site → Import an existing project → pick the repo.
2. The settings are read from `netlify.toml` (build `npm run build`, publish `dist`, Node 22).
3. Deploy. The security headers come from `public/_headers`.

## Option D: Vercel

1. vercel.com → Add New → Project → import the repo.
2. The settings are read from `vercel.json` (Vite, `npm ci`, `npm run build`, `dist`, headers).
3. Deploy.

---

## What works online, and where

| Feature | Works on the live URL? |
|---|---|
| Walker / Sweeper / Swarm simulation, record & replay, profiles | Yes, in every modern browser with WebGL2 |
| Code sandbox (Arduino C++ compiler + VM, JavaScript) | Yes, in every modern browser |
| Firmware codegen + .zip download | Yes, in every modern browser |
| HARDWARE → **Virtual Device** (no board needed) | Yes, in every modern browser. Use it to demo the link flow. |
| HARDWARE → **USB serial** (Web Serial) | Yes, in **Chrome / Edge / Opera on desktop**. Not Firefox or Safari (they don't implement Web Serial). |
| HARDWARE → **Bluetooth LE** (Web Bluetooth) | Yes, in **Chrome / Edge on desktop and Android**. Not Firefox, Safari or iOS. |
| HARDWARE → **WiFi WebSocket** to a board on your LAN | See below. Browsers block `ws://` to LAN IPs from an HTTPS page. |

### WiFi boards from the hosted site

An HTTPS page may not open an unencrypted `ws://192.168.x.x` connection (mixed content),
and a hobby board can't present a trusted TLS certificate. You have three ways around it:

1. **USB or BLE instead.** Both work from the hosted site.
2. **Run the app locally.** `http://localhost` is allowed to open `ws://` connections:

   ```bash
   npm install
   ```

   ```bash
   npm run dev
   ```

3. **Use the bundled relay** on your PC. Browsers treat `ws://localhost` as trustworthy,
   so the hosted site can reach the relay, and the relay forwards to the board:

   ```bash
   node tools/ws-relay.mjs ws://192.168.4.1:81
   ```

   Then pick **WIFI** in the app and connect to `ws://localhost:8787`.

---

## Security notes

- A strict Content-Security-Policy is injected into `index.html` at build time
  (see `vite.config.ts`). It works on every host, GitHub Pages included. Scripts load only
  from the site itself; `'wasm-unsafe-eval'` is allowed for the Rapier physics engine.
- The JavaScript sandbox runs user code inside a dedicated Web Worker. The worker has no
  DOM, no access to the page's storage and no cookies (the site has none). Code runs only
  when you press RUN.
- Everything the bridge receives from a board is validated field by field before use.
- The WiFi password is never stored by the app. Generated firmware contains the
  placeholder `CHANGE_ME`, which you replace in your own copy.
- Netlify, Cloudflare and Vercel also send `nosniff`, `X-Frame-Options: DENY`, HSTS and
  a `Permissions-Policy` that allows only Serial and Bluetooth for this site.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Actions fails at `npm ci` | Commit `package-lock.json` and `.npmrc` (it sets `legacy-peer-deps`). |
| Blank page on GitHub Pages | Check that Settings → Pages → Source is "GitHub Actions", not a branch. |
| "Web Serial not supported" | Use desktop Chrome or Edge over `https://` or `http://localhost`. |
| Board connects but the app says "mismatch" | The firmware's `hello` announces a different robot or joint count than the active robot. Regenerate the firmware for this robot, or switch robot. |
| 3D view is slow | Switch quality to LOW in the top bar. |
