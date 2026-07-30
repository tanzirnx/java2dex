# java2dex

A small multi-page site for turning `.java` source into Dalvik `.dex` bytecode — free, no account, runs in the browser, and installs as an app.

**Pages**
- **Home** (`/`) — what it does, the pipeline, feature list, Install App button
- **Convert** (`/convert`) — upload files and/or paste code, drag-and-drop, live pipeline status, queue up to 50 files
- **History** (`/history`) — every past run, stored in your browser's `localStorage` (not on the server); re-download small outputs, delete entries, clear all
- **Help** (`/help`) — how the pipeline works + fixes for the compile errors you'll actually hit

**Backend**: Node/Express calls `javac` then `d8` (the same tools a real Android build uses).

## Installable app (PWA)

- **Install App** button (nav + Home hero) triggers the native install prompt on Chrome/Edge (desktop and Android). On iOS/Safari it shows instructions for "Add to Home Screen" instead, since Safari doesn't support the prompt API.
- Once installed, it opens in its own window/icon, no browser chrome — a real app icon, not just a bookmark.
- A service worker (`sw.js`) caches the app shell (pages, CSS, JS) so the UI still loads offline; actual conversion always needs the network since compiling happens server-side.
- **Share target**: on Android, once installed, you can open your file manager, long-press a `.java` file → **Share** → **java2dex**, and it lands directly in the Convert queue (via `/convert-share` → one-time token → auto-imported).

## Deploy to Render (free plan)

1. Push this folder to a new GitHub repo.
2. On [render.com](https://render.com) → **New +** → **Web Service** → connect the repo.
3. Render auto-detects `render.yaml` (Docker, free plan). If not, set manually:
   - Environment: **Docker**
   - Plan: **Free**
   - Health Check Path: `/health`
4. **Create Web Service**. First build takes ~8-10 min (downloading JDK + Android build-tools + platform jar).
5. Open the URL — Home page loads first; go to **Convert** to use the tool, or tap **Install App** to add it to your home screen/desktop.

## Notes / limits

- **Free plan spins down after inactivity** — first request after idle takes ~30-60s to wake up.
- **20MB per file, 50 files max** per run (edit in `server.js` → `multer` limits if you need more).
- Android SDK classes (`android.app.*`, `android.widget.*`, etc.) compile out of the box — `android.jar` (API 34) is downloaded and wired in automatically at build time.
- History lives entirely in `localStorage`: metadata for every run, plus the actual output file if it's under ~350KB. Nothing is stored server-side after your download starts. Different browser/device = different history.
- Shared files (via the Share Target) live in server memory for at most 5 minutes and are deleted the instant they're picked up by the browser, or on expiry — never written to disk, never logged.
- Change the Android API level by editing `PLATFORM_VERSION` in the `Dockerfile`.
- Bumping `sw.js`'s `CACHE_NAME` (e.g. `-v2`) forces installed clients to fetch fresh assets on next visit — do this if you redeploy and want old installs to update immediately.

## Local dev (needs JDK + Android build-tools installed locally)

```bash
npm install
D8_PATH=/path/to/build-tools/34.0.0/d8 ANDROID_JAR=/path/to/platforms/android-34/android.jar node server.js
```

Then open `http://localhost:3000`.


