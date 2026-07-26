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
- Only plain Java is supported out of the box. If your `.java` files reference **Android SDK classes** (like `android.app.Activity`), compilation will fail unless you provide `android.jar` on the classpath — see below.
- Multiple independent classes are compiled together in one `javac` call, so they can reference each other.

## Adding android.jar support (optional)

If you want to convert code that uses Android APIs:

1. Get `android.jar` from an Android SDK platform (e.g. `platforms/android-34/android.jar`).
2. Add it into the repo, e.g. `libs/android.jar`.
3. In `Dockerfile`, add: `ENV ANDROID_JAR=/app/libs/android.jar`
4. Redeploy. The server already reads `ANDROID_JAR` and puts it on the `javac` classpath.

## Local test (needs JDK + Android build-tools installed locally)

```bash
npm install
D8_PATH=/path/to/build-tools/34.0.0/d8 node server.js
```

Then open `http://localhost:3000`.
