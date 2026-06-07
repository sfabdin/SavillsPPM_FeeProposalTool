/* ============================================================================
   Savills PPM Design System — colors_and_type.css
   Extracted from supplied .potx / .dotx themes (icons template, Word docs).
   All tokens are CSS custom properties; semantic variables alias raw colors.
   ============================================================================ */

/* ----- Fonts ---------------------------------------------------------------
   PRIMARY: Gotham (Hoefler & Co) — licensed, not bundled. Drop your
   .woff2 files into fonts/gotham/ and uncomment the @font-face blocks.
   FALLBACK: Montserrat (Google Fonts) — closest geometric-sans match.
   LETTERHEAD-ONLY: Cambria — already system-installed on most platforms.
   --------------------------------------------------------------------------- */

/* ---------- Gotham (licensed; .otf files supplied by client) -------------- */
/* If this stylesheet is loaded from a nested folder (e.g. ui_kits/x/...), the
   relative path resolves up from the stylesheet's own location, not the HTML
   document — so every page in this project references fonts via ../../fonts/
   from the kit, ../fonts/ from preview/slides/, and fonts/ from the root.
   Keep the URL relative to THIS file: fonts/gotham/...                       */

@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-XLight.otf") format("opentype");
  font-weight: 200; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-XLightItalic.otf") format("opentype");
  font-weight: 200; font-style: italic; font-display: swap;
}
@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-Light.otf") format("opentype");
  font-weight: 300; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-Book.otf") format("opentype");
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-BookItalic.otf") format("opentype");
  font-weight: 400; font-style: italic; font-display: swap;
}
@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-Medium.otf") format("opentype");
  font-weight: 500; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-Bold.otf") format("opentype");
  font-weight: 700; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-BoldItalic.otf") format("opentype");
  font-weight: 700; font-style: italic; font-display: swap;
}
@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-Black.otf") format("opentype");
  font-weight: 900; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-BlackItalic.otf") format("opentype");
  font-weight: 900; font-style: italic; font-display: swap;
}
@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-Ultra.otf") format("opentype");
  font-weight: 950; font-style: normal; font-display: swap;
}
@font-face {
  font-family: "Gotham";
  src: url("fonts/gotham/Gotham-UltraItalic.otf") format("opentype");
  font-weight: 950; font-style: italic; font-display: swap;
}

/* Montserrat fallback retained so any environment that fails to load Gotham
   still gets a geometric sans rather than Arial. */
@import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800;900&family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,700&display=swap');

:root {
  /* ===== Raw color palette ============================================== */

  /* Signature pair */
  --sav-yellow:        #FFDF00;   /* Savills Yellow — non-negotiable brand */
  --sav-yellow-press:  #E5C800;   /* 8% darker for press / hover */
  --sav-red:           #CE181E;   /* Supporting Red — accent only, never large areas */
  --sav-red-press:     #A6131A;

  /* Logo-only colours — the Savills logo uses slightly different yellow/red */
  --sav-logo-yellow:   #FFE843;
  --sav-logo-red:      #C90C0F;

  /* Neutrals ("Savills navy" + supporting greys) */
  --sav-navy:          #25273A;   /* Primary body text, the brand's Navy */
  --sav-ink:           #25273A;   /* alias for Navy */
  --sav-cream:         #EEE8E3;   /* Cream — warm off-white surface */
  --sav-stone:         #EEE8E3;   /* alias for Cream */
  --sav-steel:         #79828C;   /* Steel grey — not for text; backgrounds 50% or less */
  --sav-slate:         #79828C;   /* alias for Steel grey */
  --sav-white:         #FFFFFF;
  --sav-black:         #000000;   /* Text-only — never large areas */

  /* Navy tint ladder (from brand book) */
  --sav-navy-70:       #696975;
  --sav-navy-50:       #93949E;
  --sav-navy-30:       #BEBFC4;
  --sav-navy-20:       #D2D2D6;
  --sav-navy-10:       #E8E8EB;

  /* Steel-grey tint ladder */
  --sav-steel-70:      #A1A7AD;
  --sav-steel-50:      #BDC2C7;
  --sav-steel-30:      #D7DADE;
  --sav-steel-20:      #E3E6E8;
  --sav-steel-15:      #E9E9EB;
  --sav-steel-10:      #F2F3F5;

  /* Secondary palette — exact brand-book hexes. One accent per execution. */
  --sav-teal:          #238291;
  --sav-blue:          #097CE8;
  --sav-purple:        #83007E;
  --sav-green:         #3AA95C;
  --sav-orange:        #EF6B00;
  --sav-pink:          #D3397F;

  /* ===== Semantic color tokens ========================================== */

  --color-bg:              var(--sav-white);
  --color-bg-alt:          var(--sav-stone);
  --color-bg-brand:        var(--sav-yellow);
  --color-bg-scrim:        rgba(37, 39, 58, 0.55);

  --color-fg:              var(--sav-ink);          /* body text */
  --color-fg-muted:        var(--sav-slate);        /* secondary copy */
  --color-fg-on-yellow:    var(--sav-ink);          /* text over yellow */
  --color-fg-on-ink:       var(--sav-white);        /* text over ink panels */
  --color-fg-brand:        var(--sav-red);          /* logo, accent text */
  --color-fg-link:         var(--sav-ink);
  --color-fg-link-hover:   var(--sav-red);

  --color-border:          var(--sav-slate);        /* 1px table rules */
  --color-border-strong:   var(--sav-ink);          /* 2px strong dividers */
  --color-divider:         rgba(37, 39, 58, 0.12);

  --color-focus-ring:      var(--sav-ink);

  /* Status / data viz — from the secondary palette. Teal is the recommended
     lead chart colour because it's complementary to Savills Yellow. */
  --color-info:            var(--sav-teal);
  --color-data-1:          var(--sav-teal);
  --color-data-2:          var(--sav-blue);
  --color-data-3:          var(--sav-purple);
  --color-data-4:          var(--sav-green);
  --color-data-5:          var(--sav-orange);
  --color-data-6:          var(--sav-pink);

  /* ===== Type stacks ==================================================== */

  --font-display:  "Gotham", "Montserrat", "Tahoma", Arial, sans-serif;
  --font-body:     "Gotham", "Montserrat", "Tahoma", Arial, sans-serif;
  --font-serif:    "Playfair Display", "Cambria", Georgia, "Times New Roman", serif;
                                                       /* quotes, lifestyle, campaign heads */
  --font-mono:     "JetBrains Mono", "Consolas", "Courier New", monospace;
                                                       /* dev/system only */

  /* ===== Type scale (matched to 16:9 slides + A4 docs) =================== */

  --fs-display-xl: 64px;  --lh-display-xl: 1.05;
  --fs-display-l:  48px;  --lh-display-l:  1.10;
  --fs-h1:         32px;  --lh-h1:         1.20;
  --fs-h2:         24px;  --lh-h2:         1.25;
  --fs-h3:         18px;  --lh-h3:         1.30;
  --fs-body-lg:    16px;  --lh-body-lg:    1.55;
  --fs-body:       14px;  --lh-body:       1.55;
  --fs-caption:    11px;  --lh-caption:    1.45;

  /* Tracking */
  --tracking-display: -0.01em;
  --tracking-utility:  0.08em;   /* uppercase labels */
  --tracking-body:     0;

  /* ===== Spacing & layout =============================================== */

  --space-1:  4px;
  --space-2:  8px;
  --space-3:  12px;
  --space-4:  16px;
  --space-5:  24px;
  --space-6:  32px;
  --space-7:  48px;
  --space-8:  64px;
  --space-9:  96px;

  /* ===== Radii — Savills uses hard 90° corners. ========================= */
  --radius-none:  0;
  --radius-xs:    2px;   /* web input fields only */

  /* ===== Borders ======================================================== */
  --border-hair:    1px solid var(--color-border);
  --border-strong:  2px solid var(--color-border-strong);

  /* ===== Elevation — essentially none. ================================== */
  --shadow-none:   none;
  --shadow-hair:   0 1px 0 rgba(37, 39, 58, 0.08);   /* web product only */

  /* ===== Motion ========================================================= */
  --dur-fast:   100ms;
  --dur-base:   150ms;
  --dur-slow:   200ms;
  --ease-out:   cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in:    cubic-bezier(0.7, 0, 0.84, 0);

  /* ===== Z-index ======================================================== */
  --z-base:   1;
  --z-card:   10;
  --z-nav:    100;
  --z-modal:  1000;
}

/* ============================================================================
   Semantic / element styles — drop-in defaults for any HTML page.
   Use the .sav-doc wrapper class so these don't leak into 3rd-party widgets.
   ============================================================================ */

.sav-doc {
  font-family: var(--font-body);
  font-size: var(--fs-body);
  line-height: var(--lh-body);
  color: var(--color-fg);
  background: var(--color-bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

.sav-doc h1, .sav-doc .h1 {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: var(--fs-h1);
  line-height: var(--lh-h1);
  letter-spacing: var(--tracking-display);
  color: var(--color-fg);
  margin: 0 0 var(--space-4);
}

.sav-doc h2, .sav-doc .h2 {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: var(--fs-h2);
  line-height: var(--lh-h2);
  color: var(--color-fg);
  margin: 0 0 var(--space-3);
}

.sav-doc h3, .sav-doc .h3 {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: var(--fs-h3);
  line-height: var(--lh-h3);
  color: var(--color-fg);
  margin: 0 0 var(--space-2);
}

.sav-doc .display-xl {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: var(--fs-display-xl);
  line-height: var(--lh-display-xl);
  letter-spacing: var(--tracking-display);
}

.sav-doc .display-l {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: var(--fs-display-l);
  line-height: var(--lh-display-l);
  letter-spacing: var(--tracking-display);
}

.sav-doc p {
  margin: 0 0 var(--space-3);
  text-wrap: pretty;
}

.sav-doc .label,
.sav-doc .utility {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  text-transform: uppercase;
  letter-spacing: var(--tracking-utility);
  color: var(--color-fg);
}

.sav-doc .caption {
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  color: var(--color-fg-muted);
}

.sav-doc a {
  color: var(--color-fg-link);
  text-decoration: underline;
  text-underline-offset: 2px;
  text-decoration-thickness: 1px;
  transition: color var(--dur-base) var(--ease-out);
}
.sav-doc a:hover { color: var(--color-fg-link-hover); }

.sav-doc :focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
}

/* Hard-cornered card primitives ------------------------------------------- */
.sav-card {
  background: var(--sav-stone);
  padding: var(--space-5);
  border-radius: 0;
}
.sav-card--bordered {
  background: var(--sav-white);
  border: var(--border-hair);
  padding: var(--space-5);
  border-radius: 0;
}
.sav-callout {
  background: var(--sav-yellow);
  color: var(--color-fg-on-yellow);
  padding: var(--space-5);
  border-radius: 0;
}

/* Button primitives ------------------------------------------------------- */
.sav-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-5);
  font-family: var(--font-display);
  font-weight: 700;
  font-size: var(--fs-body);
  letter-spacing: var(--tracking-utility);
  text-transform: uppercase;
  border: 0;
  border-radius: 0;
  cursor: pointer;
  transition: background var(--dur-base) var(--ease-out),
              color var(--dur-base) var(--ease-out);
}
.sav-btn--primary {
  background: var(--sav-yellow);
  color: var(--sav-ink);
}
.sav-btn--primary:hover { background: var(--sav-yellow-press); }

.sav-btn--secondary {
  background: var(--sav-ink);
  color: var(--sav-white);
}
.sav-btn--secondary:hover { background: #14152a; }

.sav-btn--ghost {
  background: transparent;
  color: var(--sav-ink);
  border: 2px solid var(--sav-ink);
  height: 36px;
}
.sav-btn--ghost:hover { background: var(--sav-ink); color: var(--sav-white); }
