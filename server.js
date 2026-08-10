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
const BAKSMALI_JAR = process.env.BAKSMALI_JAR || "/opt/smali/baksmali.jar";
const SMALI_JAR = process.env.SMALI_JAR || "/opt/smali/smali.jar";
const KOTLINC_PATH = process.env.KOTLINC_PATH || "kotlinc";

// ---- AndroidX classpath (optional) ----
// If /opt/androidx-libs (or ANDROIDX_LIBS_DIR) contains .jar files — extracted
// from AndroidX/Material AARs at Docker build time — they're added to javac's
// classpath automatically. Scanned at request time (not just boot) so it's
// resilient to partial/failed downloads: whatever jars exist get used, missing
// ones are simply skipped rather than breaking the whole classpath.
const ANDROIDX_LIBS_DIR = process.env.ANDROIDX_LIBS_DIR || "/opt/androidx-libs";
function getAndroidxClasspath() {
  try {
    if (!fs.existsSync(ANDROIDX_LIBS_DIR)) return [];
    return fs
      .readdirSync(ANDROIDX_LIBS_DIR)
      .filter((f) => f.endsWith(".jar"))
      .map((f) => path.join(ANDROIDX_LIBS_DIR, f));
  } catch (e) {
    return [];
  }
}

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
app.get("/api-docs", (req, res) => res.sendFile(path.join(__dirname, "public", "api-docs.html")));
app.get("/smali", (req, res) => res.sendFile(path.join(__dirname, "public", "smali.html")));
app.get("/kotlin", (req, res) => res.sendFile(path.join(__dirname, "public", "kotlin.html")));
app.get("/method-converter", (req, res) => res.sendFile(path.join(__dirname, "public", "method-converter.html")));

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

    // 1. Compile with javac (android.jar + any available AndroidX jars on classpath)
    const javacArgs = ["-d", classDir, "-encoding", "UTF-8"];
    const classpathParts = [];
    if (ANDROID_JAR) classpathParts.push(ANDROID_JAR);
    classpathParts.push(...getAndroidxClasspath());
    if (classpathParts.length) {
      javacArgs.push("-classpath", classpathParts.join(path.delimiter));
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

    // 3. Convert to DEX with d8 — optional manual multidex control
    const d8Args = ["--output", dexDir];

    const minApi = (req.body && req.body.minApi || "").trim();
    if (minApi && /^\d+$/.test(minApi)) {
      d8Args.push("--min-api", minApi);
    }

    const mainDexRaw = (req.body && req.body.mainDexClasses) || "";
    const requestedMainDex = mainDexRaw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);

    let mainDexListPath = null;
    let mainDexMatched = [];
    let mainDexUnmatched = [];
    if (requestedMainDex.length) {
      requestedMainDex.forEach((wanted) => {
        // match either the full dotted name or just the simple (last-segment) class name
        const hit = classNames.find((cn) => cn === wanted || cn.endsWith("." + wanted) || cn === wanted.replace(/\./g, "$"));
        if (hit) mainDexMatched.push(hit);
        else mainDexUnmatched.push(wanted);
      });
      if (mainDexMatched.length) {
        mainDexListPath = path.join(workDir, "main-dex-list.txt");
        const listContent = mainDexMatched.map((cn) => cn.split(".").join("/") + ".class").join("\n") + "\n";
        await fsp.writeFile(mainDexListPath, listContent, "utf8");
        d8Args.push("--main-dex-list", mainDexListPath);
      }
    }

    d8Args.push(...classFiles);
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
    if (mainDexListPath) {
      res.setHeader("X-MainDex-Matched", String(mainDexMatched.length));
      if (mainDexUnmatched.length) {
        res.setHeader("X-MainDex-Unmatched", encodeURIComponent(mainDexUnmatched.join(",")));
      }
    }
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Compiled-Class-Count, X-Compiled-Classes, X-Dex-File-Count, X-MainDex-Matched, X-MainDex-Unmatched, Content-Disposition"
    );

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

// ---- Java -> Smali: javac -> d8 -> baksmali disassemble ----
app.post("/java-to-smali", upload.array("javaFiles"), async (req, res) => {
  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), "java2dex-smali-jobs", jobId);
  const srcDir = path.join(workDir, "src");
  const classDir = path.join(workDir, "classes");
  const dexDir = path.join(workDir, "dex");
  const smaliDir = path.join(workDir, "smali");

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded. Attach one or more .java files, or a .zip project." });
    }

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(classDir, { recursive: true });
    await fsp.mkdir(dexDir, { recursive: true });
    await fsp.mkdir(smaliDir, { recursive: true });

    const javaFilePaths = [];
    for (const file of req.files) {
      const lowerName = file.originalname.toLowerCase();
      if (lowerName.endsWith(".zip")) {
        try {
          javaFilePaths.push(...extractJavaFromZip(file.path, srcDir));
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

    // 1. javac
    const javacArgs = ["-d", classDir, "-encoding", "UTF-8"];
    const classpathParts = [];
    if (ANDROID_JAR) classpathParts.push(ANDROID_JAR);
    classpathParts.push(...getAndroidxClasspath());
    if (classpathParts.length) javacArgs.push("-classpath", classpathParts.join(path.delimiter));
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
      });
    }

    const classFiles = await walkFiles(classDir, [".class"]);
    if (classFiles.length === 0) {
      cleanup(workDir);
      return res.status(400).json({ error: "Compilation produced no .class files." });
    }

    // 2. d8 -> dex
    try {
      await run(D8_PATH, ["--output", dexDir, ...classFiles]);
    } catch (dexErr) {
      cleanup(workDir);
      return res.status(500).json({ error: "DEX conversion failed", details: dexErr.stderr || dexErr.message });
    }

    const dexFiles = await walkFiles(dexDir, [".dex"]);
    if (dexFiles.length === 0) {
      cleanup(workDir);
      return res.status(500).json({ error: "d8 ran but produced no .dex output." });
    }

    // 3. baksmali -> smali source
    try {
      await run("java", ["-jar", BAKSMALI_JAR, "disassemble", "-o", smaliDir, ...dexFiles]);
    } catch (baksmaliErr) {
      cleanup(workDir);
      return res.status(500).json({
        error: "Smali disassembly failed",
        details: baksmaliErr.stderr || baksmaliErr.stdout || baksmaliErr.message,
      });
    }

    const smaliFiles = await walkFiles(smaliDir, [".smali"]);
    if (smaliFiles.length === 0) {
      cleanup(workDir);
      return res.status(500).json({ error: "baksmali ran but produced no .smali output." });
    }

    // method/field counts across all produced smali files (useful vs the 64K dex limit)
    let methodCount = 0, fieldCount = 0;
    let firstSmaliPreview = "";
    for (let i = 0; i < smaliFiles.length; i++) {
      const content = await fsp.readFile(smaliFiles[i], "utf8");
      methodCount += (content.match(/^\s*\.method\s/gm) || []).length;
      fieldCount += (content.match(/^\s*\.field\s/gm) || []).length;
      if (i === 0) firstSmaliPreview = content.slice(0, 8000);
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="smali-output.zip"');
    res.setHeader("X-Smali-File-Count", String(smaliFiles.length));
    res.setHeader("X-Method-Count", String(methodCount));
    res.setHeader("X-Field-Count", String(fieldCount));
    res.setHeader("X-Smali-Preview", encodeURIComponent(firstSmaliPreview));
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Smali-File-Count, X-Method-Count, X-Field-Count, X-Smali-Preview, Content-Disposition"
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);
    for (const f of smaliFiles) {
      const relative = path.relative(smaliDir, f).split(path.sep).join("/");
      archive.file(f, { name: relative });
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

// ---- Smali -> DEX: smali assemble (reassembles edited/disassembled smali) ----
app.post("/smali-to-dex", upload.array("smaliFiles"), async (req, res) => {
  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), "java2dex-smali-asm-jobs", jobId);
  const srcDir = path.join(workDir, "src");

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded. Attach .smali files, or a .zip containing them." });
    }
    await fsp.mkdir(srcDir, { recursive: true });

    const smaliPaths = [];
    for (const file of req.files) {
      const lowerName = file.originalname.toLowerCase();
      if (lowerName.endsWith(".zip")) {
        try {
          const zip = new AdmZip(file.path);
          zip.getEntries().forEach((entry) => {
            if (entry.isDirectory || !entry.entryName.toLowerCase().endsWith(".smali")) return;
            const outPath = path.join(srcDir, path.basename(entry.entryName));
            fs.writeFileSync(outPath, entry.getData());
            smaliPaths.push(outPath);
          });
        } catch (zipErr) {
          console.warn("Zip extraction failed for", file.originalname, zipErr.message);
        }
        await fsp.unlink(file.path).catch(() => {});
        continue;
      }
      if (!lowerName.endsWith(".smali")) {
        await fsp.unlink(file.path).catch(() => {});
        continue;
      }
      const dest = path.join(srcDir, path.basename(file.originalname));
      await fsp.rename(file.path, dest);
      smaliPaths.push(dest);
    }

    if (smaliPaths.length === 0) {
      cleanup(workDir);
      return res.status(400).json({ error: "No .smali files found. Attach .smali files directly, or a .zip containing them." });
    }

    const outDex = path.join(workDir, "classes.dex");
    try {
      await run("java", ["-jar", SMALI_JAR, "assemble", "-o", outDex, ...smaliPaths]);
    } catch (asmErr) {
      cleanup(workDir);
      return res.status(400).json({
        error: "Smali assembly failed",
        details: asmErr.stderr || asmErr.stdout || asmErr.message,
      });
    }

    if (!fs.existsSync(outDex)) {
      cleanup(workDir);
      return res.status(500).json({ error: "smali ran but produced no classes.dex." });
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="classes.dex"');
    res.setHeader("X-Smali-Input-Count", String(smaliPaths.length));
    res.setHeader("Access-Control-Expose-Headers", "X-Smali-Input-Count, Content-Disposition");
    const stream = fs.createReadStream(outDex);
    stream.pipe(res);
    stream.on("close", () => cleanup(workDir));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Unexpected server error", details: err.message });
    }
    cleanup(workDir);
  }
});

// ---- Kotlin -> DEX: kotlinc -> d8 ----
// Note: kotlinc compiles directly to .class (no javac step). Code using the
// Kotlin stdlib dexes fine (d8 doesn't need referenced classes present), but
// the stdlib itself must be bundled separately into any real APK to run —
// unlike android.jar, it's not provided by the OS. See /help for details.
app.post("/kotlin-to-dex", upload.array("kotlinFiles"), async (req, res) => {
  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), "java2dex-kotlin-jobs", jobId);
  const srcDir = path.join(workDir, "src");
  const classDir = path.join(workDir, "classes");
  const dexDir = path.join(workDir, "dex");

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded. Attach one or more .kt files, or a .zip project." });
    }
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(classDir, { recursive: true });
    await fsp.mkdir(dexDir, { recursive: true });

    const ktFilePaths = [];
    for (const file of req.files) {
      const lowerName = file.originalname.toLowerCase();
      if (lowerName.endsWith(".zip")) {
        try {
          const zip = new AdmZip(file.path);
          zip.getEntries().forEach((entry) => {
            if (entry.isDirectory || !entry.entryName.toLowerCase().endsWith(".kt")) return;
            const outPath = path.join(srcDir, path.basename(entry.entryName));
            fs.writeFileSync(outPath, entry.getData());
            ktFilePaths.push(outPath);
          });
        } catch (zipErr) {
          console.warn("Zip extraction failed for", file.originalname, zipErr.message);
        }
        await fsp.unlink(file.path).catch(() => {});
        continue;
      }
      if (!lowerName.endsWith(".kt")) {
        await fsp.unlink(file.path).catch(() => {});
        continue;
      }
      const dest = path.join(srcDir, path.basename(file.originalname));
      await fsp.rename(file.path, dest);
      ktFilePaths.push(dest);
    }

    if (ktFilePaths.length === 0) {
      cleanup(workDir);
      return res.status(400).json({ error: "No .kt files found. Attach .kt files directly, or a .zip containing them." });
    }

    const kotlincArgs = ["-d", classDir];
    const classpathParts = [];
    if (ANDROID_JAR) classpathParts.push(ANDROID_JAR);
    classpathParts.push(...getAndroidxClasspath());
    if (classpathParts.length) kotlincArgs.push("-classpath", classpathParts.join(path.delimiter));
    kotlincArgs.push(...ktFilePaths);

    try {
      await run(KOTLINC_PATH, kotlincArgs, { maxBuffer: 1024 * 1024 * 50 });
    } catch (compileErr) {
      cleanup(workDir);
      const rawDetails = compileErr.stderr || compileErr.stdout || compileErr.message || "";
      return res.status(400).json({ error: "Kotlin compilation failed", details: rawDetails });
    }

    const classFiles = await walkFiles(classDir, [".class"]);
    if (classFiles.length === 0) {
      cleanup(workDir);
      return res.status(400).json({ error: "Compilation produced no .class files." });
    }
    const classNames = classFiles.map((f) => path.relative(classDir, f).replace(/\.class$/, "").split(path.sep).join("."));

    const d8Args = ["--output", dexDir];
    const minApi = (req.body && req.body.minApi || "").trim();
    if (minApi && /^\d+$/.test(minApi)) d8Args.push("--min-api", minApi);

    const mainDexRaw = (req.body && req.body.mainDexClasses) || "";
    const requestedMainDex = mainDexRaw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    let mainDexMatched = [], mainDexUnmatched = [];
    if (requestedMainDex.length) {
      requestedMainDex.forEach((wanted) => {
        const hit = classNames.find((cn) => cn === wanted || cn.endsWith("." + wanted) || cn === wanted.replace(/\./g, "$"));
        if (hit) mainDexMatched.push(hit); else mainDexUnmatched.push(wanted);
      });
      if (mainDexMatched.length) {
        const mainDexListPath = path.join(workDir, "main-dex-list.txt");
        await fsp.writeFile(mainDexListPath, mainDexMatched.map((cn) => cn.split(".").join("/") + ".class").join("\n") + "\n", "utf8");
        d8Args.push("--main-dex-list", mainDexListPath);
      }
    }
    d8Args.push(...classFiles);

    try {
      await run(D8_PATH, d8Args);
    } catch (dexErr) {
      cleanup(workDir);
      return res.status(500).json({ error: "DEX conversion failed", details: dexErr.stderr || dexErr.message });
    }

    const dexFiles = await walkFiles(dexDir, [".dex"]);
    if (dexFiles.length === 0) {
      cleanup(workDir);
      return res.status(500).json({ error: "d8 ran but produced no .dex output." });
    }

    res.setHeader("X-Compiled-Class-Count", String(classNames.length));
    res.setHeader("X-Compiled-Classes", encodeURIComponent(classNames.slice(0, 200).join(",")));
    res.setHeader("X-Dex-File-Count", String(dexFiles.length));
    if (requestedMainDex.length) {
      res.setHeader("X-MainDex-Matched", String(mainDexMatched.length));
      if (mainDexUnmatched.length) res.setHeader("X-MainDex-Unmatched", encodeURIComponent(mainDexUnmatched.join(",")));
    }
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Compiled-Class-Count, X-Compiled-Classes, X-Dex-File-Count, X-MainDex-Matched, X-MainDex-Unmatched, Content-Disposition"
    );

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
    for (const f of dexFiles) archive.file(f, { name: path.basename(f) });
    await archive.finalize();
    archive.on("end", () => cleanup(workDir));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Unexpected server error", details: err.message });
    cleanup(workDir);
  }
});

// ---- Kotlin -> Smali: kotlinc -> d8 -> baksmali ----
app.post("/kotlin-to-smali", upload.array("kotlinFiles"), async (req, res) => {
  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), "java2dex-kotlin-smali-jobs", jobId);
  const srcDir = path.join(workDir, "src");
  const classDir = path.join(workDir, "classes");
  const dexDir = path.join(workDir, "dex");
  const smaliDir = path.join(workDir, "smali");

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded. Attach one or more .kt files, or a .zip project." });
    }
    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(classDir, { recursive: true });
    await fsp.mkdir(dexDir, { recursive: true });
    await fsp.mkdir(smaliDir, { recursive: true });

    const ktFilePaths = [];
    for (const file of req.files) {
      const lowerName = file.originalname.toLowerCase();
      if (lowerName.endsWith(".zip")) {
        try {
          const zip = new AdmZip(file.path);
          zip.getEntries().forEach((entry) => {
            if (entry.isDirectory || !entry.entryName.toLowerCase().endsWith(".kt")) return;
            const outPath = path.join(srcDir, path.basename(entry.entryName));
            fs.writeFileSync(outPath, entry.getData());
            ktFilePaths.push(outPath);
          });
        } catch (zipErr) {
          console.warn("Zip extraction failed for", file.originalname, zipErr.message);
        }
        await fsp.unlink(file.path).catch(() => {});
        continue;
      }
      if (!lowerName.endsWith(".kt")) {
        await fsp.unlink(file.path).catch(() => {});
        continue;
      }
      const dest = path.join(srcDir, path.basename(file.originalname));
      await fsp.rename(file.path, dest);
      ktFilePaths.push(dest);
    }

    if (ktFilePaths.length === 0) {
      cleanup(workDir);
      return res.status(400).json({ error: "No .kt files found. Attach .kt files directly, or a .zip containing them." });
    }

    const kotlincArgs = ["-d", classDir];
    const classpathParts = [];
    if (ANDROID_JAR) classpathParts.push(ANDROID_JAR);
    classpathParts.push(...getAndroidxClasspath());
    if (classpathParts.length) kotlincArgs.push("-classpath", classpathParts.join(path.delimiter));
    kotlincArgs.push(...ktFilePaths);

    try {
      await run(KOTLINC_PATH, kotlincArgs, { maxBuffer: 1024 * 1024 * 50 });
    } catch (compileErr) {
      cleanup(workDir);
      const rawDetails = compileErr.stderr || compileErr.stdout || compileErr.message || "";
      return res.status(400).json({ error: "Kotlin compilation failed", details: rawDetails });
    }

    const classFiles = await walkFiles(classDir, [".class"]);
    if (classFiles.length === 0) {
      cleanup(workDir);
      return res.status(400).json({ error: "Compilation produced no .class files." });
    }

    try {
      await run(D8_PATH, ["--output", dexDir, ...classFiles]);
    } catch (dexErr) {
      cleanup(workDir);
      return res.status(500).json({ error: "DEX conversion failed", details: dexErr.stderr || dexErr.message });
    }

    const dexFiles = await walkFiles(dexDir, [".dex"]);
    if (dexFiles.length === 0) {
      cleanup(workDir);
      return res.status(500).json({ error: "d8 ran but produced no .dex output." });
    }

    try {
      await run("java", ["-jar", BAKSMALI_JAR, "disassemble", "-o", smaliDir, ...dexFiles]);
    } catch (baksmaliErr) {
      cleanup(workDir);
      return res.status(500).json({
        error: "Smali disassembly failed",
        details: baksmaliErr.stderr || baksmaliErr.stdout || baksmaliErr.message,
      });
    }

    const smaliFiles = await walkFiles(smaliDir, [".smali"]);
    if (smaliFiles.length === 0) {
      cleanup(workDir);
      return res.status(500).json({ error: "baksmali ran but produced no .smali output." });
    }

    let methodCount = 0, fieldCount = 0, firstSmaliPreview = "";
    for (let i = 0; i < smaliFiles.length; i++) {
      const content = await fsp.readFile(smaliFiles[i], "utf8");
      methodCount += (content.match(/^\s*\.method\s/gm) || []).length;
      fieldCount += (content.match(/^\s*\.field\s/gm) || []).length;
      if (i === 0) firstSmaliPreview = content.slice(0, 8000);
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="smali-output.zip"');
    res.setHeader("X-Smali-File-Count", String(smaliFiles.length));
    res.setHeader("X-Method-Count", String(methodCount));
    res.setHeader("X-Field-Count", String(fieldCount));
    res.setHeader("X-Smali-Preview", encodeURIComponent(firstSmaliPreview));
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Smali-File-Count, X-Method-Count, X-Field-Count, X-Smali-Preview, Content-Disposition"
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);
    for (const f of smaliFiles) {
      const relative = path.relative(smaliDir, f).split(path.sep).join("/");
      archive.file(f, { name: relative });
    }
    await archive.finalize();
    archive.on("end", () => cleanup(workDir));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Unexpected server error", details: err.message });
    cleanup(workDir);
  }
});

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
