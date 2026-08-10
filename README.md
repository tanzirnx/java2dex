# JaKo Compile

A multi-page app for going between `.java`/`.kt` source and Android `.dex`/`.smali` bytecode — free, no account, runs in the browser, installs as an app, and can be built into a real Android APK.

**Pages**
- **Home** (`/`) — what it does, the pipeline, feature list, Install App button
- **Convert** (`/convert`) — .java → .dex. Upload files, a `.zip` project (auto-extracted), and/or paste code, drag-and-drop, upload progress bar, queue up to 50 files, structured compiler errors with a one-click copy button, Dex Inspector after success, manual multidex control
- **Kotlin** (`/kotlin`) — .kt → .dex or .kt → .smali, same upload/paste/progress/error treatment as Convert
- **Decompile** (`/decompile`) — .dex / .apk / .jar / .class → readable source (via jadx) — works on Java **or** Kotlin-compiled apps
- **Smali** (`/smali`) — Java/Kotlin → Smali (baksmali), and Smali → .dex (smali assembler) for round-trip bytecode editing, with method/field counts and inline preview
- **Method Converter** (`/method-converter`) — standalone, fully client-side: turns a single Java method call into its exact Smali `invoke-*` instruction, with a plain-English breakdown
- **History** (`/history`) — every past run across all tools, stored in your browser's `localStorage`, not on the server — export/import as JSON
- **Settings** (`/settings`) — push notifications, local run alerts, install QR code, dark/light theme, app info, clear local data
- **About** (`/about`) — what the app is, the tech stack, a full feature list, and a copyable **app prompt** — plain text you can hand to any AI assistant (or teammate) so it instantly understands what JaKo Compile does
- **API Docs** (`/api-docs`) — every endpoint documented with curl examples, no API key needed
- **Help** (`/help`) — how the pipeline works, how to reach every conversion direction, and fixes for the errors you'll actually hit

**Backend**: Node/Express. `javac` + `kotlinc` + `d8` for conversion, `jadx` for decompilation, `baksmali`/`smali` for bytecode↔Smali, `web-push` for notifications, `adm-zip` for `.zip` project uploads.

## Design

Rebranded as **JaKo Compile** with a violet/cyan glassmorphism theme (frosted blur panels, blurred color-blob backgrounds) across every page, plus a dark/light toggle. The `.card` component and shared CSS variables carry the look everywhere, so no page-specific markup changes were needed for the reskin.

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

## Kotlin support (v4)

- **`POST /kotlin-to-dex`** and **`POST /kotlin-to-smali`** — `kotlinc` compiles directly to `.class` (no `javac` step), then the same `d8`/`baksmali` pipeline as the Java routes takes over. Field name is `kotlinFiles`; accepts `.kt` files or a `.zip`.
- **Caveat, stated in the UI**: code using Kotlin stdlib functions compiles and dexes fine, but the stdlib itself isn't bundled in the output — a real APK needs it added separately (same category of caveat as `android.jar` being stub-only, just the other direction: this one *does* need bundling).
- **Decompiling Kotlin apps**: already covered by the existing `/decompile` route — jadx doesn't distinguish source language. Output is always Java-style syntax; no freely available tool reliably reconstructs idiomatic `.kt` from bytecode, and the UI says so rather than overpromising.
- `kotlinc` is downloaded as a prebuilt release zip at Docker build time (`KOTLIN_VERSION` in the `Dockerfile`).

## Method Converter

`/method-converter` needs no server call — it's a deterministic client-side generator. Given a class name, method name, parameter types, return type, and an invocation kind (`static`/`virtual`/`direct`/`interface`), it builds the correct register list, resolves each Java type to its Smali descriptor (primitives, common `java.*`/`android.*` types, or any fully-qualified name), and prints the `invoke-*` line plus a `move-result` line when the method returns a value — with an explanation of every part. Verified against hand-checked examples during development (including `invoke-static {p0}, Lcom/example/Foo;->bar(Landroid/app/Activity;)V` for a static call, and a `move-result-object` case for a returning `invoke-virtual`).

## Smali (v3)

New page: **`/smali`**, with a glassmorphism ("glass UI") look — frosted panels, blurred color blobs, distinct from the rest of the site.

- **Java → Smali** (`POST /java-to-smali`) — same input options as Convert (upload .java files, a .zip project, or paste code), but runs one step further: javac → d8 → **baksmali**, returning a `.zip` of readable `.smali` source. Response headers include method/field counts (`X-Method-Count`, `X-Field-Count`) checked against the 65,536-per-dex limit, plus a preview of the first file (`X-Smali-Preview`) shown inline on the page.
- **Smali → DEX** (`POST /smali-to-dex`) — upload `.smali` files (or a `.zip` of them) and get back an assembled `classes.dex`, via the **smali** assembler. Useful for editing disassembled output and rebuilding it.
- Both directions were tested end-to-end in development with real `smali`/`baksmali` jars (a hand-written test `.smali` file → assembled to a real `Dalvik dex file version 035` → disassembled back to matching `.smali`).
- Powered by [smali/baksmali](https://github.com/baksmali/smali) (`SMALI_VERSION` in the `Dockerfile`), downloaded as prebuilt fat jars — no build step needed, just `java -jar`.

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
- Convert/Kotlin: **20MB per file, 50 files max** per run (or a `.zip` — only matching source entries inside it are used). Decompile: **60MB per file, 5 files max**. Edit limits in `server.js` → the relevant `multer(...)` block.
- Android SDK classes (`android.app.*`, `android.widget.*`, etc.) compile out of the box for both languages — `android.jar` (API 34) plus a handful of AndroidX/Material jars are wired in automatically. Most third-party libraries and generated `R` class resources are **not** available (no full Gradle build behind this).
- History lives entirely in `localStorage`: metadata for every run, plus the actual output file if under ~350KB. Nothing is stored server-side after your download starts. Export/import lets you move it between devices manually.
- Change the Android API level via `PLATFORM_VERSION`, the decompiler version via `JADX_VERSION`, the smali/baksmali version via `SMALI_VERSION`, or the Kotlin compiler version via `KOTLIN_VERSION`, in the `Dockerfile`.
- Bumping `sw.js`'s `CACHE_NAME` forces installed clients to fetch fresh assets on next visit — do this after any redeploy that changes pages/CSS/JS.
- Keyboard shortcuts on every conversion page: **Ctrl+Enter** to run, **Esc** to clear the queue.
- **Deliberately not built**: an actual code-*execution* endpoint (running compiled Java/Kotlin, or rendering XML layouts live). Compiling is fine — it never runs anything — but a public, unauthenticated "run my code" endpoint on a free server is a real abuse vector (crypto-mining, network attacks, resource exhaustion), so it's out of scope here regardless of framing.

## Local dev (needs JDK + Android build-tools + jadx installed locally)

```bash
npm install
D8_PATH=/path/to/build-tools/34.0.0/d8 \
ANDROID_JAR=/path/to/platforms/android-34/android.jar \
JADX_PATH=/path/to/jadx/bin/jadx \
node server.js
```

Then open `http://localhost:3000`.




