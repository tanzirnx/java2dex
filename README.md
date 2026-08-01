# java2dex

A multi-page app for going both directions between `.java` source and Dalvik `.dex` bytecode — free, no account, runs in the browser, and installs as an app.

**Pages**
- **Home** (`/`) — what it does, the pipeline, feature list, Install App button
- **Convert** (`/convert`) — .java → .dex. Upload files and/or paste code, drag-and-drop, live pipeline status, queue up to 50 files
- **Decompile** (`/decompile`) — .dex / .apk / .jar / .class → readable .java source (via jadx)
- **History** (`/history`) — every past run (both directions), stored in your browser's `localStorage`, not on the server
- **Settings** (`/settings`) — push notifications, app info, clear local data
- **Help** (`/help`) — how the pipeline works + fixes for the compile errors you'll actually hit

**Backend**: Node/Express. `javac` + `d8` for conversion, `jadx` for decompilation, `web-push` for notifications.

## Installable app (PWA)

- **Install App** button (nav + Home hero) triggers the native install prompt on Chrome/Edge. On iOS/Safari it shows "Add to Home Screen" instructions instead.
- App identity: `manifest.json` sets `"id": "com.tanzirdev.java2dex"` — a package-name-style identifier Chrome uses to track the installed app. If you ever want an actual Android APK (Play Store listing) wrapping this PWA, this same manifest is what Google's **Bubblewrap**/TWA tool reads — that's a separate step (needs a signing keystore) and isn't part of this repo.
- A service worker (`sw.js`) caches the app shell so the UI loads offline; conversion/decompile always need the network since the heavy lifting happens server-side.
- **Share target**: once installed on Android, sharing a `.java` file from the file manager (Share → java2dex) lands it directly in the Convert queue.

## Push notifications

Uses the standard Web Push API — no third-party service. Toggle it on in **Settings**.

- **No database**: subscriptions live in server memory and are wiped on every restart (which, on Render's free plan, happens after ~15 min idle). This is fine for demoing but means people need to re-enable notifications after a cold start.
- **VAPID keys**: if you don't set them, the server generates a fresh pair on every boot — consistent with subscriptions also resetting on boot. For more stability, generate a fixed pair once and set them as Render environment variables:
  ```bash
  npx web-push generate-vapid-keys
  ```
  Then in Render → your service → **Environment**, add:
  - `VAPID_PUBLIC_KEY`
  - `VAPID_PRIVATE_KEY`
  - `VAPID_SUBJECT` (e.g. `mailto:you@example.com`)

## Decompile (DEX → Java)

Powered by [jadx](https://github.com/skylot/jadx), downloaded and pinned to a specific version at Docker build time (`JADX_VERSION` in the `Dockerfile`). Accepts `.dex`, `.apk`, `.jar`, `.class`, `.aar`, `.zip` — up to 60MB, up to 5 files per run — and returns a `.zip` of `.java` source files.

Decompiled output is best-effort: variable/method names are regenerated (bytecode doesn't keep the originals unless debug info was preserved), and heavily obfuscated or R8-minified code may come back partial. Only decompile code you have the right to inspect.

## Deploy to Render (free plan)

1. Push this folder to a new GitHub repo.
2. On [render.com](https://render.com) → **New +** → **Web Service** → connect the repo.
3. Render auto-detects `render.yaml` (Docker, free plan). If not, set manually:
   - Environment: **Docker**
   - Plan: **Free**
   - Health Check Path: `/health`
4. (Optional but recommended) Add `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` env vars — see Push notifications above.
5. **Create Web Service**. First build takes ~10-12 min (JDK + Android build-tools + platform jar + jadx).
6. Open the URL — Home page loads first. Tap **Install App** to add it to your home screen/desktop.

## Notes / limits

- **Free plan spins down after inactivity** — first request after idle takes ~30-60s to wake up, and resets push subscriptions + in-memory share tokens.
- Convert: **20MB per file, 50 files max** per run. Decompile: **60MB per file, 5 files max**. Edit limits in `server.js` → the relevant `multer(...)` block.
- Android SDK classes (`android.app.*`, `android.widget.*`, etc.) compile out of the box — `android.jar` (API 34) is downloaded and wired in automatically at build time.
- History lives entirely in `localStorage`: metadata for every run, plus the actual output file if it's under ~350KB. Nothing is stored server-side after your download starts.
- Change the Android API level by editing `PLATFORM_VERSION`, or the decompiler version by editing `JADX_VERSION`, in the `Dockerfile`.
- Bumping `sw.js`'s `CACHE_NAME` (e.g. `-v3`) forces installed clients to fetch fresh assets on next visit — do this after any redeploy that changes pages/CSS/JS.

## Local dev (needs JDK + Android build-tools + jadx installed locally)

```bash
npm install
D8_PATH=/path/to/build-tools/34.0.0/d8 \
ANDROID_JAR=/path/to/platforms/android-34/android.jar \
JADX_PATH=/path/to/jadx/bin/jadx \
node server.js
```

Then open `http://localhost:3000`.



