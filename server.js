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

const app = express();
const PORT = process.env.PORT || 3000;

// ---- config: where the Android build-tools / d8 live ----
// Set via Dockerfile ENV. Falls back to "d8" on PATH if not set.
const D8_PATH = process.env.D8_PATH || "d8";
const ANDROID_JAR = process.env.ANDROID_JAR || ""; // optional, only needed if code uses android.* APIs

const upload = multer({
  dest: path.join(os.tmpdir(), "java2dex-uploads"),
  limits: { fileSize: 20 * 1024 * 1024, files: 50 }, // 20MB/file, up to 50 files
});

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
app.get("/history", (req, res) => res.sendFile(path.join(__dirname, "public", "history.html")));
app.get("/help", (req, res) => res.sendFile(path.join(__dirname, "public", "help.html")));

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

app.post("/convert", upload.array("javaFiles"), async (req, res) => {
  const jobId = uuidv4();
  const workDir = path.join(os.tmpdir(), "java2dex-jobs", jobId);
  const srcDir = path.join(workDir, "src");
  const classDir = path.join(workDir, "classes");
  const dexDir = path.join(workDir, "dex");

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No files uploaded. Attach one or more .java files." });
    }

    await fsp.mkdir(srcDir, { recursive: true });
    await fsp.mkdir(classDir, { recursive: true });
    await fsp.mkdir(dexDir, { recursive: true });

    // Move uploaded files into srcDir, preserving original filenames
    const javaFilePaths = [];
    for (const file of req.files) {
      if (!file.originalname.endsWith(".java")) continue;
      const dest = path.join(srcDir, path.basename(file.originalname));
      await fsp.rename(file.path, dest);
      javaFilePaths.push(dest);
    }

    if (javaFilePaths.length === 0) {
      return res.status(400).json({ error: "No .java files found in upload. Only .java files are accepted." });
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
      return res.status(400).json({
        error: "Java compilation failed",
        details: compileErr.stderr || compileErr.message,
      });
    }

    // 2. Collect .class files
    const classFiles = await walkFiles(classDir, [".class"]);
    if (classFiles.length === 0) {
      return res.status(400).json({ error: "Compilation produced no .class files." });
    }

    // 3. Convert to DEX with d8
    const d8Args = ["--output", dexDir, ...classFiles];
    try {
      await run(D8_PATH, d8Args);
    } catch (dexErr) {
      return res.status(500).json({
        error: "DEX conversion failed",
        details: dexErr.stderr || dexErr.message,
      });
    }

    const dexFiles = await walkFiles(dexDir, [".dex"]);
    if (dexFiles.length === 0) {
      return res.status(500).json({ error: "d8 ran but produced no .dex output." });
    }

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

app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`java2dex server listening on port ${PORT}`);
  console.log(`D8_PATH=${D8_PATH}`);
});
