'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const SETTINGS_KEY = 'vplan_settings';
const PROXIES = ['https://corsproxy.io/?', 'https://api.allorigins.win/raw?url='];
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const DAY_NAMES = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const WEEKDAY_LABELS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];
const WEEKDAY_LONG  = ['montag','dienstag','mittwoch','donnerstag','freitag'];
const WEEKDAY_SHORT = ['mo','di','mi','do','fr'];

// ── State ──────────────────────────────────────────────────────────────────
let weekOffset = 0;
let lastEntries = null;
let refreshTimer = null;

// ── Settings ───────────────────────────────────────────────────────────────
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); }
  catch { return {}; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
function settingsAreComplete(s) { return s && s.url && s.klasse; }

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

async function fetchThroughProxy(url, hdrs, debugLines) {
  for (const proxy of PROXIES) {
    try {
      const r = await fetch(proxy + encodeURIComponent(url), { headers: hdrs });
      if (r.status === 429) { debugLines && debugLines.push(`  ${proxy.split('?')[0]}: 429`); continue; }
      const text = await r.text();
      if (r.ok && text.length > 100) return { html: text, proxy };
      debugLines && debugLines.push(`  ${proxy.split('?')[0]}: HTTP ${r.status}, ${text.length} ch`);
    } catch (e) {
      debugLines && debugLines.push(`  ${proxy.split('?')[0]}: ${e.message}`);
    }
  }
  return { html: '', proxy: '' };
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
  for (const sel of navDoc.querySelectorAll('select')) {
    const opts = [...sel.options];
    if (opts.some(o => parseInt(o.value) === kw || parseInt(o.value) === kw - 1)) {
      meta.availableWeeks = opts.map(o => o.value).filter(v => /^\d+$/.test(v));
      const match = opts.find(o => parseInt(o.value) === kw);
      meta.weekValue = match ? match.value
        : meta.availableWeeks[meta.availableWeeks.length - 1] || '';
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

  let best = { entries: [], debugLines: [], source: '' };
  const tryParse = (html, source) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const result = parseVertretungsplan(doc, settings.klasse, targetDate);
    debugLines.push(`${source}: ${result.entries.length} Einträge`);
    if (result.entries.length > best.entries.length) {
      best = { entries: result.entries, debugLines: result.debugLines, source };
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
        const r = await fetch(base.proxy + encodeURIComponent(navUrl), { headers: hdrs });
        if (r.ok) {
          const navDoc = new DOMParser().parseFromString(await r.text(), 'text/html');
          nav = parseNavbarMeta(navDoc, monday, settings.klasse);
          debugLines.push(`Navbar: KW=${nav.weekValue}, Type="${nav.typeCode}", ClassIdx=${nav.classIdx}`);
        }
      } catch (e) {
        debugLines.push(`Navbar-Fehler: ${e.message}`);
      }
    }

    // Try non-navbar frames directly (some Untis layouts have a 'main' frame with current data)
    for (const frame of frames) {
      if (/nav/i.test(frame)) continue;
      try {
        const fUrl = new URL(frame, settings.url).href;
        const r = await fetch(base.proxy + encodeURIComponent(fUrl), { headers: hdrs });
        if (!r.ok) continue;
        const html = await r.text();
        if (html.length > 200) tryParse(html, `Frame ${frame.split('/').pop()}`);
        if (best.entries.length > 0) break;
      } catch (e) {
        debugLines.push(`Frame ${frame}: ${e.message}`);
      }
    }

    // Try common Untis content paths constructed from navbar metadata
    if (best.entries.length === 0 && nav && nav.weekValue) {
      const tc = nav.typeCode || 'w';
      const padd = n => String(n).padStart(5, '0');
      const elIndices = [0, ...(nav.classIdx > 0 ? [nav.classIdx] : [])];
      const weeks = [nav.weekValue, ...[...nav.availableWeeks].reverse().filter(w => w !== nav.weekValue)];

      outer: for (const wk of weeks) {
        for (const el of elIndices) {
          const path = `${tc}/${wk}/${tc}${padd(el)}.htm`;
          try {
            const fileUrl = new URL(path, settings.url).href;
            const r = await fetch(base.proxy + encodeURIComponent(fileUrl), { headers: hdrs });
            if (!r.ok) continue;
            const html = await r.text();
            if (html.length < 200) continue;
            tryParse(html, path);
            if (best.entries.length > 0) break outer;
          } catch (e) {
            debugLines.push(`${path}: ${e.message}`);
          }
        }
      }
    }
  }

  if (best.source) debugLines.push(`══ Ergebnis aus: ${best.source} ══`);
  return {
    entries: best.entries,
    debug: debugLines.concat(best.debugLines).join('\n'),
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

// ── Unified single-pass parser ─────────────────────────────────────────────
// Walks ALL <tr> elements in document order. Three kinds of rows:
//   1. Day-separator: row whose visible text contains exactly one weekday
//      date for this week (after stripping <a> anchors that hold other days)
//      → resets currentDate and colMap
//   2. Header row: cells contain enough column-name keywords (≥3)
//      → builds colMap
//   3. Data row: ≥3 cells, klasse column matches → entry
function parseVertretungsplan(doc, klasse, targetDate) {
  const monday = getMondayOf(targetDate);
  const klasseLower = klasse.toLowerCase().trim();
  const debugLines = [];
  const entries = [];

  debugLines.push(`Suche Klasse "${klasse}", KW${getISOWeekNumber(monday)} ab ${isoDateLocal(monday)}`);

  const allRows = [...doc.querySelectorAll('tr')];
  if (!allRows.length) {
    debugLines.push('Keine <tr>-Elemente gefunden');
    return { entries, debugLines };
  }
  debugLines.push(`Zeilen: ${allRows.length}`);

  const weekIsos = [0,1,2,3,4].map(i => isoDateLocal(addDays(monday, i)));

  let currentDate = '';
  let colMap = null;
  let navBarIndex = -1;
  const stats = { sep: 0, header: 0, data: 0, skipKlasse: 0, skipNoCells: 0 };

  for (const row of allRows) {
    const cells = [...row.querySelectorAll('td')];
    const headers = [...row.querySelectorAll('th')];
    const tdAndTh = [...cells, ...headers];

    // ── 1. Day separator detection ────────────────────────────────────────
    // a) Single-cell row OR row with td.mon_title cell
    const titleCell = row.querySelector('td.mon_title, th.mon_title');
    const isSingleCell = cells.length === 1 && headers.length === 0;
    if (isSingleCell || titleCell) {
      const cell = titleCell || cells[0] || row;
      const fullText = cell.textContent.replace(/\s+/g, ' ').trim();

      // Approach A: Use only non-anchor text (current day is plain text)
      const activeText = extractActiveText(cell);
      let dateCandidate = parseTitleDate(activeText || fullText, monday);

      // Approach B: If cell contains all 5 weekday dates, use section index
      const allDates = [...fullText.matchAll(/(\d{1,2})\.(\d{1,2})\./g)];
      if (allDates.length >= 5) {
        const weekDates = [...new Set(
          allDates
            .map(dm => `${monday.getFullYear()}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`)
            .filter(iso => weekIsos.includes(iso))
        )];
        if (weekDates.length === 5) {
          navBarIndex = Math.min(navBarIndex + 1, 4);
          dateCandidate = weekDates[navBarIndex];
        }
      }

      if (dateCandidate) {
        currentDate = dateCandidate;
        colMap = null;
        stats.sep++;
        debugLines.push(`▶ Tag ${currentDate}: "${fullText.slice(0, 60)}"`);
      }
      continue;
    }

    // ── 2. Header row detection ───────────────────────────────────────────
    if (!colMap && tdAndTh.length >= 3 && looksLikeHeader(tdAndTh)) {
      colMap = buildColMap(tdAndTh.map(c => c.textContent.trim().toLowerCase()));
      stats.header++;
      debugLines.push(`▶ Spalten: ${JSON.stringify(colMap)}`);
      continue;
    }

    // ── 3. Data row ───────────────────────────────────────────────────────
    if (cells.length < 3) { stats.skipNoCells++; continue; }
    if (!colMap) {
      colMap = { klasse:0, stunde:1, fach:2, stattfach:3, raum:4, stattraum:5, vertreter:6, info:7 };
    }

    if (!rowMatchesKlasse(cells, colMap, klasseLower)) {
      stats.skipKlasse++;
      continue;
    }

    const get = (key) => colMap[key] !== undefined ? cellText(cells[colMap[key]]) : '';
    const fach = get('fach');
    const stattFach = get('stattfach');
    const raum = get('raum');
    const stattRaum = get('stattraum');
    const info = get('info');
    const rawDatum = get('datum');
    const datumNorm = (rawDatum ? parseTitleDate(rawDatum, monday) : '') || currentDate;

    entries.push({
      datumNorm, datum: rawDatum,
      stunde: get('stunde'), klasse: get('klasse'),
      fach, stattFach, raum, stattRaum,
      vertreter: get('vertreter'), info,
      typ: detectTypFromColumns(fach, stattFach, raum, stattRaum, info),
    });
    stats.data++;
  }

  debugLines.push(
    `Statistik: ${stats.sep} Trenner, ${stats.header} Header, ` +
    `${stats.data} Treffer, ${stats.skipKlasse} andere Klasse, ` +
    `${stats.skipNoCells} zu klein`
  );
  return { entries, debugLines };
}

// ── Rendering ──────────────────────────────────────────────────────────────
function render(entries, targetDate, debug) {
  const content = document.getElementById('content');
  const monday = getMondayOf(targetDate);

  const byDate = {};
  for (let i = 0; i < 5; i++) byDate[isoDateLocal(addDays(monday, i))] = [];

  for (const e of entries) {
    if (e.datumNorm && byDate.hasOwnProperty(e.datumNorm)) {
      byDate[e.datumNorm].push(e);
    } else {
      byDate[isoDateLocal(monday)].push(e);
    }
  }

  const html = Object.entries(byDate).map(([iso, dayEntries]) => {
    const date = new Date(iso + 'T00:00:00');
    const dayName = WEEKDAY_LABELS[date.getDay() - 1] || DAY_NAMES[date.getDay()];
    const dateStr = formatDateShort(date) + date.getFullYear();
    const body = dayEntries.length
      ? dayEntries.map(renderEntry).join('')
      : `<div class="no-change">Kein Ausfall</div>`;
    return `
      <div class="day-card">
        <div class="day-header">
          <span class="day-name">${dayName}</span>
          <span class="day-date">${dateStr}</span>
        </div>
        ${body}
      </div>`;
  }).join('');

  const debugHtml = debug
    ? `<div class="debug-panel"><strong>Diagnose:</strong><pre>${escHtml(debug)}</pre></div>`
    : '';
  content.innerHTML = (html || '<div class="loading">Keine Einträge gefunden.</div>') + debugHtml;
}

function renderEntry(e) {
  const typClass = e.typ === 'ausfall' ? 'ausfall'
    : e.typ === 'vertretung' ? 'vertretung'
    : e.typ === 'raum' ? 'raum' : '';

  let badge = '';
  if (e.typ === 'ausfall')        badge = '<span class="entry-badge badge-ausfall">Ausfall</span>';
  else if (e.typ === 'vertretung') badge = '<span class="entry-badge badge-vertretung">Vertretung</span>';
  else if (e.typ === 'raum')       badge = '<span class="entry-badge badge-raum">and.Raum</span>';

  const fachDisplay = e.fach && e.fach !== '---' ? escHtml(e.fach) : '<em>entfällt</em>';
  const origFach = e.stattFach && e.stattFach !== e.fach && e.stattFach !== '---'
    ? ` <span class="entry-orig">statt ${escHtml(e.stattFach)}</span>` : '';

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
function setLastUpdated(date) {
  document.getElementById('last-updated').textContent =
    'Zuletzt aktualisiert: ' + date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) + ' Uhr';
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
    const { entries, debug } = await fetchPlan(settings, targetDate);
    lastEntries = entries;
    render(entries, targetDate, debug);
    setLastUpdated(new Date());
    hideError();
  } catch (err) {
    showError('Fehler beim Laden: ' + err.message);
    if (lastEntries !== null) render(lastEntries, targetDate, null);
    else document.getElementById('content').innerHTML = '<div class="loading">Keine Daten verfügbar.</div>';
  }
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(fetchAndRender, REFRESH_INTERVAL_MS);
}

function openSettings() {
  const s = loadSettings();
  document.getElementById('s-url').value = s.url || '';
  document.getElementById('s-user').value = s.user || '';
  document.getElementById('s-pass').value = s.pass || '';
  document.getElementById('s-klasse').value = s.klasse || '';
  document.getElementById('settings-overlay').classList.remove('hidden');
}
function closeSettings() { document.getElementById('settings-overlay').classList.add('hidden'); }

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
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

  updateWeekBar();
  fetchAndRender();
  scheduleRefresh();

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { fetchAndRender(); scheduleRefresh(); }
    else clearInterval(refreshTimer);
  });
});
