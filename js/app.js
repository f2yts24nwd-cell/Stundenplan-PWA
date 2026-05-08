'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'vplan_settings';
const CORS_PROXY = 'https://corsproxy.io/?';
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WEEKDAY_LABELS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];

// ── State ──────────────────────────────────────────────────────────────────
let weekOffset = 0;       // offset from auto-detected target week
let lastEntries = null;   // last successfully fetched entries
let refreshTimer = null;

// ── Settings ───────────────────────────────────────────────────────────────
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function settingsAreComplete(s) {
  return s && s.url && s.klasse;
}

// ── Date / week helpers ────────────────────────────────────────────────────
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function getMondayOf(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getISOWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getAutoTargetDate() {
  const now = new Date();
  const day = now.getDay(); // 5=Friday
  // Saturday (6), Sunday (0), or Friday after noon → show next week
  if (day === 6 || day === 0 || (day === 5 && now.getHours() >= 12)) {
    return addDays(now, day === 6 ? 2 : day === 0 ? 1 : 7);
  }
  return now;
}

function getTargetDate() {
  const base = getAutoTargetDate();
  return addDays(base, weekOffset * 7);
}

function formatDate(date) {
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatDateShort(date) {
  return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
}

// Build the week label shown in the header bar
function buildWeekLabel(targetDate) {
  const monday = getMondayOf(targetDate);
  const friday = addDays(monday, 4);
  const kw = getISOWeekNumber(monday);
  return `KW ${kw} · ${formatDateShort(monday)}–${formatDateShort(friday)}.${friday.getFullYear()}`;
}

// ── Fetch & parse ──────────────────────────────────────────────────────────

function authHeaders(settings) {
  const h = {};
  if (settings.user && settings.pass) {
    h['Authorization'] = 'Basic ' + btoa(unescape(encodeURIComponent(`${settings.user}:${settings.pass}`)));
  }
  return h;
}

// Returns true if the <select> is a calendar-week selector
function isWeekSelector(select) {
  const name = select.name.toLowerCase();
  if (name.includes('week') || name.includes('kw') || name.includes('woche') || name.includes('calendar')) return true;
  const opts = [...select.options];
  return opts.some(o =>
    /^\d{6}$/.test(o.value) ||
    /KW\s*\d+/i.test(o.text) ||
    /Woche\s*\d+/i.test(o.text) ||
    /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(o.text.trim()) // e.g. "4.5.2026"
  );
}

// Find the option value matching the target week.
// Handles: YYYYWW, bare KW number, and German date "D.M.YYYY" (Monday of week).
function findWeekOption(opts, kw, year, monday) {
  const yyyyww = `${year}${String(kw).padStart(2, '0')}`;
  const d = monday.getDate();
  const m = monday.getMonth() + 1;
  // All plausible text/value representations of the target Monday
  const candidates = [
    yyyyww,                                                              // 202618
    `${d}.${m}.${year}`,                                                 // 4.5.2026
    `${String(d).padStart(2,'0')}.${String(m).padStart(2,'0')}.${year}`, // 04.05.2026
    `${year}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`, // 2026-05-04
    String(kw),
  ];
  for (const c of candidates) {
    const found = opts.find(o => o.value === c || o.text.trim() === c);
    if (found) return found.value;
  }
  // Text contains KW number
  const byKw = opts.find(o => o.text.includes(`KW ${kw}`) || o.text.includes(`KW${kw}`));
  if (byKw) return byKw.value;
  return null;
}

// Submits the Untis filter form changing ONLY the week selector.
// All other dropdowns (Art, Element, etc.) keep their page-default values.
// Returns { doc, debug } where doc is a parsed Document (or null) and
// debug is a string describing what happened.
async function submitFilterForm(baseDoc, settings, targetDate, hdrs) {
  const form = baseDoc.querySelector('form');
  const debugLines = [];

  if (!form) {
    debugLines.push('Kein <form> gefunden auf der Seite.');
    return { doc: null, debug: debugLines.join('\n') };
  }

  const monday = getMondayOf(targetDate);
  const kw = getISOWeekNumber(monday);
  const year = monday.getFullYear();

  const method = (form.getAttribute('method') || 'get').toLowerCase();
  const action = form.getAttribute('action');
  const actionUrl = action ? new URL(action, settings.url).href : settings.url;
  debugLines.push(`Formular: method=${method}, action=${actionUrl}`);

  const data = new URLSearchParams();
  const selects = [...form.querySelectorAll('select[name]')];
  debugLines.push(`Dropdowns: ${selects.map(s => `${s.name}="${s.value}"`).join(', ')}`);

  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;

    if (el.tagName === 'SELECT') {
      const opts = [...el.options];
      if (isWeekSelector(el)) {
        const v = findWeekOption(opts, kw, year, monday);
        const chosen = v !== null ? v : (el.value || '');
        data.set(el.name, chosen);
        debugLines.push(`Woche-Select "${el.name}": "${el.value}" → "${chosen}" (KW${kw} ${monday.getDate()}.${monday.getMonth()+1}.${year})`);
      } else {
        // Keep page default – do NOT override Art/Element/other dropdowns
        data.set(el.name, el.value || '');
      }
    } else if (el.type !== 'submit' && el.type !== 'button' && el.type !== 'reset' && el.type !== 'image') {
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) data.set(el.name, el.value);
      } else {
        data.set(el.name, el.value || '');
      }
    }
  }

  debugLines.push(`Sende: ${data.toString()}`);

  let res;
  try {
    if (method === 'post') {
      res = await fetch(CORS_PROXY + encodeURIComponent(actionUrl), {
        method: 'POST',
        headers: { ...hdrs, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: data.toString(),
      });
    } else {
      const sep = actionUrl.includes('?') ? '&' : '?';
      res = await fetch(CORS_PROXY + encodeURIComponent(actionUrl + sep + data.toString()), {
        headers: hdrs,
      });
    }
  } catch (err) {
    debugLines.push(`Fetch-Fehler: ${err.message}`);
    return { doc: null, debug: debugLines.join('\n') };
  }

  debugLines.push(`Antwort: HTTP ${res.status}`);
  if (!res.ok) return { doc: null, debug: debugLines.join('\n') };

  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const titles = doc.querySelectorAll('.mon_title');
  const tables = doc.querySelectorAll('table');
  debugLines.push(`mon_title-Elemente: ${titles.length}, Tabellen: ${tables.length}`);
  if (titles.length) debugLines.push(`Erster Titel: "${titles[0].textContent.trim()}"`);

  return { doc, debug: debugLines.join('\n') };
}

async function fetchPlan(settings, targetDate) {
  const hdrs = authHeaders(settings);
  const debugLines = [];
  const monday = getMondayOf(targetDate);

  // Try two CORS proxies – corsproxy.io sometimes strips Authorization header
  const PROXIES = [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url=',
  ];

  let baseHtml = '';
  let usedProxy = '';

  for (const proxy of PROXIES) {
    try {
      const r = await fetch(proxy + encodeURIComponent(settings.url), { headers: hdrs });
      const text = await r.text();
      debugLines.push(`${proxy}: HTTP ${r.status}, ${text.length} Zeichen`);
      if (text.length > 100) {
        baseHtml = text;
        usedProxy = proxy;
        break;
      }
    } catch (e) {
      debugLines.push(`${proxy}: Fehler – ${e.message}`);
    }
  }

  if (!baseHtml) throw new Error('Alle Proxies liefern leere Antwort. Bitte URL und Zugangsdaten prüfen.');

  // Show full raw HTML of main page (it's only ~1976 chars)
  debugLines.push(`Roher HTML (voll): "${baseHtml.replace(/\s+/g,' ')}"`);

  const baseDoc = new DOMParser().parseFromString(baseHtml, 'text/html');
  const baseDir = settings.url.replace(/\/[^/]*$/, '/');

  // ── Frameset detection (classic Untis 2026 uses <FRAMESET>) ───────────────
  // DOMParser may not preserve <frame> in all browsers; also search raw HTML
  const frameSrcsFromDom = [...baseDoc.querySelectorAll('frame, iframe')]
    .map(f => f.getAttribute('src')).filter(Boolean);

  // Also parse raw HTML with regex as backup (DOMParser may drop frameset)
  const frameSrcsFromRaw = [];
  const frameRe = /<frame[^>]+src=["']?([^"'\s>]+)["']?/gi;
  let fm;
  while ((fm = frameRe.exec(baseHtml)) !== null) frameSrcsFromRaw.push(fm[1]);

  const frameSrcs = [...new Set([...frameSrcsFromDom, ...frameSrcsFromRaw])];
  debugLines.push(`Frames (DOM): ${frameSrcsFromDom.join(', ') || '(keine)'}`);
  debugLines.push(`Frames (Regex): ${frameSrcsFromRaw.join(', ') || '(keine)'}`);

  // Fetch each frame – for the navbar, extract topDir + week value + class index
  const frameEntries = [];
  const navbarData = { topDir: 't', weekValue: '', classIdx: 0 };
  let contentUrlsFromNavbar = [];

  for (const src of frameSrcs) {
    const frameUrl = new URL(src, settings.url).href;
    try {
      const r = await fetch(usedProxy + encodeURIComponent(frameUrl), { headers: hdrs });
      const html = r.ok ? await r.text() : '';
      const fd = new DOMParser().parseFromString(html, 'text/html');
      const tables = fd.querySelectorAll('table');
      debugLines.push(`Frame "${src}": HTTP ${r.status}, ${html.length} chars, ${tables.length} Tabellen`);
      if (!r.ok || !html) continue;

      // Log all small frames fully to find alternative data URLs
      if (src.includes('welcome') || src.includes('title') || src.includes('fuss')) {
        debugLines.push(`${src} Inhalt: "${html.replace(/\s+/g,' ')}"`);
        continue;
      }

      // ── Navbar: extract topDir, week value, and class index ───────────────
      if (src.includes('navbar') || src.includes('nav')) {
        const inlineJs = [...fd.querySelectorAll('script:not([src])')].map(s => s.textContent).join('\n');

        // Extract topDir (e.g. var topDir = "t")
        const topDirM = inlineJs.match(/topDir\s*=\s*["']([^"']+)["']/);
        if (topDirM) navbarData.topDir = topDirM[1];

        // Extract classes array to find the index of the configured class
        const classesM = inlineJs.match(/var\s+classes\s*=\s*\[([^\]]+)\]/);
        if (classesM) {
          const names = classesM[1].match(/"([^"]+)"/g)?.map(s => s.slice(1, -1)) || [];
          const idx = names.findIndex(n => n.toLowerCase() === settings.klasse.toLowerCase());
          navbarData.classIdx = idx >= 0 ? idx + 1 : 0; // 1-based; 0 = Alle
          navbarData.classNames = names;
        }

        // Extract week and type selects from the navbar form
        const kw = getISOWeekNumber(monday);
        for (const sel of fd.querySelectorAll('select')) {
          const opts = [...sel.options];
          debugLines.push(`Select "${sel.name || sel.id}": ${opts.slice(0,8).map(o=>`${o.value}=${o.text.trim()}`).join(' | ')}`);

          // Week selector: option value is a bare number matching KW
          if (opts.some(o => parseInt(o.value) === kw || parseInt(o.value) === kw - 1)) {
            // Store ALL available week values for fallback attempts
            navbarData.availableWeeks = opts.map(o => o.value).filter(v => /^\d+$/.test(v));
            const match = opts.find(o => parseInt(o.value) === kw);
            if (match) navbarData.weekValue = match.value;
            // If target week not found, use the last available week
            if (!match && navbarData.availableWeeks.length > 0) {
              navbarData.weekValue = navbarData.availableWeeks[navbarData.availableWeeks.length - 1];
            }
          }

          // Type selector (e.g. "w"=HP-Kla, "c"=Lehrer)
          if ((sel.name || '').toLowerCase() === 'type' && opts.length > 0) {
            navbarData.typeCode = opts[0].value; // use first option as default type
          }
        }

        // If class index still 0, try to read it from the element select
        if (navbarData.classIdx === 0) {
          const elSel = fd.querySelector('select[name="element"]');
          if (elSel) {
            const elOpts = [...elSel.options];
            const elMatch = elOpts.find(o => o.text.trim().toLowerCase() === settings.klasse.toLowerCase());
            if (elMatch) navbarData.classIdx = parseInt(elMatch.value, 10);
          }
        }

        debugLines.push(`topDir="${navbarData.topDir}", weekValue="${navbarData.weekValue}", classIdx=${navbarData.classIdx}, typeCode="${navbarData.typeCode || 'w'}"`);
        debugLines.push(`classNames: ${(navbarData.classNames || []).join(', ') || '(keine)'}`);

        // Log any URL-building pattern in navbar inline JS
        const urlBuildFn = inlineJs.match(/(function\s+\w*[Dd]isplay\w*[^}]+}|postMessage[^;]+;|location\.href[^;]+;)/);
        if (urlBuildFn) debugLines.push(`Navbar URL-Funktion: "${urlBuildFn[0].slice(0, 300)}"`);
        // Also show first 500 chars of inline JS for manual inspection
        debugLines.push(`Navbar JS (500 ch): "${inlineJs.slice(0, 500)}"`);

        continue;
      }

      // ── Data frames: look for substitution tables ─────────────────────────
      const titleEls = [...fd.querySelectorAll('.mon_title')];
      if (titleEls.length > 0) {
        frameEntries.push(...parseVertretungsplan(fd, settings.klasse, targetDate));
      } else {
        const dayNum = src.match(/(\d+)\.[^.]+$/)?.[1];
        const idx = dayNum ? parseInt(dayNum, 10) - 1 : 0;
        const datumNorm = (idx >= 0 && idx < 5) ? addDays(monday, idx).toISOString().slice(0, 10) : '';
        const tbl = fd.querySelector('table.mon_list') || fd.querySelector('table');
        if (tbl) frameEntries.push(...parseMonListTable(tbl, settings.klasse, datumNorm));
      }
    } catch (e) {
      debugLines.push(`Frame "${src}" Fehler: ${e.message}`);
    }
  }

  // ── Fetch untisscripts.js – show up to 4000 chars + find doDisplayTimetable ──
  try {
    const scriptUrl = baseDir + 'untisscripts.js';
    const sr = await fetch(usedProxy + encodeURIComponent(scriptUrl), { headers: hdrs });
    const scriptText = sr.ok ? await sr.text() : `HTTP ${sr.status}`;
    // Find doDisplayTimetable function for URL pattern insight
    const fnIdx = scriptText.indexOf('doDisplayTimetable');
    if (fnIdx >= 0) {
      debugLines.push(`doDisplayTimetable @ ${fnIdx}: "${scriptText.slice(fnIdx, fnIdx + 800)}"`);
    } else {
      debugLines.push(`untisscripts.js (4000 ch): "${scriptText.slice(0, 4000)}"`);
    }
  } catch (e) {
    debugLines.push(`untisscripts.js Fehler: ${e.message}`);
  }

  // ── Try alternative root-level substitution pages ─────────────────────────
  {
    const altPaths = ['subst_001.htm', 'vertretung.htm', 'vplan.htm', 'subst.htm',
                      'aktuell.htm', 'today.htm', 'index.htm', ''];
    for (const p of altPaths) {
      try {
        const altUrl = new URL(p, settings.url).href;
        const r = await fetch(usedProxy + encodeURIComponent(altUrl), { headers: hdrs });
        const html = await r.text();
        debugLines.push(`Alt "${p}": HTTP ${r.status}, ${html.length} ch, preview: "${html.slice(0,200).replace(/\s+/g,' ')}"`);
      } catch(e) { /* ignore */ }
    }
  }

  // ── Fetch content using correct Untis URL pattern: type/week/typeN2str.htm ──
  // doDisplayTimetable (from untisscripts.js) builds:
  //   url = type + "/" + week + "/" + type + n2str(element) + ".htm"
  // e.g. "w/20/w00003.htm" for class 5C (element index 3) in KW 20
  if (frameEntries.length === 0 && navbarData.weekValue) {
    const { weekValue, classIdx } = navbarData;
    const typeCode = navbarData.typeCode || 'w';
    const n2str = n => String(n).padStart(5, '0');

    // Try target week first, then all other available weeks
    const allWeeks = navbarData.availableWeeks || [weekValue];
    const orderedWeeks = [weekValue, ...[...allWeeks].reverse().filter(w => w !== weekValue)];

    let found = 0;

    for (const wk of orderedWeeks) {
      if (found > 0) break;

      // Correct URL pattern: type/week/typeN2str(element).htm
      const classFile = classIdx > 0
        ? `${typeCode}/${wk}/${typeCode}${n2str(classIdx)}.htm`
        : null;

      // Also try the day-substitution files with correct pattern
      const dayFiles = [1,2,3,4,5].map(n => `${typeCode}/${wk}/subst_${n2str(n)}.htm`);

      // Also probe element=1 (first class, 5A) to check if ANY data is accessible
      const probeFile = `${typeCode}/${wk}/${typeCode}${n2str(1)}.htm`;
      const candidates = [...(classFile ? [classFile] : []), probeFile, ...dayFiles];
      const baseResolved = new URL(candidates[0], settings.url).href;
      debugLines.push(`Versuche (KW ${wk}): ${candidates.slice(0,3).join(', ')}...`);
      debugLines.push(`Basis-URL: ${baseResolved}`);

      for (let i = 0; i < candidates.length; i++) {
        const f = candidates[i];
        const fileUrl = new URL(f, settings.url).href;
        try {
          const r = await fetch(usedProxy + encodeURIComponent(fileUrl), { headers: hdrs });
          const html = await r.text(); // always read body to diagnose 404 content
          const preview = html.slice(0, 300).replace(/\s+/g, ' ');
          debugLines.push(`${f}: HTTP ${r.status}, ${html.length} ch, preview: "${preview}"`);
          if (!r.ok || html.length < 200) continue;
          found++;
          const d = new DOMParser().parseFromString(html, 'text/html');
          if (i === 0 && classFile) {
            // Class view: use main parser (finds mon_title sections)
            frameEntries.push(...parseVertretungsplan(d, settings.klasse, targetDate));
          } else {
            // Day file: associate with the day
            const dayIdx = classFile ? i - 1 : i;
            const datumNorm = addDays(monday, dayIdx).toISOString().slice(0, 10);
            const tbl = d.querySelector('table.mon_list') || d.querySelector('table');
            if (tbl) frameEntries.push(...parseMonListTable(tbl, settings.klasse, datumNorm));
          }
        } catch (e) {
          debugLines.push(`${f}: Fehler ${e.message}`);
        }
      }
    }
  }
  debugLines.push(`Frame-Einträge gesamt: ${frameEntries.length}`);

  // ── Fallback: known day-file names in same directory ──────────────────────
  const dayEntries = [];
  if (frameEntries.length === 0 && frameSrcs.length === 0) {
    const dayFiles = ['subst_001.htm', 'subst_002.htm', 'subst_003.htm', 'subst_004.htm', 'subst_005.htm'];
    let found = 0;
    for (let i = 0; i < 5; i++) {
      const dayUrl = baseDir + dayFiles[i];
      const datumNorm = addDays(monday, i).toISOString().slice(0, 10);
      try {
        const r = await fetch(usedProxy + encodeURIComponent(dayUrl), { headers: hdrs });
        if (!r.ok) continue;
        found++;
        const html = await r.text();
        const d = new DOMParser().parseFromString(html, 'text/html');
        dayEntries.push(...parseMonListTable(d.querySelector('table.mon_list') || d.querySelector('table'), settings.klasse, datumNorm));
      } catch { /* not available */ }
    }
    debugLines.push(`Fallback-Tagesdateien: ${found}/5, Einträge: ${dayEntries.length}`);
  }

  // ── Choose best result ─────────────────────────────────────────────────────
  const allEntries = frameEntries.length > 0 ? frameEntries
    : dayEntries.length > 0 ? dayEntries
    : parseVertretungsplan(baseDoc, settings.klasse, targetDate);

  debugLines.push(`Gesamte Einträge für "${settings.klasse}": ${allEntries.length}`);
  return { entries: allEntries, debug: debugLines.join('\n') };
}

function cellText(cell) {
  return cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '';
}

// Extract YYYY-MM-DD from a day title like "4.5.2026 Montag" or "Montag 4.5.2026"
function parseTitleDate(text) {
  const m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
}

// Determine entry type from actual column values (LMG/Untis semantics):
// Fach    = replacement subject ("---" means lesson is cancelled)
// stattFach = original scheduled subject
// Raum    = replacement room
// stattRaum = original room
function detectTypFromColumns(fach, stattFach, raum, stattRaum, info) {
  const infoL = info.toLowerCase();
  if (infoL.includes('and.raum') || infoL.includes('raumänderung')) return 'raum';
  if (!fach || fach === '---') return 'ausfall';
  if (fach === stattFach && raum !== stattRaum && raum && raum !== '---') return 'raum';
  if (fach !== stattFach) return 'vertretung';
  return 'other';
}

// Map actual LMG column header texts to canonical keys.
// LMG columns: Klasse(n) | Stunde | Fach | statt Fach | Raum | statt Raum | Vertr. von | Text
function buildColMap(headers) {
  const map = {};
  const variants = {
    klasse:     ['klasse', 'class', 'kl.', 'kl'],
    stunde:     ['stunde', 'std', 'periode', 'hour'],
    fach:       ['fach'],          // matched before 'statt fach'
    stattfach:  ['statt fach', 'statt-fach'],
    raum:       ['raum'],          // matched before 'statt raum'
    stattraum:  ['statt raum', 'statt-raum'],
    vertreter:  ['vertr. von', 'vertr.von', 'vertreter', 'lehrer', 'vert.'],
    info:       ['text', 'info', 'hinweis', 'bemerkung', 'art'],
    datum:      ['datum', 'date', 'tag'],
  };
  headers.forEach((h, i) => {
    for (const [key, vs] of Object.entries(variants)) {
      // Use exact-prefix match to avoid 'fach' matching 'statt fach' first
      if (vs.some(v => h === v || h.startsWith(v))) {
        if (!(key in map)) map[key] = i;
        break;
      }
    }
  });
  return map;
}

// Parse a single mon_list table, associating all rows with datumNorm.
function parseMonListTable(table, klasse, datumNorm) {
  const klasseLower = klasse.toLowerCase().trim();
  const rows = [...table.querySelectorAll('tr')];
  let colMap = null;
  const entries = [];

  for (const row of rows) {
    const headerCells = [...row.querySelectorAll('th')];
    if (headerCells.length && !colMap) {
      colMap = buildColMap(headerCells.map(c => c.textContent.trim().toLowerCase()));
      continue;
    }
    const cells = [...row.querySelectorAll('td')];
    if (!cells.length) continue;

    // Skip "Vertretungen sind nicht freigegeben" rows
    if (cells.length === 1) continue;

    if (!row.textContent.toLowerCase().includes(klasseLower)) continue;

    if (!colMap) {
      // Default LMG positional order
      colMap = { klasse:0, stunde:1, fach:2, stattfach:3, raum:4, stattraum:5, vertreter:6, info:7 };
    }

    const get = (key) => colMap[key] !== undefined ? cellText(cells[colMap[key]]) : '';
    const fach      = get('fach');
    const stattFach = get('stattfach');
    const raum      = get('raum');
    const stattRaum = get('stattraum');
    const info      = get('info');

    entries.push({
      datumNorm,
      datum:     get('datum'),
      stunde:    get('stunde'),
      klasse:    get('klasse'),
      fach,
      stattFach,
      raum,
      stattRaum,
      vertreter: get('vertreter'),
      info,
      typ: detectTypFromColumns(fach, stattFach, raum, stattRaum, info),
    });
  }
  return entries;
}

// Main parser: finds per-day sections (mon_title + mon_list) in Untis HTML.
function parseVertretungsplan(doc, klasse, targetDate) {
  const monday = getMondayOf(targetDate);
  const entries = [];

  // Find all day title elements (Untis uses class="mon_title")
  const titleEls = [...doc.querySelectorAll('.mon_title, td.mon_title, span.mon_title, div.mon_title')];

  if (titleEls.length > 0) {
    for (const titleEl of titleEls) {
      const datumNorm = parseTitleDate(titleEl.textContent);

      // Walk up/sideways in DOM to find the nearest mon_list table
      let table = null;
      let cursor = titleEl.parentElement;
      while (cursor && !table) {
        table = cursor.querySelector('table.mon_list');
        if (!table) {
          // Try next sibling of cursor
          let sib = cursor.nextElementSibling;
          while (sib && !table) {
            table = sib.tagName === 'TABLE' ? sib : sib.querySelector('table');
            sib = sib.nextElementSibling;
          }
        }
        cursor = cursor.parentElement;
      }

      if (table) {
        entries.push(...parseMonListTable(table, klasse, datumNorm));
      }
    }
    return entries;
  }

  // Fallback: no mon_title found – scan all tables with header rows
  const allTables = [...doc.querySelectorAll('table.mon_list, table.list, table')];
  for (const table of allTables) {
    if (table.querySelectorAll('tr').length < 2) continue;
    // Try to find a date near this table
    let datumNorm = '';
    let prev = table.previousElementSibling;
    for (let i = 0; i < 5 && prev; i++, prev = prev.previousElementSibling) {
      datumNorm = parseTitleDate(prev.textContent);
      if (datumNorm) break;
    }
    entries.push(...parseMonListTable(table, klasse, datumNorm));
    if (entries.length > 0) break; // only first useful table in fallback
  }
  return entries;
}

// ── Rendering ──────────────────────────────────────────────────────────────
function render(entries, targetDate, debug) {
  const content = document.getElementById('content');
  const monday = getMondayOf(targetDate);

  // Build a map: YYYY-MM-DD → entries[]
  const byDate = {};
  for (let i = 0; i < 5; i++) {
    const d = addDays(monday, i);
    byDate[d.toISOString().slice(0, 10)] = [];
  }

  // Also bucket by weekday index for entries without a parseable date
  for (const e of entries) {
    if (e.datumNorm && byDate.hasOwnProperty(e.datumNorm)) {
      byDate[e.datumNorm].push(e);
    } else {
      // Try to match by day name in datum field
      let placed = false;
      for (let i = 0; i < 5; i++) {
        const d = addDays(monday, i);
        const iso = d.toISOString().slice(0, 10);
        if (e.datum && DAY_NAMES[d.getDay()] && e.datum.toLowerCase().includes(DAY_NAMES[d.getDay()].toLowerCase().slice(0, 2))) {
          byDate[iso].push(e);
          placed = true;
          break;
        }
      }
      // If we still couldn't place it, drop into the monday bucket as fallback
      if (!placed) {
        const mondayIso = monday.toISOString().slice(0, 10);
        byDate[mondayIso].push(e);
      }
    }
  }

  const html = Object.entries(byDate).map(([iso, dayEntries]) => {
    const date = new Date(iso + 'T00:00:00');
    const dayName = WEEKDAY_LABELS[date.getDay() - 1] || DAY_NAMES[date.getDay()];
    const dateStr = formatDateShort(date) + '.' + date.getFullYear();

    let entriesHtml;
    if (dayEntries.length === 0) {
      entriesHtml = `<div class="no-change">Kein Ausfall</div>`;
    } else {
      entriesHtml = dayEntries.map(e => renderEntry(e)).join('');
    }

    return `
      <div class="day-card">
        <div class="day-header">
          <span class="day-name">${dayName}</span>
          <span class="day-date">${dateStr}</span>
        </div>
        ${entriesHtml}
      </div>`;
  }).join('');

  const totalEntries = Object.values(byDate).flat().length;
  if (totalEntries === 0 && debug) {
    content.innerHTML = html + `<div class="debug-panel"><strong>Diagnose (0 Eintr&auml;ge):</strong><pre>${escHtml(debug)}</pre></div>`;
  } else {
    content.innerHTML = html || '<div class="loading">Keine Eintr&auml;ge gefunden.</div>';
  }
}

function renderEntry(e) {
  const typClass = e.typ === 'ausfall' ? 'ausfall' : e.typ === 'vertretung' ? 'vertretung' : e.typ === 'raum' ? 'raum' : '';

  let badge = '';
  if (e.typ === 'ausfall')     badge = '<span class="entry-badge badge-ausfall">Ausfall</span>';
  else if (e.typ === 'vertretung') badge = '<span class="entry-badge badge-vertretung">Vertretung</span>';
  else if (e.typ === 'raum')   badge = '<span class="entry-badge badge-raum">and.Raum</span>';

  // Subject line: show replacement subject + original struck-through if different
  const fachDisplay = e.fach && e.fach !== '---' ? escHtml(e.fach) : '<em>entfällt</em>';
  const origFach = e.stattFach && e.stattFach !== e.fach && e.stattFach !== '---'
    ? ` <span class="entry-orig">statt ${escHtml(e.stattFach)}</span>` : '';

  // Room line
  const raumNew  = e.raum && e.raum !== '---' ? escHtml(e.raum) : '';
  const raumOrig = e.stattRaum && e.stattRaum !== '---' && e.stattRaum !== e.raum
    ? `<span class="entry-orig">statt ${escHtml(e.stattRaum)}</span>` : '';
  const raumLine = [raumNew, raumOrig].filter(Boolean).join(' ');

  const sub = [];
  if (e.vertreter) sub.push(escHtml(e.vertreter));
  if (raumLine)    sub.push(raumLine);

  return `
    <div class="entry ${typClass}">
      <div class="entry-stunde">${escHtml(e.stunde)}</div>
      <div class="entry-details">
        <div class="entry-main">
          <span class="entry-fach">${fachDisplay}</span>${origFach}
          ${badge}
        </div>
        ${sub.length ? `<div class="entry-sub">${sub.join(' · ')}</div>` : ''}
        ${e.info ? `<div class="entry-info">${escHtml(e.info)}</div>` : ''}
      </div>
    </div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── UI updates ─────────────────────────────────────────────────────────────
function updateWeekBar() {
  const targetDate = getTargetDate();
  document.getElementById('week-label').textContent = buildWeekLabel(targetDate);
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden');
}

function setLastUpdated(date) {
  const el = document.getElementById('last-updated');
  el.textContent = 'Zuletzt aktualisiert: ' + date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
}

// ── Fetch-and-render cycle ─────────────────────────────────────────────────
async function fetchAndRender() {
  const settings = loadSettings();
  if (!settingsAreComplete(settings)) {
    document.getElementById('content').innerHTML = `
      <div class="no-settings">
        Bitte Einstellungen konfigurieren (&#9881;&#65039;).<br>
        URL und Klasse sind Pflichtfelder.
      </div>`;
    openSettings();
    return;
  }

  const targetDate = getTargetDate();
  updateWeekBar();

  try {
    const { entries, debug } = await fetchPlan(settings, targetDate);
    lastEntries = entries;
    render(entries, targetDate, debug);
    setLastUpdated(new Date());
    hideError();
  } catch (err) {
    showError('Fehler beim Laden: ' + err.message);
    if (lastEntries !== null) {
      render(lastEntries, targetDate, null);
    } else {
      document.getElementById('content').innerHTML = '<div class="loading">Keine Daten verfügbar.</div>';
    }
  }
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(fetchAndRender, REFRESH_INTERVAL_MS);
}

// ── Settings UI ────────────────────────────────────────────────────────────
function openSettings() {
  const s = loadSettings();
  document.getElementById('s-url').value = s.url || '';
  document.getElementById('s-user').value = s.user || '';
  document.getElementById('s-pass').value = s.pass || '';
  document.getElementById('s-klasse').value = s.klasse || '';
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Settings button
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-cancel-btn').addEventListener('click', closeSettings);

  // Close overlay on backdrop click
  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('settings-overlay')) closeSettings();
  });

  // Save settings
  document.getElementById('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const s = {
      url:    document.getElementById('s-url').value.trim(),
      user:   document.getElementById('s-user').value.trim(),
      pass:   document.getElementById('s-pass').value,
      klasse: document.getElementById('s-klasse').value.trim(),
    };
    saveSettings(s);
    closeSettings();
    weekOffset = 0;
    lastEntries = null;
    fetchAndRender();
    scheduleRefresh();
  });

  // Week navigation
  document.getElementById('prev-week-btn').addEventListener('click', () => {
    weekOffset--;
    fetchAndRender();
  });

  document.getElementById('next-week-btn').addEventListener('click', () => {
    weekOffset++;
    fetchAndRender();
  });

  // Initial load
  updateWeekBar();
  fetchAndRender();
  scheduleRefresh();

  // Refresh on visibility change (foreground only)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      fetchAndRender();
      scheduleRefresh();
    } else {
      clearInterval(refreshTimer);
    }
  });
});
