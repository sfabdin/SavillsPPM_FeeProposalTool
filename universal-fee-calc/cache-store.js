/* ============================================================
   SAVILLS PPM · THE BROWSER CACHE (localStorage with an IndexedDB floor)
   ------------------------------------------------------------
   Every store in the app caches its whole document in the browser so a
   page can read synchronously: the fee book (1.3 million characters),
   the staffing file (0.6M), each confirmed book (1.2M), the trail (0.6M
   a month). localStorage holds about 2.5 million characters in all, so
   by October 2026 the writes were failing for anyone who had loaded a
   book — confirmations went missing, the Books list emptied, the trail
   could not be read. Box was always safe; the browser's copy was not.

   This is the one door every big document now goes through:
     get(key)        → localStorage if it holds the key, else memory
                       (hydrated from IndexedDB at boot)
     set(key, raw)   → localStorage when it fits; when it does not, the
                       key leaves localStorage and lives in memory, and
                       IndexedDB (hundreds of megabytes) keeps it across
                       loads. Big keys are always mirrored to IndexedDB.
   Synchronous on the read side, so no caller changed shape; boot waits
   for the IndexedDB hydration before anything reads. Small keys (ids,
   etags, preferences) stay on plain localStorage.
   ============================================================ */
(function () {
  'use strict';
  const DB = 'savills-ppm-cache', STORE = 'kv';
  const BIG = new Set(['savills-ppm-fee-db:v1', 'savills-ppm-staff-db:v1', 'savills-ppm-confirmed-db:v1', 'savills-ppm-activity-db:v1', 'savills-ppm-studio-db:v1', 'savills-ppm-history-db:v1']);
  const mem = new Map();
  let idb = null;
  const stats = { idb: false, spilled: [] };
  function open() {
    return new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') { resolve(null); return; }
        const r = indexedDB.open(DB, 1);
        r.onupgradeneeded = () => { try { r.result.createObjectStore(STORE); } catch (e) {} };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(null);
        r.onblocked = () => resolve(null);
      } catch (e) { resolve(null); }
    });
  }
  const tx = (mode) => idb ? idb.transaction(STORE, mode).objectStore(STORE) : null;
  function idbGet(key) { return new Promise((resolve) => { try { const s = tx('readonly'); if (!s) { resolve(null); return; } const r = s.get(key); r.onsuccess = () => resolve(r.result == null ? null : String(r.result)); r.onerror = () => resolve(null); } catch (e) { resolve(null); } }); }
  function idbPut(key, raw) { try { const s = tx('readwrite'); if (s) s.put(raw, key); } catch (e) {} }
  function idbDel(key) { try { const s = tx('readwrite'); if (s) s.delete(key); } catch (e) {} }
  async function hydrate() {
    idb = await open(); stats.idb = !!idb;
    if (!idb) return;
    for (const key of BIG) {
      let ls = null; try { ls = localStorage.getItem(key); } catch (e) {}
      if (ls != null) continue;                         // the fast path holds it
      const v = await idbGet(key);
      if (v != null) { mem.set(key, v); stats.spilled.push(key); }
    }
  }
  const ready = hydrate();
  function get(key) {
    let v = null; try { v = localStorage.getItem(key); } catch (e) {}
    if (v != null) return v;
    return mem.has(key) ? mem.get(key) : null;
  }
  /** Keep this document. Returns true when the fast path took it, false
      when it lives in memory + IndexedDB instead — never lost either way. */
  function set(key, raw) {
    raw = String(raw);
    let fast = false;
    try { localStorage.setItem(key, raw); fast = true; mem.delete(key); }
    catch (e) {
      try { localStorage.removeItem(key); } catch (e2) {}  // free what it held so the rest still fits
      mem.set(key, raw);
      if (stats.spilled.indexOf(key) < 0) stats.spilled.push(key);
    }
    if (BIG.has(key) || !fast) idbPut(key, raw);
    return fast;
  }
  function remove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
    mem.delete(key); idbDel(key);
  }
  /** Where a key lives right now — for the sync pill and the Runbook's diagnostics. */
  function where(key) { let v = null; try { v = localStorage.getItem(key); } catch (e) {} return v != null ? 'localStorage' : mem.has(key) ? 'memory+indexeddb' : 'none'; }
  window.UFC_Cache = { ready, get, set, remove, where, BIG, stats };
})();
