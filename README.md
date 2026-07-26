# Java → DEX Converter

Upload `.java` files in the browser, server compiles with `javac` and converts to `.dex` with `d8`, you download the result.

## Deploy to Render (free plan)

1. Push this folder to a new GitHub repo.
2. On [render.com](https://render.com) → **New +** → **Web Service**.
3. Connect your repo.
4. Render will auto-detect `render.yaml` (Docker env, free plan). If it doesn't, set manually:
   - **Environment**: Docker
   - **Plan**: Free
   - **Health Check Path**: `/health`
5. Click **Create Web Service**. First build takes ~5-8 min (downloading JDK + Android build-tools).
6. Once live, open the URL — upload `.java` files, click Convert, get `classes.dex` (or a zip if multiple dex files are produced).

## Notes / limits

- **Free plan spins down after inactivity** — first request after idle takes ~30-60s to wake up.
- **5MB per file, 50 files max** upload limit (edit in `server.js` → `multer` limits if you need more).
- Code that references **Android SDK classes** (`android.app.Activity`, `android.widget.*`, etc.) is supported — the Dockerfile downloads `platforms;android-34` (`android.jar`) at build time and sets `ANDROID_JAR` automatically, which `server.js` puts on the `javac` classpath. No manual setup needed.
- Multiple independent classes are compiled together in one `javac` call, so they can reference each other.
- Note: `android.jar` only has method *stubs* (bodies throw at runtime) — it's enough to compile and dex your code, but you can't actually run it on this server. You still install/run the resulting `.dex`/app on a real device or emulator.
- Need a different API level? Change `PLATFORM_VERSION` in the `Dockerfile` (e.g. `android-33`).

## Local test (needs JDK + Android build-tools installed locally)

```bash
npm install
D8_PATH=/path/to/build-tools/34.0.0/d8 node server.js
```

Then open `http://localhost:3000`.
