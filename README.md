# java2dex

A multi-page app for going both directions between `.java` source and Dalvik `.dex` bytecode — free, no account, runs in the browser, installs as an app, and can be built into a real Android APK.

**Pages**
- **Home** (`/`) — what it does, the pipeline, feature list, Install App button
- **Convert** (`/convert`) — .java → .dex. Upload files, a `.zip` project (auto-extracted), and/or paste code, drag-and-drop, upload progress bar, queue up to 50 files, structured compiler errors with a one-click copy button, Dex Inspector after success
- **Decompile** (`/decompile`) — .dex / .apk / .jar / .class → readable .java source (via jadx), same progress/error/copy treatment
- **History** (`/history`) — every past run (both directions), stored in your browser's `localStorage`, not on the server — export/import as JSON
- **Settings** (`/settings`) — push notifications, local convert/decompile alerts, install QR code, app info, clear local data
- **About** (`/about`) — what the app is, the tech stack, and a copyable **app prompt** — plain text you can hand to any AI assistant (or teammate) so it instantly understands what java2dex does
- **Help** (`/help`) — how the pipeline works + fixes for the compile errors you'll actually hit

**Backend**: Node/Express. `javac` + `d8` for conversion, `jadx` for decompilation, `web-push` for notifications, `adm-zip` for `.zip` project uploads.

## Installable app (PWA)

- **Install App** button (nav + Home hero) triggers the native install prompt on Chrome/Edge. On iOS/Safari it shows "Add to Home Screen" instructions instead.
- App identity: `manifest.json` sets `"id": "com.tanzirdev.java2dex"`.
- A service worker (`sw.js`) caches the app shell so the UI loads offline; conversion/decompile always need the network since the heavy lifting happens server-side.
- **Share target**: once installed on Android, sharing a `.java` file from the file manager (Share → java2dex) lands it directly in the Convert queue.
- **Install QR code** on the Settings page — scan from another device to open/install it there.

## Real Android APK

See **`android-twa-app/`** — a ready-to-build Trusted Web Activity (TWA) Android Studio/Gradle project that wraps your deployed site as a real, signed, installable `.apk` (or a Play Store listing), with your app icon, no browser chrome, and all the PWA features (push, offline shell, share target) intact. Full build steps — including generating a signing keystore and wiring up `.well-known/assetlinks.json` — are in `android-twa-app/README.md`. This isn't built/signed for you (needs your own keystore), but every project file is there; it's the same bash-in-Codespaces workflow you already use for your other Android projects.

## Better error handling

- Compile errors are parsed into a structured list (file, line, level, message) instead of a raw wall of text, shown in **Convert**.
- A **📋 Copy all errors** button appears on any failed run (Convert and Decompile) — copies the full raw output for pasting into a bug report or back into this chat.
- Large uploads show a real upload progress bar (not just a spinner).
- Successful conversions show a **Dex Inspector**: how many classes compiled, whether multidex kicked in, output size.

## Notifications

Two independent systems, both opt-in from **Settings**:

- **Convert/decompile alerts** — local notifications for "started / succeeded / failed", using the browser's Notification API directly. No server round-trip, works instantly, on by default once permission is granted.
- **Push notifications** — the standard Web Push API, for remote/background pushes (e.g. the Settings "Send test" button). No third-party service.
  - **No database**: push subscriptions live in server memory and are wiped on every restart (which, on Render's free plan, happens after ~15 min idle).
  - **VAPID keys**: if you don't set them, the server generates a fresh pair on every boot. For stability, generate a fixed pair once:
    ```bash
    npx web-push generate-vapid-keys
    ```
    Then in Render → your service → **Environment**, add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (e.g. `mailto:you@example.com`).

## Decompile (DEX → Java)

Powered by [jadx](https://github.com/skylot/jadx), pinned to a specific version at Docker build time (`JADX_VERSION` in the `Dockerfile`). Accepts `.dex`, `.apk`, `.jar`, `.class`, `.aar`, `.zip` — up to 60MB, up to 5 files per run — and returns a `.zip` of `.java` source files.

Decompiled output is best-effort: variable/method names are regenerated, and heavily obfuscated or R8-minified code may come back partial. Only decompile code you have the right to inspect.

## Advanced features (v2)

- **Manual multidex control** — Convert page → "Advanced (multidex)": specify which classes must land in the primary dex (`--main-dex-list`) and a `--min-api` value, passed straight to d8.
- **AndroidX / Material classpath** — the Dockerfile pulls classes.jar out of a few common AARs (appcompat, core, recyclerview, constraintlayout, material) at build time into `/opt/androidx-libs`; `server.js` scans that folder and adds whatever's present to `javac`'s classpath automatically. Each download is independent and allowed to fail without breaking the build — missing artifacts are just skipped.
- **Live syntax check** — the paste editor shows a lightweight brace/paren/bracket/string balance check as you type (client-side only, not a full parser — catches the common typo-level mistakes before a round-trip to the server).
- **Compile mode: Together / Separately** — "Together" (default) compiles the whole queue as one unit so files can reference each other. "Separately" sends each queued file/zip as its own independent `/convert` call and shows a per-item results list with individual downloads.
- **Dark/Light theme** — toggle in the nav, persisted in `localStorage`, applied via a tiny blocking script in `<head>` so there's no flash of the wrong theme on load.
- **Code templates** — quick-insert boilerplate (Activity, Dialog, Fragment, POJO, RecyclerView Adapter) into the paste editor.
- **Drag-to-reorder** — queue items can be dragged to change their order.
- **Public API** — `/api-docs` documents `POST /convert`, `POST /decompile`, and `GET /health` with curl examples; no API key needed, it's the same endpoints the UI itself calls.



1. Push this folder to a new GitHub repo.
2. On [render.com](https://render.com) → **New +** → **Web Service** → connect the repo.
3. Render auto-detects `render.yaml` (Docker, free plan). If not, set manually:
   - Environment: **Docker**
   - Plan: **Free**
   - Health Check Path: `/health`
4. (Optional but recommended) Add `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` env vars.
5. **Create Web Service**. First build takes ~10-12 min (JDK + Android build-tools + platform jar + jadx).
6. Open the URL — Home page loads first. Tap **Install App**, or build the real APK from `android-twa-app/`.

## Notes / limits

- **Free plan spins down after inactivity** — first request after idle takes ~30-60s to wake up, and resets push subscriptions + in-memory share tokens.
- Convert: **20MB per file, 50 files max** per run (or a `.zip` — only `.java` entries inside it are used). Decompile: **60MB per file, 5 files max**. Edit limits in `server.js` → the relevant `multer(...)` block.
- Android SDK classes (`android.app.*`, `android.widget.*`, etc.) compile out of the box — `android.jar` (API 34) is wired in automatically. AndroidX/Jetpack, third-party libraries, and generated `R` class resources are **not** available (no full Gradle build behind this).
- History lives entirely in `localStorage`: metadata for every run, plus the actual output file if under ~350KB. Nothing is stored server-side after your download starts. Export/import lets you move it between devices manually.
- Change the Android API level via `PLATFORM_VERSION`, or the decompiler version via `JADX_VERSION`, in the `Dockerfile`.
- Bumping `sw.js`'s `CACHE_NAME` (e.g. `-v4`) forces installed clients to fetch fresh assets on next visit — do this after any redeploy that changes pages/CSS/JS.
- Keyboard shortcuts on Convert/Decompile: **Ctrl+Enter** to run, **Esc** to clear the queue.

## Local dev (needs JDK + Android build-tools + jadx installed locally)

```bash
npm install
D8_PATH=/path/to/build-tools/34.0.0/d8 \
ANDROID_JAR=/path/to/platforms/android-34/android.jar \
JADX_PATH=/path/to/jadx/bin/jadx \
node server.js
```

Then open `http://localhost:3000`.




