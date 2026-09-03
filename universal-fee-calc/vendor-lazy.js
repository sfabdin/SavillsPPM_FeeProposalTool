/* ============================================================
   SAVILLS PPM · LAZY VENDOR LOADER
   ------------------------------------------------------------
   ExcelJS is 948KB and SheetJS is 882KB. Both were loaded with a
   blocking <script> tag on every page that might one day export —
   six pages for ExcelJS, and Revenue Reconciliation carried both,
   1.8MB of JavaScript to download, parse and compile before the
   page could draw anything.

   Nobody needs either library to LOOK at a page. They are needed
   the moment someone clicks Export or drops a workbook in, and not
   before. So they load then, once, and every later call reuses the
   same promise.

   Local copies on purpose: the app vendors these rather than
   pulling from a CDN, so it keeps working on a locked-down network
   and nothing third-party is fetched at runtime.

   USAGE — await the one you need, then use the global as before:

     await UFC_Vendor.excel();     const wb = new ExcelJS.Workbook();
     await UFC_Vendor.xlsx();      const wb = XLSX.read(buf, …);
     const pdfjs = await UFC_Vendor.pdf();   // an ES module, returned rather than a global
   ============================================================ */
(function () {
  'use strict';

  const cache = {};

  function load(key, src, globalName) {
    // Already on the page (a stray <script> tag, or a second call) — done.
    if (window[globalName]) return Promise.resolve(window[globalName]);
    if (cache[key]) return cache[key];
    cache[key] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => {
        if (window[globalName]) resolve(window[globalName]);
        else reject(new Error(src + ' loaded but ' + globalName + ' is not defined'));
      };
      s.onerror = () => {
        /* Let a later click try again rather than caching the failure
           forever — a flaky network shouldn't disable exports for the
           rest of the session. */
        delete cache[key];
        reject(new Error('Could not load ' + src));
      };
      document.head.appendChild(s);
    });
    return cache[key];
  }

  window.UFC_Vendor = {
    /** ExcelJS — writing .xlsx (every export in the app). */
    excel: () => load('excel', 'vendor/exceljs.min.js', 'ExcelJS'),
    /** SheetJS — reading .xlsx (the importers). */
    xlsx: () => load('xlsx', 'vendor/xlsx.full.min.js', 'XLSX'),
    /** pdf.js — reading PDFs (the Ingestion Studio). Vendored: it used to
        come from a CDN at runtime, which broke the "nothing third-party at
        runtime" rule this file exists for and would be blocked by the CSP. */
    pdf: () => {
      if (!cache.pdf) {
        const base = new URL('vendor/', document.baseURI).href;
        cache.pdf = import(base + 'pdf.min.mjs').then(m => {
          m.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.mjs';
          return m;
        }).catch(e => { delete cache.pdf; throw e; });
      }
      return cache.pdf;
    },
    /** True once loaded, for code that wants to avoid an await. */
    ready: (which) => !!(which === 'xlsx' ? window.XLSX : window.ExcelJS),
  };
})();
