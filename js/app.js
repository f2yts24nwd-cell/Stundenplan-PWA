'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const SETTINGS_KEY     = 'vplan_settings';
const STUNDENPLAN_KEY  = 'vplan_stundenplan';
const SNAPSHOT_KEY     = 'vplan_snapshot';
const LAST_UPDATED_KEY = 'vplan_last_updated';
const HISTORY_KEY      = 'vplan_history';
const PROXIES = ['https://corsproxy.io/?', 'https://api.allorigins.win/raw?url='];
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SP_PERIODS = 10;
const DAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WEEKDAY_LABELS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];
const WEEKDAY_LONG  = ['montag','dienstag','mittwoch','donnerstag','freitag'];
const WEEKDAY_SHORT = ['mo','di','mi','do','fr'];
const MONTH_SHORT = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
const MONTH_LONG  = ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'];

// ── State ──────────────────────────────────────────────────────────────────
let weekOffset = 0;
let lastEntries = null;
let refreshTimer = null;
let currentView = 'tage';
let analyticsRange = 'jahr';
let analyticsAnchor = new Date();

// ── Settings ───────────────────────────────────────────────────────────────
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
function settingsAreComplete(s) { return s && s.url && s.klasse; }

function applyDarkMode(enabled) {
  if (enabled) document.documentElement.setAttribute('data-dark', '');
  else document.documentElement.removeAttribute('data-dark');
}

// ── Date helpers ───────────────────────────────────────────────────────────
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
function getMondayOf(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
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
  const day = now.getDay();
  if (day === 6 || day === 0 || (day === 5 && now.getHours() >= 12)) {
    return addDays(now, day === 6 ? 2 : day === 0 ? 1 : 7);
  }
  return now;
}
function getTargetDate() { return addDays(getAutoTargetDate(), weekOffset * 7); }
function formatDateShort(date) { return date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); }
function isoDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function buildWeekLabel(targetDate) {
  const monday = getMondayOf(targetDate);
  const friday = addDays(monday, 4);
  const kw = getISOWeekNumber(monday);
  return `KW ${kw} · ${formatDateShort(monday)}–${formatDateShort(friday)}${friday.getFullYear()}`;
}

// ── HTTP ───────────────────────────────────────────────────────────────────
function authHeaders(settings) {
  const h = {};
  if (settings.user && settings.pass) {
    h['Authorization'] = 'Basic ' + btoa(unescape(encodeURIComponent(`${settings.user}:${settings.pass}`)));
  }
  return h;
}

// Detect charset from Content-Type header; fall back to sniffing the HTML meta tag.
function decodeWithCharset(buf, contentType) {
  let charset = ((contentType || '').match(/charset=([^\s;]+)/i) || [])[1] || '';
  if (!charset) {
    const sniff = new TextDecoder('utf-8', { fatal: false })
      .decode(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)));
    charset = (sniff.match(/<meta[^>]+charset=["']?\s*([a-z0-9_\-]+)/i) || [])[1] || 'utf-8';
  }
  return new TextDecoder(charset, { fatal: false }).decode(buf);
}

async function fetchThroughProxy(url, hdrs, debugLines) {
  for (const proxy of PROXIES) {
    try {
      const r = await fetch(proxy + encodeURIComponent(url), { headers: hdrs });
      if (r.status === 429) { debugLines && debugLines.push(`  ${proxy.split('?')[0]}: 429`); continue; }
      const buf = await r.arrayBuffer();
      const text = decodeWithCharset(buf, r.headers.get('content-type') || '');
      if (r.ok && text.length > 100) return { html: text, proxy };
      debugLines && debugLines.push(`  ${proxy.split('?')[0]}: HTTP ${r.status}, ${text.length} ch`);
    } catch (e) {
      debugLines && debugLines.push(`  ${proxy.split('?')[0]}: ${e.message}`);
    }
  }
  return { html: '', proxy: '' };
}

// Single fetch through an already-known proxy with charset-aware decoding.
async function proxyGet(proxyBase, url, hdrs) {
  try {
    const r = await fetch(proxyBase + encodeURIComponent(url), { headers: hdrs });
    if (!r.ok) return '';
    const buf = await r.arrayBuffer();
    return decodeWithCharset(buf, r.headers.get('content-type') || '');
  } catch { return ''; }
}

// Extract <frame src="..."> URLs from raw HTML (DOMParser drops framesets)
function extractFrameSrcs(html) {
  const re = /<frame[^>]+src=["']?([^"'\s>]+)["']?/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// Parse navbar JS to extract week selector value, class index, type code
function parseNavbarMeta(navDoc, monday, klasse) {
  const meta = { weekValue: '', classIdx: 0, typeCode: 'w', availableWeeks: [] };
  const inlineJs = [...navDoc.querySelectorAll('script:not([src])')].map(s => s.textContent).join('\n');

  const classesM = inlineJs.match(/var\s+classes\s*=\s*\[([^\]]+)\]/);
  if (classesM) {
    const names = classesM[1].match(/"([^"]+)"/g)?.map(s => s.slice(1, -1)) || [];
    const idx = names.findIndex(n => n.toLowerCase() === klasse.toLowerCase());
    meta.classIdx = idx >= 0 ? idx + 1 : 0;
  }

  const kw = getISOWeekNumber(monday);
  const yyyyww = monday.getFullYear() * 100 + kw; // e.g. 202638

  for (const sel of navDoc.querySelectorAll('select')) {
    const opts = [...sel.options];
    const numOpts = opts.filter(o => /^\d+$/.test(o.value.trim()));
    if (!numOpts.length) continue;

    // Identify the week selector: any value matches ISO-KW or YYYYWW format,
    // or the select name contains "week"/"kw".
    const isWeekSel = numOpts.some(o => {
      const v = parseInt(o.value);
      return v === kw || v === kw - 1 || v === yyyyww || v === yyyyww - 1;
    }) || (sel.name || '').toLowerCase().match(/week|kw|woche/);

    if (isWeekSel) {
      meta.availableWeeks = numOpts.map(o => o.value);
      const match = numOpts.find(o => { const v = parseInt(o.value); return v === kw || v === yyyyww; });
      // Fallback: use the last (most recent) available week if target not listed
      meta.weekValue = match ? match.value : numOpts[numOpts.length - 1]?.value || '';
    }
    if ((sel.name || '').toLowerCase() === 'type' && opts.length > 0) {
      meta.typeCode = opts[0].value;
    }
  }
  return meta;
}

// ── Fetcher: try multiple strategies, pick the one that yields entries ─────
async function fetchPlan(settings, targetDate) {
  const hdrs = authHeaders(settings);
  const debugLines = [];
  const monday = getMondayOf(targetDate);

  // Step 1: fetch the user-configured URL
  debugLines.push(`URL: ${settings.url}`);
  const base = await fetchThroughProxy(settings.url, hdrs, debugLines);
  if (!base.html) throw new Error('Proxy nicht erreichbar oder Rate Limit. Bitte etwas warten.');
  debugLines.push(`Basis: ${base.html.length} Zeichen`);

  let best = { entries: [], debugLines: [], source: '', hasData: false, nachrichten: {} };
  const tryParse = (html, source) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const result = parseVertretungsplan(doc, settings.klasse, targetDate);
    debugLines.push(`${source}: ${result.entries.length} Einträge, veröffentlicht: ${result.hasData}`);
    if (result.entries.length > best.entries.length ||
        (!best.hasData && result.hasData)) {
      best = { entries: result.entries, debugLines: result.debugLines, source,
               hasData: result.hasData, nachrichten: result.nachrichten };
    }
  };

  // Try parsing base directly (works when URL points straight at the data page)
  tryParse(base.html, 'Basis-URL');

  // Step 2: if no entries yet, follow frames (frameset layout)
  if (best.entries.length === 0) {
    const frames = extractFrameSrcs(base.html);
    debugLines.push(`Frames: ${frames.length ? frames.join(', ') : '(keine)'}`);

    // Find navbar frame to extract week metadata
    const navbarSrc = frames.find(s => /nav/i.test(s));
    let nav = null;
    if (navbarSrc) {
      try {
        const navUrl = new URL(navbarSrc, settings.url).href;
        const navHtml = await proxyGet(base.proxy, navUrl, hdrs);
        if (navHtml) {
          const navDoc = new DOMParser().parseFromString(navHtml, 'text/html');
          nav = parseNavbarMeta(navDoc, monday, settings.klasse);
          debugLines.push(`Navbar: KW=${nav.weekValue || '(nicht gefunden)'}, Type="${nav.typeCode}", ClassIdx=${nav.classIdx}, Wochen=[${nav.availableWeeks.slice(0,6).join(',')}${nav.availableWeeks.length > 6 ? '…' : ''}]`);
        }
      } catch (e) {
        debugLines.push(`Navbar-Fehler: ${e.message}`);
      }
    }

    // Non-navbar frames always show the currently published week regardless of the target week.
    // Skip them when the navbar confirms the target KW is not yet published (weekValue empty).
    const weekKnownUnpublished = nav && !nav.weekValue;
    if (!weekKnownUnpublished) {
      for (const frame of frames) {
        if (/nav/i.test(frame)) continue;
        try {
          const fUrl = new URL(frame, settings.url).href;
          const html = await proxyGet(base.proxy, fUrl, hdrs);
          if (html.length > 200) tryParse(html, `Frame ${frame.split('/').pop()}`);
          if (best.entries.length > 0) break;
        } catch (e) {
          debugLines.push(`Frame ${frame}: ${e.message}`);
        }
      }
    }

    // Try the exact target-week path constructed from navbar metadata.
    if (best.entries.length === 0 && nav && nav.weekValue) {
      const tc = nav.typeCode || 'w';
      const padd = n => String(n).padStart(5, '0');
      const elIndices = [0, ...(nav.classIdx > 0 ? [nav.classIdx] : [])];

      for (const el of elIndices) {
        const path = `${tc}/${nav.weekValue}/${tc}${padd(el)}.htm`;
        try {
          const fileUrl = new URL(path, settings.url).href;
          const html = await proxyGet(base.proxy, fileUrl, hdrs);
          if (html.length < 200) continue;
          tryParse(html, path);
          if (best.entries.length > 0) break;
        } catch (e) {
          debugLines.push(`${path}: ${e.message}`);
        }
      }
    }
  }

  if (best.source) debugLines.push(`══ Ergebnis aus: ${best.source} ══`);
  return {
    entries: best.entries,
    debug: debugLines.concat(best.debugLines).join('\n'),
    hasData: best.hasData,
    nachrichten: best.nachrichten,
  };
}

// ── Parsing helpers ────────────────────────────────────────────────────────
function cellText(cell) {
  return cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '';
}

// Returns text from non-anchor child nodes – in Untis nav bars the current
// day is plain text while other days are <a> links, so this isolates the
// current day from the rest.
function extractActiveText(cell) {
  const parts = [];
  for (const node of cell.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent);
    else if (node.nodeType === Node.ELEMENT_NODE && node.tagName !== 'A') parts.push(node.textContent);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// Parse "8.5.2026", "8.5.", or weekday name → ISO date YYYY-MM-DD
function parseTitleDate(text, monday) {
  let m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  if (monday) {
    m = text.match(/(\d{1,2})\.(\d{1,2})\./);
    if (m) return `${monday.getFullYear()}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    const t = text.toLowerCase().trim();
    for (let i = 0; i < 5; i++) {
      if (t.includes(WEEKDAY_LONG[i])) return isoDateLocal(addDays(monday, i));
    }
    if (t.length <= 6) {
      for (let i = 0; i < 5; i++) {
        if (t.startsWith(WEEKDAY_SHORT[i]) || t === WEEKDAY_SHORT[i]) return isoDateLocal(addDays(monday, i));
      }
    }
  }
  return '';
}

// Map column header texts to canonical keys
function buildColMap(headers) {
  const map = {};
  const variants = {
    klasse:    ['klasse', 'klassen', 'class', 'kl.', 'kl'],
    stunde:    ['stunde', 'std.', 'std', 'periode', 'stde', 'hour'],
    fach:      ['fach'],
    stattfach: ['statt fach', 'statt-fach', 'stattfach', '(fach)', 'orig. fach'],
    raum:      ['raum'],
    stattraum: ['statt raum', 'statt-raum', 'stattraum', '(raum)', 'orig. raum'],
    vertreter: ['vertr. von', 'vertr.von', 'vertretung', 'vertreter', 'lehrer', 'vert.'],
    info:      ['text', 'info', 'hinweis', 'bemerkung', 'art'],
    datum:     ['datum', 'date', 'tag'],
  };
  headers.forEach((h, i) => {
    for (const [key, vs] of Object.entries(variants)) {
      if (vs.some(v => h === v || h.startsWith(v))) {
        if (!(key in map)) map[key] = i;
        break;
      }
    }
  });
  return map;
}

// True if the row's klasse column matches the configured class.
// Handles multi-class entries like "7B, 7D" via exact-token match.
function rowMatchesKlasse(cells, colMap, klasseLower) {
  if (colMap && colMap.klasse !== undefined && cells[colMap.klasse]) {
    const raw = cellText(cells[colMap.klasse]).toLowerCase();
    return raw.split(/[\s,;\/]+/).filter(Boolean).some(part => part === klasseLower);
  }
  return false;
}

// Heuristic: does this row look like a column-header row?
function looksLikeHeader(cells) {
  if (cells.length < 3) return false;
  const map = buildColMap(cells.map(c => c.textContent.trim().toLowerCase()));
  // Need at least 3 of: klasse, stunde, fach, raum, info → that's a header
  let score = 0;
  for (const k of ['klasse','stunde','fach','raum','info','stattfach','stattraum']) {
    if (k in map) score++;
  }
  return score >= 3;
}

// Detect entry type from values (LMG / Untis semantics)
function detectTypFromColumns(fach, stattFach, raum, stattRaum, info) {
  const infoL = (info || '').toLowerCase();
  if (infoL.includes('and.raum') || infoL.includes('raumänderung')) return 'raum';
  if (!fach || fach === '---') return 'ausfall';
  if (fach === stattFach && raum !== stattRaum && raum && raum !== '---') return 'raum';
  if (stattFach && fach !== stattFach) return 'vertretung';
  return 'other';
}

// ── Parser ─────────────────────────────────────────────────────────────────
// The Untis file (w/KW/w00000.htm) uses <b>D.M. Weekday</b> bold elements
// in the document body as day separators — they are NOT inside any <tr>.
// Each day is followed by one or more <table> elements (Nachrichten + data).
// We walk the DOM tree: <b> tags set currentDate, <table> tags are parsed for
// entries, and recursion stops at both so that bold text inside data cells
// (e.g. <b>6C</b>) can never accidentally reset the day.
function parseVertretungsplan(doc, klasse, targetDate) {
  const monday = getMondayOf(targetDate);
  const klasseLower = klasse.toLowerCase().trim();
  const weekIsos = [0,1,2,3,4].map(i => isoDateLocal(addDays(monday, i)));
  const debugLines = [];
  const entries = [];
  // hasData: true once any day has a real <th>-based data table (week is published)
  // nachrichten: { "YYYY-MM-DD": ["msg1", ...] }
  const state = { currentDate: '', monday, weekIsos, klasseLower, entries, debugLines,
                  hasData: false, nachrichten: {} };

  debugLines.push(`Klasse "${klasse}", KW${getISOWeekNumber(monday)}, ab ${isoDateLocal(monday)}`);

  const container = doc.getElementById('vertretung') || doc.body;
  if (!container) { debugLines.push('Kein Container gefunden'); return { entries, debugLines, hasData: false, nachrichten: {} }; }

  walkNodes(container, state);

  debugLines.push(`Einträge gesamt: ${entries.length}, Woche veröffentlicht: ${state.hasData}`);
  return { entries, debugLines, hasData: state.hasData, nachrichten: state.nachrichten };
}

// Recursively walk DOM nodes. Stops recursion at <b> (date check) and <table>.
function walkNodes(node, state) {
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const tag = node.tagName;

  if (tag === 'B') {
    // The current day in each Untis section is <b>D.M. Weekday</b>
    const text = node.textContent.trim();
    const d = parseTitleDate(text, state.monday);
    if (d && state.weekIsos.includes(d)) {
      state.currentDate = d;
      state.debugLines.push(`▶ Tag ${d}: "${text}"`);
    }
    return; // do NOT recurse — prevents <b>Klasse(n)</b> inside tables from matching
  }

  if (tag === 'TABLE') {
    parseSubstTable(node, state);
    return; // do NOT recurse — handled by parseSubstTable
  }

  for (const child of node.childNodes) walkNodes(child, state);
}

// Returns true if a message from "Nachrichten zum Tag" is relevant for the class.
// Relevant = starts with the class name ("6C: …"), starts with "Alle" (broadcast),
// or has no recognisable class prefix (general announcement).
function isMessageRelevant(text, klasseLower) {
  const t = text.trim();
  if (!t) return false;
  if (/^alle\b/i.test(t)) return true;
  // Prefix pattern: "ClassName:" or "ClassA, ClassB:" before the actual message
  const m = t.match(/^([\wÄÖÜäöü]+(?:[\s,]+[\wÄÖÜäöü]+)*)\s*:/);
  if (m) {
    const tokens = m[1].toLowerCase().split(/[\s,]+/).filter(Boolean);
    return tokens.some(tok => tok === klasseLower);
  }
  return true; // no class prefix → general, always show
}

// Parse "Nachrichten zum Tag" table: extract lines relevant to the class.
function parseNachrichtenTable(table, state) {
  if (!state.currentDate) return;
  const td = table.querySelector('td');
  if (!td) return;
  if (!state.nachrichten[state.currentDate]) state.nachrichten[state.currentDate] = [];

  // Each message is separated by <br> inside the cell
  const parts = td.innerHTML.split(/<br\s*\/?>/gi);
  for (const part of parts) {
    const tmp = document.createElement('div');
    tmp.innerHTML = part;
    const msg = tmp.textContent.replace(/\s+/g, ' ').trim();
    if (msg && isMessageRelevant(msg, state.klasseLower)) {
      state.nachrichten[state.currentDate].push(msg);
    }
  }
  if (state.nachrichten[state.currentDate].length) {
    state.debugLines.push(`  Nachrichten (${state.currentDate}): ${state.nachrichten[state.currentDate].length} relevant`);
  }
}

// Parse one <table>: detect Nachrichten vs. data table, then extract matching rows.
function parseSubstTable(table, state) {
  const { monday, klasseLower, currentDate, entries, debugLines } = state;

  // Nachrichten table: first <th> contains "nachrichten"
  const firstTh = table.querySelector('th');
  if (firstTh && /nachrichten/i.test(firstTh.textContent)) {
    parseNachrichtenTable(table, state);
    return;
  }

  let colMap = null;
  for (const row of table.querySelectorAll('tr')) {
    const ths = [...row.querySelectorAll('th')];
    if (ths.length && !colMap) {
      colMap = buildColMap(ths.map(c => c.textContent.trim().toLowerCase()));
      if (Object.keys(colMap).length >= 3) {
        debugLines.push(`  Spalten: ${JSON.stringify(colMap)}`);
        state.hasData = true; // week is published (has a real data table)
      } else {
        colMap = null;
      }
      continue;
    }

    const cells = [...row.querySelectorAll('td')];
    if (cells.length < 3) continue;
    if (!colMap) colMap = { klasse:0, stunde:1, fach:2, stattfach:3, raum:4, stattraum:5, vertreter:6, info:7 };
    if (!rowMatchesKlasse(cells, colMap, klasseLower)) continue;

    const get = k => colMap[k] !== undefined ? cellText(cells[colMap[k]]) : '';
    const fach = get('fach'), stattFach = get('stattfach');
    const raum = get('raum'), stattRaum = get('stattraum');
    const info = get('info');
    const rawDatum = get('datum');
    const datumNorm = (rawDatum ? parseTitleDate(rawDatum, monday) : '') || currentDate;

    entries.push({
      datumNorm, datum: rawDatum, stunde: get('stunde'), klasse: get('klasse'),
      fach, stattFach, raum, stattRaum, vertreter: get('vertreter'), info,
      typ: detectTypFromColumns(fach, stattFach, raum, stattRaum, info),
    });
  }
}

// ── Stundenplan (manual schedule) ─────────────────────────────────────────
function loadStundenplan() {
  try { return JSON.parse(localStorage.getItem(STUNDENPLAN_KEY) || 'null'); }
  catch { return null; }
}

function saveStundenplan(data) {
  localStorage.setItem(STUNDENPLAN_KEY, JSON.stringify(data));
}

function updateViewToggleVisibility() {
  const sp = loadStundenplan();
  const vt = document.getElementById('view-toggle');
  if (sp) vt.classList.remove('hidden');
  else vt.classList.add('hidden');
}

function buildEditorTable() {
  const table = document.getElementById('sp-editor-table');
  const sp = loadStundenplan();
  const days = ['Mo', 'Di', 'Mi', 'Do', 'Fr'];
  let html = '<thead><tr><th></th>' + days.map(d => `<th>${d}</th>`).join('') + '</tr></thead><tbody>';
  for (let p = 0; p < SP_PERIODS; p++) {
    html += `<tr><td class="sp-period-label">${p + 1}</td>`;
    for (let d = 0; d < 5; d++) {
      const val = sp && sp.cells && sp.cells[p] ? (sp.cells[p][d] || '') : '';
      html += `<td><input type="text" value="${escHtml(val)}" data-p="${p}" data-d="${d}" placeholder="–" autocomplete="off" spellcheck="false"></td>`;
    }
    html += '</tr>';
  }
  html += '</tbody>';
  table.innerHTML = html;
}

function collectStundenplanData() {
  const cells = Array.from({ length: SP_PERIODS }, () => Array(5).fill(''));
  document.querySelectorAll('#sp-editor-table input[type="text"]').forEach(inp => {
    cells[+inp.dataset.p][+inp.dataset.d] = inp.value.trim();
  });
  return { cells };
}

function openStundenplanEditor() {
  buildEditorTable();
  const prev = document.getElementById('sp-img-preview');
  const lbl = document.getElementById('sp-upload-label');
  prev.classList.add('hidden');
  prev.src = '';
  lbl.classList.remove('hidden');
  document.getElementById('sp-overlay').classList.remove('hidden');
}

function closeStundenplanEditor() {
  document.getElementById('sp-overlay').classList.add('hidden');
}

// ── Stundenplan share / import ─────────────────────────────────────────────
function encodeStundenplan(sp) {
  try {
    const json = JSON.stringify(sp);
    return btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  } catch { return ''; }
}

function decodeStundenplan(encoded) {
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '==='.slice(0, (4 - b64.length % 4) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(padded))));
  } catch { return null; }
}

function getShareUrl(sp) {
  const base = location.href.split('?')[0].replace(/\/$/, '');
  return `${base}?sp=${encodeStundenplan(sp)}`;
}

function openShareOverlay() {
  const sp = loadStundenplan();
  if (!sp) return;
  const url = getShareUrl(sp);
  document.getElementById('share-url-input').value = url;
  document.getElementById('share-qr-img').src =
    `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=12&data=${encodeURIComponent(url)}`;
  document.getElementById('share-overlay').classList.remove('hidden');
}

function closeShareOverlay() {
  document.getElementById('share-overlay').classList.add('hidden');
}

function checkImportFromUrl() {
  const params = new URLSearchParams(location.search);
  const encoded = params.get('sp');
  if (!encoded) return;
  const sp = decodeStundenplan(encoded);
  if (!sp || !Array.isArray(sp.cells)) return;
  history.replaceState({}, '', location.pathname);
  window._pendingImport = sp;
  document.getElementById('import-banner').classList.remove('hidden');
}

// ── Timetable week view ────────────────────────────────────────────────────
function expandStundenRange(stunde) {
  if (!stunde) return [];
  const m = stunde.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (m) {
    const from = parseInt(m[1]), to = parseInt(m[2]);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  const n = parseInt(stunde);
  return isNaN(n) ? [] : [n];
}

function renderTimetableCell(subst, regularStr) {
  const typClass = `tt-${subst.typ}`;
  const origFach = (regularStr || '').split('/')[0] || '';
  const origRaum = (regularStr || '').split('/')[2] || '';
  let inner = '';

  if (subst.typ === 'ausfall') {
    const displayOrig = origFach || subst.stattFach || '';
    inner = `<span class="tt-strike">${escHtml(displayOrig)}</span>`;

  } else if (subst.typ === 'vertretung') {
    const fach = subst.fach && subst.fach !== '---' ? subst.fach : origFach;
    const orig = origFach || (subst.stattFach && subst.stattFach !== '---' ? subst.stattFach : '');
    const raum = subst.stattRaum && subst.stattRaum !== '---' ? subst.stattRaum
               : subst.raum && subst.raum !== '---' ? subst.raum : '';
    inner = escHtml(fach);
    if (raum) inner += `<span class="tt-room">${escHtml(raum)}</span>`;
    if (orig && orig !== fach) inner += `<span class="tt-orig">statt ${escHtml(orig)}</span>`;

  } else {
    // raum change
    const fach = subst.fach && subst.fach !== '---' ? subst.fach : origFach;
    const raum = subst.stattRaum && subst.stattRaum !== '---' ? subst.stattRaum
               : subst.raum && subst.raum !== '---' ? subst.raum : '';
    inner = escHtml(fach);
    if (raum) inner += `<span class="tt-room">${escHtml(raum)}</span>`;
    if (origRaum && origRaum !== raum) inner += `<span class="tt-orig">statt R.${escHtml(origRaum)}</span>`;
  }

  return `<td class="tt-cell ${typClass}" title="${escHtml(subst.info || '')}">${inner}</td>`;
}

function renderTimetableView(entries, targetDate, hasData, nachrichten) {
  const content = document.getElementById('content');
  const sp = loadStundenplan();

  if (!hasData) {
    content.innerHTML = `<div class="no-data-card">Vertretungsplan für diese Woche noch nicht veröffentlicht.</div>`;
    return;
  }

  const monday = getMondayOf(targetDate);
  const weekIsos = [0, 1, 2, 3, 4].map(i => isoDateLocal(addDays(monday, i)));

  // Build substitution lookup: key = "iso_periodNum"
  const substMap = {};
  for (const e of entries) {
    for (const p of expandStundenRange(e.stunde)) {
      const key = `${e.datumNorm}_${p}`;
      if (!substMap[key]) substMap[key] = e;
    }
  }

  // Column headers
  const thHtml = `<th></th>` + weekIsos.map((iso, i) => {
    const date = new Date(iso + 'T00:00:00');
    return `<th><div>${WEEKDAY_LABELS[i]}</div><div class="tt-date">${formatDateShort(date)}</div></th>`;
  }).join('');

  // Build rows — skip fully empty periods
  let rowsHtml = '';
  for (let p = 0; p < SP_PERIODS; p++) {
    let periodHasContent = false;
    for (let d = 0; d < 5; d++) {
      const regular = sp && sp.cells && sp.cells[p] ? sp.cells[p][d] || '' : '';
      if (regular || substMap[`${weekIsos[d]}_${p + 1}`]) { periodHasContent = true; break; }
    }
    if (!periodHasContent) continue;

    rowsHtml += `<tr><td class="tt-period">${p + 1}</td>`;
    for (let d = 0; d < 5; d++) {
      const iso = weekIsos[d];
      const key = `${iso}_${p + 1}`;
      const subst = substMap[key];
      const regular = sp && sp.cells && sp.cells[p] ? sp.cells[p][d] || '' : '';

      if (subst) {
        rowsHtml += renderTimetableCell(subst, regular);
      } else if (regular) {
        const parts = regular.split('/');
        const fach = parts[0] ? escHtml(parts[0]) : '';
        const raum = parts[2] ? `<span class="tt-room">${escHtml(parts[2])}</span>` : '';
        rowsHtml += `<td class="tt-cell">${fach}${raum}</td>`;
      } else {
        rowsHtml += `<td class="tt-cell tt-empty"></td>`;
      }
    }
    rowsHtml += '</tr>';
  }

  // Nachrichten below timetable
  const allMsgs = weekIsos.flatMap((iso, i) => {
    const msgs = (nachrichten && nachrichten[iso]) || [];
    return msgs.map(m => `<div class="nachricht-item"><strong>${WEEKDAY_LABELS[i]}:</strong> ${escHtml(m)}</div>`);
  });
  const nachrichtenHtml = allMsgs.length
    ? `<div class="day-nachrichten" style="padding:10px 16px">${allMsgs.join('')}</div>` : '';

  content.innerHTML = `
    <div class="timetable-card">
      ${nachrichtenHtml}
      <div class="timetable-scroll">
        <table class="timetable-table">
          <thead><tr>${thHtml}</tr></thead>
          <tbody>${rowsHtml || '<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--clr-muted);font-size:.85rem">Kein Ausfall diese Woche</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function renderCurrentView(entries, targetDate, debug, hasData, nachrichten) {
  if (currentView === 'woche') {
    renderTimetableView(entries, targetDate, hasData, nachrichten);
  } else {
    render(entries, targetDate, debug, hasData, nachrichten);
  }
}

// ── Rendering ──────────────────────────────────────────────────────────────
function render(entries, targetDate, debug, hasData, nachrichten) {
  const content = document.getElementById('content');
  const monday = getMondayOf(targetDate);

  // Week not published: no real data tables found at all
  if (!hasData) {
    const diagHtml = debug
      ? `<details class="debug-details"><summary>Diagnose anzeigen</summary><pre class="debug-pre">${escHtml(debug)}</pre></details>`
      : '';
    content.innerHTML =
      `<div class="no-data-card">Vertretungsplan für diese Woche noch nicht veröffentlicht.</div>${diagHtml}`;
    return;
  }

  const byDate = {};
  for (let i = 0; i < 5; i++) byDate[isoDateLocal(addDays(monday, i))] = [];
  for (const e of entries) {
    if (e.datumNorm && byDate.hasOwnProperty(e.datumNorm)) {
      byDate[e.datumNorm].push(e);
    } else {
      byDate[isoDateLocal(monday)].push(e);
    }
  }

  const chevronSvg = `<svg class="chevron" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;

  const todayIso = isoDateLocal(new Date());

  const html = Object.entries(byDate).map(([iso, dayEntries]) => {
    const date = new Date(iso + 'T00:00:00');
    const isToday = iso === todayIso;
    const dayName = WEEKDAY_LABELS[date.getDay() - 1] || DAY_NAMES[date.getDay()];
    const dateStr = formatDateShort(date) + date.getFullYear();

    const msgs = (nachrichten && nachrichten[iso]) || [];
    const nachrichtenHtml = msgs.length
      ? `<div class="day-nachrichten">${msgs.map(m => `<div class="nachricht-item">${escHtml(m)}</div>`).join('')}</div>`
      : '';

    const checkSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
    const body = dayEntries.length
      ? dayEntries.map(renderEntry).join('')
      : `<div class="no-change">${checkSvg} Kein Ausfall</div>`;

    // Collapse by default when nothing to show; always expand today
    const hasContent = dayEntries.length > 0 || msgs.length > 0;
    const collapsed = (hasContent || isToday) ? '' : ' collapsed';

    // Header chip: colored type dots + count, or nachrichten dot
    let chipHtml = '';
    if (dayEntries.length > 0) {
      const types = [...new Set(dayEntries.map(e => e.typ))].filter(Boolean);
      const dots = types.map(t => `<span class="type-dot type-dot-${t}" aria-hidden="true"></span>`).join('');
      chipHtml = `<span class="day-chips">${dots}<span class="day-count">${dayEntries.length}</span></span>`;
    } else if (msgs.length > 0) {
      chipHtml = `<span class="day-msg-dot" aria-hidden="true"></span>`;
    }

    const todayClass = isToday ? ' today' : '';
    const todayChip = isToday ? '<span class="day-today-chip">Heute</span>' : '';

    return `
      <div class="day-card${collapsed}${todayClass}">
        <button class="day-header" aria-expanded="${hasContent}">
          <div class="day-header-info">
            <span class="day-name">${dayName}</span>
            <span class="day-date">${dateStr}${todayChip}</span>
          </div>
          <div class="day-header-right">${chipHtml}${chevronSvg}</div>
        </button>
        <div class="day-body"><div class="day-body-inner">${nachrichtenHtml}${body}</div></div>
      </div>`;
  }).join('');

  content.innerHTML = html || '<div class="loading">Keine Einträge gefunden.</div>';
  requestAnimationFrame(scrollToToday);
}

function scrollToToday() {
  if (weekOffset !== 0) return;
  const card = document.querySelector('.day-card.today');
  if (!card) return;
  const stickyH = (document.getElementById('sticky-top')?.offsetHeight ?? 0) + 8;
  const top = card.getBoundingClientRect().top + window.scrollY - stickyH;
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

const ENTRY_BADGE_ICONS = {
  ausfall:
    `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  vertretung:
    `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M7 16V4m0 0L3 8m4-4 4 4"/><path d="M17 8v12m0 0 4-4m-4 4-4-4"/></svg>`,
  raum:
    `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
};

function renderEntry(e) {
  const typClass = e.typ === 'ausfall' ? 'ausfall'
    : e.typ === 'vertretung' ? 'vertretung'
    : e.typ === 'raum' ? 'raum' : '';

  const icon = ENTRY_BADGE_ICONS[e.typ] || '';
  let badge = '';
  if (e.typ === 'ausfall')         badge = `<span class="entry-badge badge-ausfall">${icon} Ausfall</span>`;
  else if (e.typ === 'vertretung') badge = `<span class="entry-badge badge-vertretung">${icon} Vertretung</span>`;
  else if (e.typ === 'raum')       badge = `<span class="entry-badge badge-raum">${icon} and. Raum</span>`;

  // Ausfall: show cancelled subject with strikethrough instead of "entfällt"
  let fachDisplay, origFach = '';
  if (e.typ === 'ausfall') {
    const cancelled = e.stattFach && e.stattFach !== '---' ? e.stattFach : (e.fach && e.fach !== '---' ? e.fach : '');
    fachDisplay = cancelled
      ? `<span class="entry-fach-strike">${escHtml(cancelled)}</span>`
      : '<em>entfällt</em>';
  } else {
    fachDisplay = e.fach && e.fach !== '---' ? escHtml(e.fach) : '<em>entfällt</em>';
    origFach = e.stattFach && e.stattFach !== e.fach && e.stattFach !== '---'
      ? ` <span class="entry-orig">statt ${escHtml(e.stattFach)}</span>` : '';
  }

  const raumNew  = e.raum && e.raum !== '---' ? escHtml(e.raum) : '';
  const raumOrig = e.stattRaum && e.stattRaum !== '---' && e.stattRaum !== e.raum
    ? `<span class="entry-orig">statt ${escHtml(e.stattRaum)}</span>` : '';
  const raumLine = [raumNew, raumOrig].filter(Boolean).join(' ');

  const sub = [];
  if (e.vertreter) sub.push(escHtml(e.vertreter));
  if (raumLine)    sub.push(raumLine);

  return `
    <div class="entry ${typClass}">
      <div class="entry-stunde">${escHtml(e.stunde || '')}</div>
      <div class="entry-details">
        <div class="entry-main">
          ${badge}<span class="entry-fach">${fachDisplay}</span>${origFach}
        </div>
        ${sub.length ? `<div class="entry-sub">${sub.join(' · ')}</div>` : ''}
        ${e.info ? `<div class="entry-info">${escHtml(e.info)}</div>` : ''}
      </div>
    </div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── UI ─────────────────────────────────────────────────────────────────────
function updateWeekBar() {
  document.getElementById('week-label').textContent = buildWeekLabel(getTargetDate());
}
function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
}
function hideError() { document.getElementById('error-banner').classList.add('hidden'); }
// ── Snapshot helpers ───────────────────────────────────────────────────────
function snapWeekKey(targetDate, klasse) {
  return `${klasse.toLowerCase()}_${isoDateLocal(getMondayOf(targetDate))}`;
}

function buildSnapshot(entries) {
  const byDate = {};
  for (const e of entries) {
    if (!e.datumNorm) continue;
    if (!byDate[e.datumNorm]) byDate[e.datumNorm] = [];
    byDate[e.datumNorm].push(`${(e.stunde||'').trim()}|${(e.fach||'').trim()}|${e.typ}`);
  }
  for (const k of Object.keys(byDate)) byDate[k].sort();
  return byDate;
}

function loadSnapshot(wKey) {
  try {
    const all = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || '{}');
    return wKey in all ? all[wKey] : null;
  } catch { return null; }
}

function saveSnapshot(wKey, snapshot) {
  try {
    const all = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || '{}');
    const keys = Object.keys(all);
    if (keys.length >= 20) delete all[keys.sort()[0]];
    all[wKey] = snapshot;
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(all));
  } catch {}
}

function detectChangedDates(prev, curr) {
  const dates = new Set([...Object.keys(prev || {}), ...Object.keys(curr)]);
  return [...dates].sort().filter(d =>
    JSON.stringify((prev || {})[d] || []) !== JSON.stringify(curr[d] || [])
  );
}

function showChangesBanner(changedDates) {
  const names = changedDates.map(iso => {
    const d = new Date(iso + 'T00:00:00');
    return WEEKDAY_LABELS[d.getDay() - 1] || iso;
  });
  document.getElementById('changes-banner-days').textContent = names.join(' · ');
  const banner = document.getElementById('changes-banner');
  banner.classList.remove('hidden');
  clearTimeout(banner._t);
  banner._t = setTimeout(() => banner.classList.add('hidden'), 12000);
}

// ── Last-updated display ───────────────────────────────────────────────────
function renderLastUpdated(date) {
  const now  = new Date();
  const prev = new Date(now); prev.setDate(prev.getDate() - 1);
  const time = date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  let prefix;
  if (date.toDateString() === now.toDateString())  prefix = 'Heute';
  else if (date.toDateString() === prev.toDateString()) prefix = 'Gestern';
  else prefix = date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
  document.getElementById('last-updated').textContent = `Stand: ${prefix} ${time} Uhr`;
}

function setLastUpdated(date) {
  try { localStorage.setItem(LAST_UPDATED_KEY, date.toISOString()); } catch {}
  renderLastUpdated(date);
}

// ── Persistent history log (Ausfall/Vertretung/Raumwechsel über Zeit) ──────
function loadHistory() {
  try {
    const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || 'null');
    return (h && h.weeks && h.days) ? h : { weeks: {}, days: {} };
  } catch { return { weeks: {}, days: {} }; }
}
function saveHistory(h) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch {}
}

function entryPeriods(e) {
  const n = expandStundenRange(e.stunde).length;
  return n > 0 ? n : 1;
}

// Subject to attribute the entry to: for Ausfall the cancelled (original) subject, otherwise the new one.
function entrySubject(e) {
  if (e.typ === 'ausfall') {
    return (e.stattFach && e.stattFach !== '---') ? e.stattFach : (e.fach && e.fach !== '---' ? e.fach : '');
  }
  return (e.fach && e.fach !== '---') ? e.fach : (e.stattFach && e.stattFach !== '---' ? e.stattFach : '');
}

// Remove history entries older than ~2 years to keep localStorage small.
function pruneHistory(history) {
  const cutoffIso = isoDateLocal(addDays(new Date(), -730));
  for (const key of Object.keys(history.days)) {
    if (key.slice(key.lastIndexOf('_') + 1) < cutoffIso) delete history.days[key];
  }
  for (const key of Object.keys(history.weeks)) {
    if (key.slice(key.lastIndexOf('_') + 1) < cutoffIso) delete history.weeks[key];
  }
}

// Records the published week's entries, overwriting any prior record for the
// same days so repeated 5-minute refreshes never double-count hours.
function recordHistory(entries, klasse, weekIsos) {
  const history = loadHistory();
  const kl = klasse.toLowerCase();
  history.weeks[`${kl}_${weekIsos[0]}`] = true;
  for (const iso of weekIsos) {
    const dayEntries = entries.filter(e => e.datumNorm === iso &&
      (e.typ === 'ausfall' || e.typ === 'vertretung' || e.typ === 'raum'));
    history.days[`${kl}_${iso}`] = dayEntries.map(e => ({ t: e.typ, f: entrySubject(e), p: entryPeriods(e) }));
  }
  pruneHistory(history);
  saveHistory(history);
}

// ── Analytics aggregation ───────────────────────────────────────────────────
// Sums hours per category + per-subject Ausfall hours + tracked-weeks count
// for all days/weeks whose ISO date passes filterFn.
function aggregateHistory(klasse, filterFn) {
  const history = loadHistory();
  const kl = klasse.toLowerCase();
  const totals = { ausfall: 0, vertretung: 0, raum: 0 };
  const perSubject = {};
  for (const key of Object.keys(history.days)) {
    if (!key.startsWith(kl + '_')) continue;
    const iso = key.slice(kl.length + 1);
    if (!filterFn(iso)) continue;
    for (const rec of history.days[key]) {
      totals[rec.t] = (totals[rec.t] || 0) + rec.p;
      if (rec.t === 'ausfall' && rec.f) perSubject[rec.f] = (perSubject[rec.f] || 0) + rec.p;
    }
  }
  let weeks = 0;
  for (const key of Object.keys(history.weeks)) {
    if (!key.startsWith(kl + '_')) continue;
    if (filterFn(key.slice(kl.length + 1))) weeks++;
  }
  return { totals, perSubject, weeks };
}

function monthlyChartData(klasse, year) {
  const history = loadHistory();
  const kl = klasse.toLowerCase();
  const months = Array.from({ length: 12 }, () => ({ ausfall: 0, vertretung: 0, raum: 0 }));
  for (const key of Object.keys(history.days)) {
    if (!key.startsWith(kl + '_')) continue;
    const iso = key.slice(kl.length + 1);
    if (iso.slice(0, 4) !== String(year)) continue;
    const m = parseInt(iso.slice(5, 7), 10) - 1;
    for (const rec of history.days[key]) months[m][rec.t] = (months[m][rec.t] || 0) + rec.p;
  }
  return months.map((d, i) => ({ label: MONTH_SHORT[i], ...d }));
}

function weeklyChartData(klasse, year, month) {
  const history = loadHistory();
  const kl = klasse.toLowerCase();
  const weeks = {};
  for (const key of Object.keys(history.days)) {
    if (!key.startsWith(kl + '_')) continue;
    const iso = key.slice(kl.length + 1);
    if (iso.slice(0, 4) !== String(year) || parseInt(iso.slice(5, 7), 10) !== month) continue;
    const monday = isoDateLocal(getMondayOf(new Date(iso + 'T00:00:00')));
    if (!weeks[monday]) weeks[monday] = { ausfall: 0, vertretung: 0, raum: 0 };
    for (const rec of history.days[key]) weeks[monday][rec.t] = (weeks[monday][rec.t] || 0) + rec.p;
  }
  return Object.keys(weeks).sort().map(monday => ({
    label: `KW${getISOWeekNumber(new Date(monday + 'T00:00:00'))}`,
    ...weeks[monday],
  }));
}

// Weekly hours per subject, read from the manually entered Stundenplan
// (cell format "Fach/Lehrer/Raum") — used as the KPI's annual baseline.
function weeklySubjectHours() {
  const sp = loadStundenplan();
  const out = {};
  if (!sp || !sp.cells) return out;
  for (const row of sp.cells) {
    for (const cell of row) {
      const fach = (cell || '').split('/')[0].trim();
      if (fach) out[fach] = (out[fach] || 0) + 1;
    }
  }
  return out;
}
function weeklyTotalHours() {
  return Object.values(weeklySubjectHours()).reduce((a, b) => a + b, 0);
}

function computeSubjectKPIs(perSubjectAusfall, weeks) {
  const weeklyHours = weeklySubjectHours();
  const subjects = new Set([...Object.keys(weeklyHours), ...Object.keys(perSubjectAusfall)]);
  const rows = [...subjects].map(subj => {
    const ist = perSubjectAusfall[subj] || 0;
    const soll = (weeklyHours[subj] || 0) * weeks;
    const pct = soll > 0 ? Math.min(100, (ist / soll) * 100) : null;
    return { subj, ist, soll, pct };
  }).filter(r => r.ist > 0 || r.soll > 0);
  rows.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.ist - a.ist);
  return rows;
}

function overallAusfallQuotient(totals, weeks) {
  const soll = weeklyTotalHours() * weeks;
  if (soll <= 0) return { pct: null, soll: 0 };
  return { pct: Math.min(100, (totals.ausfall / soll) * 100), soll };
}

// ── Analytics rendering ──────────────────────────────────────────────────
function renderBarChart(items) {
  const max = Math.max(1, ...items.map(it => it.ausfall + it.vertretung + it.raum));
  return `<div class="chart-bars">${items.map(it => {
    const total = it.ausfall + it.vertretung + it.raum;
    const h = v => v > 0 ? Math.max(3, (v / max) * 100) : 0;
    return `
      <div class="chart-col">
        <div class="chart-bar-stack" title="${escHtml(it.label)}: ${total} Std.">
          ${it.ausfall    ? `<div class="chart-seg seg-ausfall"    style="height:${h(it.ausfall)}%"></div>`    : ''}
          ${it.vertretung ? `<div class="chart-seg seg-vertretung" style="height:${h(it.vertretung)}%"></div>` : ''}
          ${it.raum       ? `<div class="chart-seg seg-raum"       style="height:${h(it.raum)}%"></div>`       : ''}
        </div>
        <div class="chart-col-label">${escHtml(it.label)}</div>
      </div>`;
  }).join('')}</div>`;
}

function renderSummaryCards(totals, quotient) {
  return `
    <div class="analytics-stats">
      <div class="stat-card stat-ausfall"><div class="stat-num">${totals.ausfall}</div><div class="stat-label">Ausfall Std.</div></div>
      <div class="stat-card stat-vertretung"><div class="stat-num">${totals.vertretung}</div><div class="stat-label">Vertretung Std.</div></div>
      <div class="stat-card stat-raum"><div class="stat-num">${totals.raum}</div><div class="stat-label">Raumwechsel Std.</div></div>
    </div>
    <div class="quotient-card">
      <div class="quotient-num">${quotient.pct !== null ? quotient.pct.toFixed(1) + '%' : '–'}</div>
      <div class="quotient-label">${quotient.pct !== null
        ? `Ausfallquotient · ${totals.ausfall} von ${quotient.soll} Soll-Std.`
        : 'Ausfallquotient – Stundenplan hinterlegen für Berechnung'}</div>
    </div>`;
}

function renderKpiTable(rows) {
  if (!rows.length) return `<div class="analytics-empty">Noch keine Daten für diesen Zeitraum.</div>`;
  return rows.map(r => `
    <div class="kpi-row">
      <div class="kpi-row-top">
        <span class="kpi-subj">${escHtml(r.subj)}</span>
        <span class="kpi-val">${r.pct !== null ? r.pct.toFixed(0) + '%' : '–'}</span>
      </div>
      <div class="kpi-bar-track"><div class="kpi-bar-fill" style="width:${r.pct !== null ? r.pct : 0}%"></div></div>
      <div class="kpi-row-sub">${r.ist} ${r.soll > 0 ? `von ${r.soll} Soll-Std. ausgefallen` : 'Std. ausgefallen (nicht im Stundenplan)'}</div>
    </div>`).join('');
}

function renderAnalytics() {
  const settings = loadSettings();
  const klasse = settings.klasse;
  const body = document.getElementById('analytics-body');
  if (!klasse) {
    document.getElementById('analytics-period-label').textContent = '–';
    body.innerHTML = `<div class="analytics-empty">Bitte zuerst die Klasse in den Einstellungen hinterlegen.</div>`;
    return;
  }

  const year = analyticsAnchor.getFullYear();
  const month = analyticsAnchor.getMonth() + 1;

  let chartData, sectionTitle, label, filterFn;
  if (analyticsRange === 'jahr') {
    label = String(year);
    sectionTitle = 'Pro Monat';
    chartData = monthlyChartData(klasse, year);
    filterFn = iso => iso.slice(0, 4) === String(year);
  } else {
    label = `${MONTH_LONG[month - 1]} ${year}`;
    sectionTitle = 'Pro Woche';
    chartData = weeklyChartData(klasse, year, month);
    const mk = `${year}-${String(month).padStart(2, '0')}`;
    filterFn = iso => iso.slice(0, 7) === mk;
  }
  document.getElementById('analytics-period-label').textContent = label;

  const { totals, perSubject, weeks } = aggregateHistory(klasse, filterFn);
  const quotient = overallAusfallQuotient(totals, weeks);
  const kpiRows = computeSubjectKPIs(perSubject, weeks);
  const hasChartData = chartData.some(d => d.ausfall || d.vertretung || d.raum);

  body.innerHTML = `
    ${renderSummaryCards(totals, quotient)}
    <div class="analytics-section-title">${sectionTitle}</div>
    <div class="chart-card">${hasChartData ? renderBarChart(chartData) : '<div class="analytics-empty">Keine Daten für diesen Zeitraum.</div>'}</div>
    <div class="analytics-section-title">Fächer-KPI (Ausfallquote)</div>
    <div class="kpi-list">${renderKpiTable(kpiRows)}</div>`;
}

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
    const { entries, debug, hasData, nachrichten } = await fetchPlan(settings, targetDate);
    lastEntries = { entries, hasData, nachrichten };
    renderCurrentView(entries, targetDate, debug, hasData, nachrichten);
    setLastUpdated(new Date());
    hideError();

    // Change detection
    const wKey = snapWeekKey(targetDate, settings.klasse);
    const prevSnap = loadSnapshot(wKey);
    const newSnap  = buildSnapshot(entries);
    saveSnapshot(wKey, newSnap);
    if (prevSnap !== null) {
      const changed = detectChangedDates(prevSnap, newSnap);
      if (changed.length > 0) showChangesBanner(changed);
    }

    // Persistent analytics history (only for confirmed-published weeks)
    if (hasData) {
      const monday = getMondayOf(targetDate);
      const weekIsos = [0, 1, 2, 3, 4].map(i => isoDateLocal(addDays(monday, i)));
      recordHistory(entries, settings.klasse, weekIsos);
    }
  } catch (err) {
    showError('Fehler beim Laden: ' + err.message);
    if (lastEntries !== null) {
      const { entries, hasData, nachrichten } = lastEntries;
      renderCurrentView(entries, targetDate, null, hasData, nachrichten);
    } else {
      document.getElementById('content').innerHTML = '<div class="loading">Keine Daten verfügbar.</div>';
    }
  }
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(fetchAndRender, REFRESH_INTERVAL_MS);
}

function openSettings() {
  const s = loadSettings();
  document.getElementById('s-url').value = s.url || 'https://vertretungsplan.lmg-koenigsbach.de/default.htm';
  document.getElementById('s-user').value = s.user || '';
  document.getElementById('s-pass').value = s.pass || '';
  document.getElementById('s-klasse').value = s.klasse || '';
  document.getElementById('s-darkmode').checked = !!s.dark;
  document.getElementById('settings-overlay').classList.remove('hidden');
}
function closeSettings() { document.getElementById('settings-overlay').classList.add('hidden'); }

// ── Ripple effect ──────────────────────────────────────────────────────────
function addRipple(el) {
  el.addEventListener('pointerdown', (e) => {
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const size = Math.max(el.offsetWidth, el.offsetHeight);
    const rect = el.getBoundingClientRect();
    ripple.style.cssText =
      `width:${size}px;height:${size}px;` +
      `left:${e.clientX - rect.left - size / 2}px;` +
      `top:${e.clientY - rect.top - size / 2}px`;
    el.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Apply saved dark mode preference
  applyDarkMode(!!loadSettings().dark);

  // Ripple on all interactive buttons
  document.querySelectorAll('.icon-btn, .nav-btn').forEach(addRipple);

  // Live dark mode preview while settings is open
  document.getElementById('s-darkmode').addEventListener('change', function () {
    applyDarkMode(this.checked);
  });

  // Help overlay
  document.getElementById('help-btn').addEventListener('click', () => {
    document.getElementById('help-overlay').classList.remove('hidden');
  });
  document.getElementById('help-close-btn').addEventListener('click', () => {
    document.getElementById('help-overlay').classList.add('hidden');
  });
  document.getElementById('help-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) document.getElementById('help-overlay').classList.add('hidden');
  });

  // Analytics dashboard
  document.getElementById('analytics-btn').addEventListener('click', () => {
    document.getElementById('analytics-overlay').classList.remove('hidden');
    renderAnalytics();
  });
  document.getElementById('analytics-close-btn').addEventListener('click', () => {
    document.getElementById('analytics-overlay').classList.add('hidden');
  });
  document.getElementById('analytics-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) document.getElementById('analytics-overlay').classList.add('hidden');
  });
  document.querySelectorAll('.analytics-range-toggle .view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      analyticsRange = btn.dataset.range;
      document.querySelectorAll('.analytics-range-toggle .view-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderAnalytics();
    });
  });
  document.getElementById('analytics-prev-btn').addEventListener('click', () => {
    if (analyticsRange === 'jahr') analyticsAnchor.setFullYear(analyticsAnchor.getFullYear() - 1);
    else analyticsAnchor.setMonth(analyticsAnchor.getMonth() - 1);
    renderAnalytics();
  });
  document.getElementById('analytics-next-btn').addEventListener('click', () => {
    if (analyticsRange === 'jahr') analyticsAnchor.setFullYear(analyticsAnchor.getFullYear() + 1);
    else analyticsAnchor.setMonth(analyticsAnchor.getMonth() + 1);
    renderAnalytics();
  });

  document.getElementById('reset-btn').addEventListener('click', async () => {
    lastEntries = null;
    weekOffset = 0;
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    location.reload();
  });

  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-cancel-btn').addEventListener('click', closeSettings);

  document.getElementById('settings-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('settings-overlay')) closeSettings();
  });

  document.getElementById('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const s = {
      url:    document.getElementById('s-url').value.trim(),
      user:   document.getElementById('s-user').value.trim(),
      pass:   document.getElementById('s-pass').value,
      klasse: document.getElementById('s-klasse').value.trim(),
      dark:   document.getElementById('s-darkmode').checked,
    };
    saveSettings(s);
    closeSettings();
    weekOffset = 0;
    lastEntries = null;
    fetchAndRender();
    scheduleRefresh();
  });

  document.getElementById('prev-week-btn').addEventListener('click', () => { weekOffset--; fetchAndRender(); });
  document.getElementById('next-week-btn').addEventListener('click', () => { weekOffset++; fetchAndRender(); });

  // Collapsible day cards — single delegated listener on #content survives innerHTML replacement
  document.getElementById('content').addEventListener('click', (e) => {
    const header = e.target.closest('.day-header');
    if (!header) return;
    const card = header.closest('.day-card');
    const nowCollapsed = card.classList.toggle('collapsed');
    header.setAttribute('aria-expanded', String(!nowCollapsed));
  });

  // View toggle
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentView = btn.dataset.view;
      document.querySelectorAll('.view-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.view === currentView));
      if (lastEntries) {
        const td = getTargetDate();
        renderCurrentView(lastEntries.entries, td, null, lastEntries.hasData, lastEntries.nachrichten);
      }
    });
  });

  // Stundenplan editor
  document.getElementById('open-sp-btn').addEventListener('click', () => {
    closeSettings();
    openStundenplanEditor();
  });
  document.getElementById('sp-close-btn').addEventListener('click', closeStundenplanEditor);
  document.getElementById('sp-cancel-btn').addEventListener('click', closeStundenplanEditor);
  document.getElementById('sp-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('sp-overlay')) closeStundenplanEditor();
  });
  document.getElementById('sp-save-btn').addEventListener('click', () => {
    saveStundenplan(collectStundenplanData());
    closeStundenplanEditor();
    updateViewToggleVisibility();
  });

  // Screenshot preview
  document.getElementById('sp-img-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const img = document.getElementById('sp-img-preview');
      img.src = evt.target.result;
      img.classList.remove('hidden');
      document.getElementById('sp-upload-label').classList.add('hidden');
    };
    reader.readAsDataURL(file);
  });

  // Share overlay
  document.getElementById('sp-share-btn').addEventListener('click', () => {
    const data = collectStundenplanData();
    saveStundenplan(data);
    updateViewToggleVisibility();
    closeStundenplanEditor();
    openShareOverlay();
  });
  document.getElementById('share-close-btn').addEventListener('click', closeShareOverlay);
  document.getElementById('share-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('share-overlay')) closeShareOverlay();
  });
  document.getElementById('share-copy-btn').addEventListener('click', async () => {
    const url = document.getElementById('share-url-input').value;
    const btn = document.getElementById('share-copy-btn');
    try {
      await navigator.clipboard.writeText(url);
      btn.textContent = '✓ Kopiert';
    } catch {
      document.getElementById('share-url-input').select();
      btn.textContent = '✓ Markiert';
    }
    setTimeout(() => { btn.textContent = 'Kopieren'; }, 2200);
  });

  // Import from share link
  document.getElementById('import-confirm-btn').addEventListener('click', () => {
    if (window._pendingImport) {
      saveStundenplan(window._pendingImport);
      updateViewToggleVisibility();
      window._pendingImport = null;
    }
    document.getElementById('import-banner').classList.add('hidden');
  });
  document.getElementById('import-cancel-btn').addEventListener('click', () => {
    window._pendingImport = null;
    document.getElementById('import-banner').classList.add('hidden');
  });

  checkImportFromUrl();

  // Restore persisted last-updated timestamp immediately (visible before fetch completes)
  try {
    const ts = localStorage.getItem(LAST_UPDATED_KEY);
    if (ts) renderLastUpdated(new Date(ts));
  } catch {}

  document.getElementById('changes-close-btn').addEventListener('click', () => {
    document.getElementById('changes-banner').classList.add('hidden');
  });

  updateViewToggleVisibility();

  updateWeekBar();
  fetchAndRender();
  scheduleRefresh();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { fetchAndRender(); scheduleRefresh(); }
    else clearInterval(refreshTimer);
  });
});
