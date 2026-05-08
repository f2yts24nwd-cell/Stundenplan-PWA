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

// Submits the Untis filter form with the correct week and "alle" class selection.
// Returns a parsed Document on success, or null if no usable form was found.
async function submitFilterForm(baseDoc, settings, targetDate, hdrs) {
  const form = baseDoc.querySelector('form');
  if (!form) return null;

  const monday = getMondayOf(targetDate);
  const kw = getISOWeekNumber(monday);
  const year = monday.getFullYear();

  const method = (form.getAttribute('method') || 'get').toLowerCase();
  const action = form.getAttribute('action');
  const actionUrl = action ? new URL(action, settings.url).href : settings.url;

  const data = new URLSearchParams();

  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;

    if (el.tagName === 'SELECT') {
      const opts = [...el.options];

      if (isWeekSelector(el)) {
        const v = findWeekOption(opts, kw, year, monday);
        data.set(el.name, v !== null ? v : (el.value || ''));
        continue;
      }

      // Select "alle" / all-classes option if present (matches "- Alle -", "alle", etc.)
      const alleOpt = opts.find(o =>
        o.text.toLowerCase().includes('alle') ||
        o.value.toLowerCase() === 'alle' ||
        o.value === '0'
      );
      if (alleOpt) {
        data.set(el.name, alleOpt.value);
        continue;
      }

      data.set(el.name, el.value || '');
    } else if (el.type !== 'submit' && el.type !== 'button' && el.type !== 'reset' && el.type !== 'image') {
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) data.set(el.name, el.value);
      } else {
        data.set(el.name, el.value || '');
      }
    }
  }

  let res;
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

  if (!res || !res.ok) return null;
  const html = await res.text();
  return new DOMParser().parseFromString(html, 'text/html');
}

async function fetchPlan(settings, targetDate) {
  const hdrs = authHeaders(settings);

  // Step 1: Load the base page to read the form structure
  const baseRes = await fetch(CORS_PROXY + encodeURIComponent(settings.url), { headers: hdrs });
  if (!baseRes.ok) throw new Error(`HTTP ${baseRes.status} – ${baseRes.statusText}`);
  const baseHtml = await baseRes.text();
  const baseDoc = new DOMParser().parseFromString(baseHtml, 'text/html');

  // Step 2: Submit the form with correct week + "alle" selection
  let doc = await submitFilterForm(baseDoc, settings, targetDate, hdrs);

  // Fallback: parse the base page directly (shows current week, may be incomplete)
  if (!doc) doc = baseDoc;

  return parseVertretungsplan(doc, settings.klasse, targetDate);
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
function render(entries, targetDate) {
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

  content.innerHTML = html || '<div class="loading">Keine Einträge gefunden.</div>';
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
    const entries = await fetchPlan(settings, targetDate);
    lastEntries = entries;
    render(entries, targetDate);
    setLastUpdated(new Date());
    hideError();
  } catch (err) {
    showError('Fehler beim Laden: ' + err.message);
    // Keep last data visible if available
    if (lastEntries !== null) {
      render(lastEntries, targetDate);
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
