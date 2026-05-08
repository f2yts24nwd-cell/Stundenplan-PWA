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

// LOCAL date → "YYYY-MM-DD" without UTC offset shift (toISOString() uses UTC)
function isoDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Build the week label shown in the header bar
function buildWeekLabel(targetDate) {
  const monday = getMondayOf(targetDate);
  const friday = addDays(monday, 4);
  const kw = getISOWeekNumber(monday);
  // formatDateShort returns "08.05." (trailing dot in de-DE), so no extra dot needed
  return `KW ${kw} · ${formatDateShort(monday)}–${formatDateShort(friday)}${friday.getFullYear()}`;
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

  // ── Step 1: fetch main page (try both proxies, skip on 429) ──────────────
  const PROXIES = ['https://corsproxy.io/?', 'https://api.allorigins.win/raw?url='];
  let baseHtml = '';
  let usedProxy = '';

  for (const proxy of PROXIES) {
    try {
      const r = await fetch(proxy + encodeURIComponent(settings.url), { headers: hdrs });
      if (r.status === 429) { debugLines.push(`${proxy}: 429 Rate limit`); continue; }
      const text = await r.text();
      debugLines.push(`Proxy: ${proxy.split('?')[0]}, HTTP ${r.status}`);
      if (r.ok && text.length > 100) { baseHtml = text; usedProxy = proxy; break; }
    } catch (e) {
      debugLines.push(`Proxy Fehler: ${e.message}`);
    }
  }
  if (!baseHtml) throw new Error('Proxy nicht erreichbar oder Rate Limit. Bitte etwas warten.');

  const baseDoc = new DOMParser().parseFromString(baseHtml, 'text/html');

  // ── Step 2: find navbar frame src via regex (DOMParser drops frameset) ───
  const frameRe = /<frame[^>]+src=["']?([^"'\s>]+)["']?/gi;
  const allFrames = [];
  let fm;
  while ((fm = frameRe.exec(baseHtml)) !== null) allFrames.push(fm[1]);
  const navbarSrc = allFrames.find(s => s.includes('navbar') || s.includes('nav'));
  debugLines.push(`Frames: ${allFrames.join(', ') || '(keine)'}`);

  // ── Step 3: fetch only the navbar frame ──────────────────────────────────
  const navbarData = { weekValue: '', classIdx: 0, typeCode: 'w', availableWeeks: [] };
  if (navbarSrc) {
    const navUrl = new URL(navbarSrc, settings.url).href;
    try {
      const r = await fetch(usedProxy + encodeURIComponent(navUrl), { headers: hdrs });
      if (r.ok) {
        const html = await r.text();
        const fd = new DOMParser().parseFromString(html, 'text/html');
        const inlineJs = [...fd.querySelectorAll('script:not([src])')].map(s => s.textContent).join('\n');

        // Extract classes array → find index of configured class (1-based)
        const classesM = inlineJs.match(/var\s+classes\s*=\s*\[([^\]]+)\]/);
        if (classesM) {
          const names = classesM[1].match(/"([^"]+)"/g)?.map(s => s.slice(1, -1)) || [];
          const idx = names.findIndex(n => n.toLowerCase() === settings.klasse.toLowerCase());
          navbarData.classIdx = idx >= 0 ? idx + 1 : 0;
        }

        const kw = getISOWeekNumber(monday);
        for (const sel of fd.querySelectorAll('select')) {
          const opts = [...sel.options];
          // Week selector: option values are bare KW numbers
          if (opts.some(o => parseInt(o.value) === kw || parseInt(o.value) === kw - 1)) {
            navbarData.availableWeeks = opts.map(o => o.value).filter(v => /^\d+$/.test(v));
            const match = opts.find(o => parseInt(o.value) === kw);
            navbarData.weekValue = match ? match.value
              : navbarData.availableWeeks[navbarData.availableWeeks.length - 1] || '';
          }
          // Type selector
          if ((sel.name || '').toLowerCase() === 'type' && opts.length > 0) {
            navbarData.typeCode = opts[0].value;
          }
        }
        debugLines.push(`KW ${navbarData.weekValue}, Klasse-Idx ${navbarData.classIdx}, Type "${navbarData.typeCode}"`);
      }
    } catch (e) {
      debugLines.push(`Navbar Fehler: ${e.message}`);
    }
  }

  // ── Step 4: fetch all-classes content file (element=0 → w00000.htm) ──────
  // URL pattern from doDisplayTimetable: type/week/typeN2str(element).htm
  // Element "- Alle -" has value 0 → w/19/w00000.htm shows all classes
  const entries = [];
  if (navbarData.weekValue) {
    const tc = navbarData.typeCode;
    const n2str = n => String(n).padStart(5, '0');
    const dataHdrs = { ...hdrs, 'Referer': settings.url };

    // Try target week first, then all other available weeks
    const allWeeks = navbarData.availableWeeks.length > 0
      ? navbarData.availableWeeks : [navbarData.weekValue];
    const orderedWeeks = [navbarData.weekValue,
      ...[...allWeeks].reverse().filter(w => w !== navbarData.weekValue)];

    for (const wk of orderedWeeks) {
      // "Alle" (el=0) gives all classes in one file; class-specific as fallback
      const elIndices = [0, ...(navbarData.classIdx > 0 ? [navbarData.classIdx] : [])];
      let loaded = false;
      for (const el of elIndices) {
        const f = `${tc}/${wk}/${tc}${n2str(el)}.htm`;
        const fileUrl = new URL(f, settings.url).href;
        try {
          const r = await fetch(usedProxy + encodeURIComponent(fileUrl), { headers: dataHdrs });
          const html = r.ok ? await r.text() : '';
          debugLines.push(`${f}: HTTP ${r.status}, ${html.length} ch`);
          if (!r.ok || html.length < 200) continue;
          const d = new DOMParser().parseFromString(html, 'text/html');
          entries.push(...parseVertretungsplan(d, settings.klasse, targetDate));
          loaded = true;
          break;
        } catch (e) {
          debugLines.push(`${f}: ${e.message}`);
        }
      }
      if (loaded) break;
    }
  }

  debugLines.push(`Einträge für "${settings.klasse}": ${entries.length}`);
  return { entries, debug: debugLines.join('\n') };
}

function cellText(cell) {
  return cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '';
}

// Extract YYYY-MM-DD from a day title.
// Handles: "8.5.2026 Freitag", "8.5. Freitag" (year from monday), "Freitag" (offset from monday).
function parseTitleDate(text, monday) {
  // Full date with 4-digit year: "8.5.2026"
  let m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  // Short date without year: "8.5." or "8.5. Freitag" — derive year from reference Monday
  if (monday) {
    m = text.match(/(\d{1,2})\.(\d{1,2})\./);
    if (m) return `${monday.getFullYear()}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    // Weekday name only: "Freitag" → offset from monday
    const WD = ['montag','dienstag','mittwoch','donnerstag','freitag'];
    const t = text.toLowerCase();
    for (let i = 0; i < 5; i++) {
      if (t.includes(WD[i])) return isoDateLocal(addDays(monday, i));
    }
  }
  return '';
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
      const datumNorm = parseTitleDate(titleEl.textContent, monday);

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
      datumNorm = parseTitleDate(prev.textContent, monday);
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
    byDate[isoDateLocal(d)] = [];
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
        const iso = isoDateLocal(d);
        if (e.datum && DAY_NAMES[d.getDay()] && e.datum.toLowerCase().includes(DAY_NAMES[d.getDay()].toLowerCase().slice(0, 2))) {
          byDate[iso].push(e);
          placed = true;
          break;
        }
      }
      // If we still couldn't place it, drop into the monday bucket as fallback
      if (!placed) {
        const mondayIso = isoDateLocal(monday);
        byDate[mondayIso].push(e);
      }
    }
  }

  const html = Object.entries(byDate).map(([iso, dayEntries]) => {
    const date = new Date(iso + 'T00:00:00');
    const dayName = WEEKDAY_LABELS[date.getDay() - 1] || DAY_NAMES[date.getDay()];
    const dateStr = formatDateShort(date) + date.getFullYear();

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
