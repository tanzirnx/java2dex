const express = require("express");
const multer = require("multer");
const cors = require("cors");
const archiver = require("archiver");
const { v4: uuidv4 } = require("uuid");
const { execFile } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const webpush = require("web-push");
const AdmZip = require("adm-zip");

const app = express();
app.use(express.json({ limit: "256kb" }));
const PORT = process.env.PORT || 3000;

// ---- config: where the Android build-tools / d8 / jadx live ----
// Set via Dockerfile ENV. Falls back to PATH lookups if not set.
const D8_PATH = process.env.D8_PATH || "d8";
const ANDROID_JAR = process.env.ANDROID_JAR || ""; // optional, only needed if code uses android.* APIs
const JADX_PATH = process.env.JADX_PATH || "jadx";

const upload = multer({
  dest: path.join(os.tmpdir(), "java2dex-uploads"),
  limits: { fileSize: 20 * 1024 * 1024, files: 50 }, // 20MB/file, up to 50 files
});

// Decompile inputs (.dex/.apk/.jar) run larger than plain source, allow more room
const uploadDecompile = multer({
  dest: path.join(os.tmpdir(), "java2dex-uploads"),
  limits: { fileSize: 60 * 1024 * 1024, files: 5 },
});

// ---- Push notifications (Web Push) ----
// No database here, so subscriptions live in memory only — they're wiped on
// every restart, which on Render's free plan happens after inactivity. VAPID
// keys are read from env if set (recommended for stability), otherwise a
// fresh pair is generated at boot (fine since subscriptions reset together
// with the server anyway).
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  const generated = webpush.generateVAPIDKeys();
  VAPID_PUBLIC_KEY = generated.publicKey;
  VAPID_PRIVATE_KEY = generated.privateKey;
  console.log("No VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY set — generated a fresh pair for this run.");
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const pushSubscriptions = new Map(); // endpoint -> subscription object

// ---- Web Share Target: short-lived in-memory handoff ----
// When the installed PWA is used as an Android "Share to" target, the OS
// POSTs the shared file(s) here. We stash the text content under a token,
// redirect to /convert?shared=TOKEN, and the client fetches+consumes it once.
const sharedFilesStore = new Map(); // token -> { files: [{name, content}], expires }
const SHARE_TOKEN_TTL_MS = 5 * 60 * 1000;

function cleanupExpiredShares() {
  const now = Date.now();
  for (const [token, entry] of sharedFilesStore.entries()) {
    if (entry.expires < now) sharedFilesStore.delete(token);
  }
}

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// Clean URLs for the multi-page site (GET). The existing POST /convert below
// remains the conversion API — Express treats them as separate routes.
app.get("/convert", (req, res) => res.sendFile(path.join(__dirname, "public", "convert.html")));
app.get("/decompile", (req, res) => res.sendFile(path.join(__dirname, "public", "decompile.html")));
app.get("/history", (req, res) => res.sendFile(path.join(__dirname, "public", "history.html")));
app.get("/help", (req, res) => res.sendFile(path.join(__dirname, "public", "help.html")));
app.get("/settings", (req, res) => res.sendFile(path.join(__dirname, "public", "settings.html")));
app.get("/about", (req, res) => res.sendFile(path.join(__dirname, "public", "about.html")));

// Web Share Target endpoint — OS "Share to java2dex" lands here with file(s)
app.post("/convert-share", upload.array("javaFiles"), async (req, res) => {
  try {
    cleanupExpiredShares();
    const files = [];
    for (const file of req.files || []) {
      if (!file.originalname.endsWith(".java")) {
        await fsp.unlink(file.path).catch(() => {});
        continue;
      }
      const content = await fsp.readFile(file.path, "utf8").catch(() => "");
      await fsp.unlink(file.path).catch(() => {});
      files.push({ name: path.basename(file.originalname), content });
    }
    if (files.length === 0) {
      return res.redirect(303, "/convert?sharedError=1");
    }
    const token = uuidv4();
    sharedFilesStore.set(token, { files, expires: Date.now() + SHARE_TOKEN_TTL_MS });
    res.redirect(303, "/convert?shared=" + token);
  } catch (err) {
    console.error(err);
    res.redirect(303, "/convert?sharedError=1");
  }
});

// One-time retrieval of shared files by the client
app.get("/api/shared/:token", (req, res) => {
  cleanupExpiredShares();
  const entry = sharedFilesStore.get(req.params.token);
  if (!entry) return res.status(404).json({ error: "Shared files not found or expired." });
  sharedFilesStore.delete(req.params.token); // one-time use
  res.json({ files: entry.files });
});

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function walkFiles(dir, exts) {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full, exts)));
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

// Parses raw javac stderr into a structured list: [{ file, line, level, message }]
// Falls back gracefully — if a line doesn't match the usual "path:line: error: msg"
// shape, it's kept as a plain message so nothing gets silently dropped.
function parseJavacErrors(rawOutput) {
  if (!rawOutput) return [];
  const lines = rawOutput.split("\n");
  const results = [];
  const lineRe = /^(.+\.java):(\d+):\s*(error|warning):\s*(.+)$/;

  for (const line of lines) {
    const m = line.match(lineRe);
    if (m) {
      results.push({
        file: path.basename(m[1]),
        line: parseInt(m[2], 10),
        level: m[3],
        message: m[4].trim(),
      });
    } else if (line.trim() && !/^\d+ errors?$/.test(line.trim()) && !/^\^\s*$/.test(line) && !line.startsWith(" ") && results.length > 0) {
      // continuation lines / summary lines are folded into the previous entry when useful, otherwise ignored
    }
  }
  return results;
}

// Extracts a zip's .java entries into destDir (flat), returning extracted file paths.
// Silently ignores non-.java entries and directories; de-duplicates name collisions.
function extractJavaFromZip(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  const written = [];
  const usedNames = new Set();

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.entryName.toLowerCase().endsWith(".java")) continue;

    let baseName = path.basename(entry.entryName);
    let finalName = baseName;
    let counter = 1;
    while (usedNames.has(finalName)) {
      const ext = path.extname(baseName);
      finalName = `${path.basename(baseName, ext)}_${counter}${ext}`;
      counter++;
    }
    usedNames.add(finalName);

    const outPath = path.join(destDir, finalName);
    fs.writeFileSync(outPath, entry.getData());
    written.push(outPath);
  }
  return written;
}

app.post("/convert", upload.array("javaFiles"), async (req, res) => {
  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), "java2dex-jobs", jobId);
  const srcDir = path.join(workDir, "src");
  const classDir = path.join(workDir, "classes");
  const dexDir = path.join(workDir, "dex");

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded. Attach one or more .java files, or a .zip project." });
    }

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(classDir, { recursive: true });
    await fsp.mkdir(dexDir, { recursive: true });

    // Move uploaded files into srcDir, preserving original filenames.
    // .zip uploads are extracted (only .java entries kept, flattened).
    const javaFilePaths = [];
    for (const file of req.files) {
      const lowerName = file.originalname.toLowerCase();

      if (lowerName.endsWith(".zip")) {
        try {
          const extracted = extractJavaFromZip(file.path, srcDir);
          javaFilePaths.push(...extracted);
        } catch (zipErr) {
          console.warn("Zip extraction failed for", file.originalname, zipErr.message);
        }
        await fsp.unlink(file.path).catch(() => {});
        continue;
      }

      if (!lowerName.endsWith(".java")) {
        await fsp.unlink(file.path).catch(() => {});
        continue;
      }
      const dest = path.join(srcDir, path.basename(file.originalname));
      await fsp.rename(file.path, dest);
      javaFilePaths.push(dest);
    }

    if (javaFilePaths.length === 0) {
      cleanup(workDir);
      return res.status(400).json({ error: "No .java files found. Attach .java files directly, or a .zip containing them." });
    }

    // 1. Compile with javac
    const javacArgs = ["-d", classDir, "-encoding", "UTF-8"];
    if (ANDROID_JAR) {
      javacArgs.push("-classpath", ANDROID_JAR);
    }
    javacArgs.push(...javaFilePaths);

    try {
      await run("javac", javacArgs);
    } catch (compileErr) {
      cleanup(workDir);
      const rawDetails = compileErr.stderr || compileErr.message || "";
      return res.status(400).json({
        error: "Java compilation failed",
        details: rawDetails,
        parsedErrors: parseJavacErrors(rawDetails),
        filesAttempted: javaFilePaths.map((p) => path.basename(p)),
      });
    }

    // 2. Collect .class files (also used for the "compiled classes" inspector info)
    const classFiles = await walkFiles(classDir, [".class"]);
    if (classFiles.length === 0) {
      cleanup(workDir);
      return res.status(400).json({ error: "Compilation produced no .class files." });
    }
    const classNames = classFiles.map((f) => path.relative(classDir, f).replace(/\.class$/, "").split(path.sep).join("."));

    // 3. Convert to DEX with d8
    const d8Args = ["--output", dexDir, ...classFiles];
    try {
      await run(D8_PATH, d8Args);
    } catch (dexErr) {
      cleanup(workDir);
      return res.status(500).json({
        error: "DEX conversion failed",
        details: dexErr.stderr || dexErr.message,
      });
    }

    const dexFiles = await walkFiles(dexDir, [".dex"]);
    if (dexFiles.length === 0) {
      cleanup(workDir);
      return res.status(500).json({ error: "d8 ran but produced no .dex output." });
    }

    // Inspector metadata surfaced via headers (binary body can't carry JSON alongside it)
    const inspectorClasses = encodeURIComponent(classNames.slice(0, 200).join(","));
    res.setHeader("X-Compiled-Class-Count", String(classNames.length));
    res.setHeader("X-Compiled-Classes", inspectorClasses);
    res.setHeader("X-Dex-File-Count", String(dexFiles.length));
    res.setHeader("Access-Control-Expose-Headers", "X-Compiled-Class-Count, X-Compiled-Classes, X-Dex-File-Count, Content-Disposition");

    // 4. If only one classes.dex, send it directly. Otherwise zip (multidex case).
    if (dexFiles.length === 1) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", 'attachment; filename="classes.dex"');
      const stream = fs.createReadStream(dexFiles[0]);
      stream.pipe(res);
      stream.on("close", () => cleanup(workDir));
      return;
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="dex-output.zip"');
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);
    for (const f of dexFiles) {
      archive.file(f, { name: path.basename(f) });
    }
    await archive.finalize();
    archive.on("end", () => cleanup(workDir));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Unexpected server error", details: err.message });
    }
    cleanup(workDir);
  }
});

function cleanup(dir) {
  fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

// ---- Decompile: .dex / .apk / .jar / .class -> Java source (via jadx) ----
app.post("/decompile", uploadDecompile.array("inputFiles"), async (req, res) => {
  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), "java2dex-decompile-jobs", jobId);
  const inDir = path.join(workDir, "in");
  const outDir = path.join(workDir, "out");

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded. Attach a .dex, .apk, .jar, or .class file." });
    }

    await fsp.mkdir(inDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });

    const allowedExt = [".dex", ".apk", ".jar", ".class", ".aar", ".zip"];
    const inputPaths = [];
    for (const file of req.files) {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowedExt.includes(ext)) {
        await fsp.unlink(file.path).catch(() => {});
        continue;
      }
      const dest = path.join(inDir, path.basename(file.originalname));
      await fsp.rename(file.path, dest);
      inputPaths.push(dest);
    }

    if (inputPaths.length === 0) {
      cleanup(workDir);
      return res.status(400).json({ error: "No supported files found. Accepted: .dex, .apk, .jar, .class, .aar, .zip" });
    }

    // jadx: skip resource decoding (-r) since we only want Java sources here
    const jadxArgs = ["-d", outDir, "-r", "--show-bad-code", ...inputPaths];
    try {
      await run(JADX_PATH, jadxArgs);
    } catch (jadxErr) {
      // jadx can exit non-zero yet still have produced partial/useful sources —
      // only treat it as a hard failure if nothing was written at all.
      const javaFilesCheck = await walkFiles(outDir, [".java"]).catch(() => []);
      if (javaFilesCheck.length === 0) {
        cleanup(workDir);
        return res.status(400).json({
          error: "Decompilation failed",
          details: (jadxErr.stderr || jadxErr.stdout || jadxErr.message || "").slice(0, 4000),
        });
      }
    }

    const javaFiles = await walkFiles(outDir, [".java"]);
    if (javaFiles.length === 0) {
      cleanup(workDir);
      return res.status(500).json({ error: "jadx ran but produced no .java output." });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="decompiled-sources.zip"');
    res.setHeader("X-Java-File-Count", String(javaFiles.length));
    res.setHeader("Access-Control-Expose-Headers", "X-Java-File-Count, Content-Disposition");
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);
    const sourcesRoot = path.join(outDir, "sources");
    for (const f of javaFiles) {
      const relative = path.relative(sourcesRoot, f).split(path.sep).join("/");
      archive.file(f, { name: relative.startsWith("..") ? path.basename(f) : relative });
    }
    await archive.finalize();
    archive.on("end", () => cleanup(workDir));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Unexpected server error", details: err.message });
    }
    cleanup(workDir);
  }
});

// ---- Push notifications API ----
app.get("/api/push/vapid-public-key", (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", (req, res) => {
  const subscription = req.body && req.body.subscription;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Missing subscription object." });
  }
  pushSubscriptions.set(subscription.endpoint, subscription);
  res.json({ ok: true });
});

app.post("/api/push/unsubscribe", (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (endpoint) pushSubscriptions.delete(endpoint);
  res.json({ ok: true });
});

app.post("/api/push/test", async (req, res) => {
  const subscription = req.body && req.body.subscription;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: "Missing subscription object." });
  }
  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title: "java2dex",
        body: "Test notification — push is working.",
        url: "/",
      })
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Push send failed:", err.statusCode, err.body);
    if (err.statusCode === 404 || err.statusCode === 410) {
      pushSubscriptions.delete(subscription.endpoint);
    }
    res.status(500).json({ error: "Failed to send push notification", details: err.body || err.message });
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`java2dex server listening on port ${PORT}`);
  console.log(`D8_PATH=${D8_PATH}`);
  console.log(`JADX_PATH=${JADX_PATH}`);
});
