/* ============================================================
   History store — localStorage only, nothing leaves the browser.
   Schema per entry:
   {
     id, timestamp,
     inputFiles: [{name, size, kind:'file'|'pasted'}],
     status: 'success' | 'error',
     outputName, outputSizeBytes,
     errorMessage,
     outputBase64   // only present if small enough to keep for re-download
   }
   ============================================================ */
const J2D_HISTORY_KEY = 'java2dex_history_v1';
const J2D_MAX_ENTRIES = 60;
const J2D_MAX_STORED_OUTPUT_BYTES = 350 * 1024; // only keep re-downloadable blob if under this

const J2DHistory = {
  getAll() {
    try {
      const raw = localStorage.getItem(J2D_HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn('History read failed, resetting.', e);
      return [];
    }
  },

  add(entry) {
    const list = this.getAll();
    entry.id = entry.id || (Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    entry.timestamp = entry.timestamp || Date.now();
    list.unshift(entry);
    while (list.length > J2D_MAX_ENTRIES) list.pop();
    this._trySave(list);
    return entry.id;
  },

  remove(id) {
    const list = this.getAll().filter(e => e.id !== id);
    this._trySave(list);
  },

  clear() {
    localStorage.removeItem(J2D_HISTORY_KEY);
  },

  _trySave(list) {
    try {
      localStorage.setItem(J2D_HISTORY_KEY, JSON.stringify(list));
    } catch (e) {
      // likely quota exceeded — drop stored blobs (oldest first) and retry
      console.warn('History storage full, trimming stored outputs.', e);
      for (let i = list.length - 1; i >= 0 && i >= list.length - 20; i--) {
        if (list[i] && list[i].outputBase64) delete list[i].outputBase64;
      }
      try {
        localStorage.setItem(J2D_HISTORY_KEY, JSON.stringify(list));
      } catch (e2) {
        // still failing — keep only the most recent 10 entries, metadata only
        const trimmed = list.slice(0, 10).map(e => ({ ...e, outputBase64: undefined }));
        try { localStorage.setItem(J2D_HISTORY_KEY, JSON.stringify(trimmed)); } catch (e3) { /* give up silently */ }
      }
    }
  },

  maxStoredOutputBytes: J2D_MAX_STORED_OUTPUT_BYTES,
};

// helper: convert a Blob to base64 (only used when small enough to store)
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function base64ToBlob(base64, mime) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  return new Blob([new Uint8Array(byteNumbers)], { type: mime || 'application/octet-stream' });
}
