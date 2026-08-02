# java2dex — Android app wrapper (TWA)

This turns your deployed java2dex website into a real, installable, signed `.apk` — using a **Trusted Web Activity (TWA)**. It's not a rewrite: the APK just opens your deployed site full-screen, with a real app icon and no browser chrome. Same technique used by many production PWA-to-Play-Store apps.

## Before you build

1. Deploy java2dex to Render first (see the main `README.md`) and note your URL, e.g. `https://java2dex.onrender.com`.
2. Edit `app/src/main/res/values/strings.xml` — replace **every** `YOUR-APP-NAME.onrender.com` with your real domain (three places: `host_url`, `host_domain`, and inside `asset_statements`).

## Build in GitHub Codespaces

```bash
# from inside android-twa-app/
sudo apt-get update && sudo apt-get install -y openjdk-17-jdk unzip

# Android SDK command-line tools (only needed once)
mkdir -p ~/android-sdk/cmdline-tools
cd ~/android-sdk/cmdline-tools
wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O tools.zip
unzip -q tools.zip && mv cmdline-tools latest && rm tools.zip
export ANDROID_SDK_ROOT=~/android-sdk
export PATH=$PATH:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$ANDROID_SDK_ROOT/platform-tools
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"

# back to the project
cd -   # (android-twa-app/)
chmod +x gradlew 2>/dev/null || true
```

If `gradlew` isn't present (this repo ships the project without the Gradle wrapper jar to keep it small), generate it once:

```bash
gradle wrapper --gradle-version 8.7
```

(needs a system `gradle` — `sdk install gradle` via [SDKMAN](https://sdkman.io/), or `apt-get install gradle`, works fine for this one-time step)

## Create a signing keystore (one-time)

```bash
keytool -genkeypair -v -keystore release.keystore -alias java2dex \
  -keyalg RSA -keysize 2048 -validity 10000
```

Answer the prompts (name/org, etc.) and remember the password — you'll need it every time you build a release.

Get the SHA-256 fingerprint (needed for `assetlinks.json`):

```bash
keytool -list -v -keystore release.keystore -alias java2dex | grep "SHA256:"
```

## Wire up Digital Asset Links (removes the URL bar)

Copy the SHA-256 fingerprint from above into your deployed site's
`public/.well-known/assetlinks.json` (already scaffolded in the main repo),
replacing `REPLACE_WITH_YOUR_RELEASE_KEYSTORE_SHA256_FINGERPRINT`. Redeploy
the web app so `https://your-domain/.well-known/assetlinks.json` serves it.
Without this step, the app still works — it just shows a thin Chrome URL bar
at the top instead of being fully chrome-less.

## Build the release APK

```bash
./gradlew assembleRelease
```

Sign it (if you didn't configure signing in `app/build.gradle.kts`):

```bash
apksigner sign --ks release.keystore \
  --out app/build/outputs/apk/release/java2dex-signed.apk \
  app/build/outputs/apk/release/app-release-unsigned.apk
```

`java2dex-signed.apk` is now installable on any Android device (`adb install java2dex-signed.apk`), or upload it to Google Play as a normal app listing.

## Notes

- `minSdk 21` (Android 5.0+) — TWA support requires a Chrome-based browser installed on the device (virtually universal today).
- Push notifications, offline caching, share-target — all the PWA features from the main site keep working inside the TWA, since it's the same site.
- This scaffold intentionally leaves out the Gradle wrapper binary and a few Android Studio project files to keep the download small — Android Studio will happily open and regenerate them if you prefer a GUI over Codespaces.
