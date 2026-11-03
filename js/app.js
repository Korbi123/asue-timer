'use strict';
/* ==========================================================================
   ASÜ-Timer – Oberfläche, Dialoge, Aktionen und PWA-Anbindung
   ========================================================================== */

/* ---------- Speicher: Rohdaten lokal im Browser, immer in try/catch ---------- */
const STORE_PREFIX = 'asue-timer.';
const Store = {
  get(k) { try { const v = window.localStorage.getItem(STORE_PREFIX + k); return v == null ? null : JSON.parse(v); } catch (e) { return null; } },
  set(k, v) { try { window.localStorage.setItem(STORE_PREFIX + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  available() { try { window.localStorage.setItem(STORE_PREFIX + 'probe', '1'); window.localStorage.removeItem(STORE_PREFIX + 'probe'); return true; } catch (e) { return false; } }
};
function loadState() {
  const st = Store.get('state') || {};
  return {
    settings: Object.assign({}, DEFAULTS, Store.get('settings') || {}),
    mission: st.mission || null,
    history: Array.isArray(st.history) ? st.history.slice(0, 5) : [],
    recent: Array.isArray(st.recent) ? st.recent : ['ST', 'AT Nord', 'WT'],
    lastDevice: st.lastDevice || '68-300'
  };
}
/* Nach jeder Aktion sofort sichern – ein Neustart der App verliert nichts */
function saveState() {
  if (!S) return;
  const ok = Store.set('state', { v: 1, mission: S.mission, history: S.history, recent: S.recent, lastDevice: S.lastDevice })
    && Store.set('settings', S.settings);
  if (!ok && UI.storageOk) toast('⚠ Speichern nicht möglich – Daten gehen beim Schließen der App verloren');
  UI.storageOk = ok;
}

/* ---------- Konstanten ---------- */
const MODES = [
  ['fix', 'Fester Wert', 'Minuten fest vorgeben'],
  ['geraet', 'Nach Gerätetyp', 'Atemluft ÷ Verbrauch'],
  ['druck', 'Aus Startdruck', 'niedrigerer Startdruck × l/bar ÷ Verbrauch']
];
const SET_LABEL = {
  consumption: 'Standardverbrauch', warn: 'Warnsignal-Schwelle', thirdRule: 'Drittel-Regel', prewarn: 'Vorwarnzeit',
  consThreshold: 'Verbrauchs-Schwelle', defaultMode: 'Standard-Zeitmodus', defaultFix: 'Fester Standardwert', theme: 'Darstellung'
};
const TABS = [['einsatz', 'Einsatz'], ['verlauf', 'Verlauf'], ['einstellungen', 'Einstellungen']];
const LVL_ICON = { red: '🔴', orange: '🟠', yellow: '🟡', white: '⚪' };

/* ---------- Zustand: Rohdaten im Arbeitsspeicher, gespiegelt in localStorage ---------- */
let S = loadState();
const UI = {
  tab: 'einsatz', undo: null, modals: [], alarmKey: null, alarmHold: 0, lastBeep: 0, alarms: [], alarmByTid: {},
  notified: new Set(), installEvt: null, waitingSW: null, updating: false, persisted: null, storageOk: true
};

/* ---------- Hilfen ---------- */
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CORR = '<span class="corr" title="korrigiert">✎</span>';
const cm = flag => (flag ? CORR : '');
function toast(msg) {
  const el = $('#toast'); if (!el) return;
  el.innerHTML = `<div>${esc(msg)}</div>`;
  clearTimeout(toast._t); toast._t = setTimeout(() => { el.innerHTML = ''; }, 2800);
}
function applyTheme() {
  const light = S.settings.theme === 'light';
  document.documentElement.classList.toggle('app-light', light);
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', light ? '#ffffff' : '#131b24');
}
function findTrupp(tid) {
  if (!S) return { t: null };
  if (S.mission) { const t = S.mission.trupps.find(x => x.id === tid); if (t) return { t, m: S.mission, hist: false }; }
  for (const h of S.history) { const t = h.trupps.find(x => x.id === tid); if (t) return { t, m: h, hist: true }; }
  return { t: null };
}
const T = tid => findTrupp(tid).t;
const isStandalone = () => { try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; } };
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const notifState = () => (!('Notification' in window) || !('serviceWorker' in navigator)) ? 'nv' : Notification.permission;

/* ---------- Ton (WebAudio) ---------- */
const Sound = {
  ctx: null,
  unlock() {
    try {
      if (!this.ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) this.ctx = new AC(); }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (e) { /* kein Ton verfügbar */ }
  },
  running() { return !!(this.ctx && this.ctx.state === 'running'); },
  beep() {
    if (!this.running()) return;
    try {
      const c = this.ctx, t0 = c.currentTime;
      [0, 0.22, 0.44].forEach(off => {
        const o = c.createOscillator(), g = c.createGain();
        o.type = 'square'; o.frequency.value = 1040;
        g.gain.setValueAtTime(0.0001, t0 + off);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + off + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.16);
        o.connect(g); g.connect(c.destination); o.start(t0 + off); o.stop(t0 + off + 0.18);
      });
    } catch (e) { /* ignorieren */ }
  }
};

/* ---------- Bildschirm wach halten, solange ein Trupp läuft ---------- */
const Wake = {
  lock: null, pending: false, blockedUntil: 0, state: 'aus',
  sync(need) {
    if (!need) { if (this.lock) { this.lock.release().catch(() => {}); this.lock = null; } this.state = 'aus'; return; }
    if (!('wakeLock' in navigator)) { this.state = 'nv'; return; }
    if (this.lock || this.pending || Date.now() < this.blockedUntil || document.visibilityState !== 'visible') return;
    this.pending = true;
    navigator.wakeLock.request('screen')
      .then(l => { this.lock = l; this.state = 'an'; l.addEventListener('release', () => { if (this.lock === l) { this.lock = null; this.state = 'aus'; } }); })
      .catch(() => { this.state = 'blockiert'; this.blockedUntil = Date.now() + 15000; })
      .finally(() => { this.pending = false; });
  },
  label(need) {
    if (!need) return '☾ Wachhalten aus · kein Trupp läuft';
    if (this.state === 'an') return '☀ Bildschirm bleibt an';
    if (this.state === 'nv') return '☀ Wachhalten nicht verfügbar';
    if (this.state === 'blockiert') return '☀ Wachhalten blockiert';
    return '☀ Wachhalten wird angefordert …';
  }
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Wake.blockedUntil = 0; });

/* ==========================================================================
   Aktionen mit Rückgängig (5 Sekunden)
   ========================================================================== */
function snapshot() { return JSON.stringify({ mission: S.mission, history: S.history, recent: S.recent, settings: S.settings, lastDevice: S.lastDevice }); }
function act(label, fn) {
  const snap = snapshot();
  if (fn() === false) return false;
  UI.undo = { label, snap, until: Date.now() + 5000 };
  saveState(); applyTheme();
  renderAll(); showUndo();
  return true;
}
function undo() {
  if (!UI.undo) return;
  Object.assign(S, JSON.parse(UI.undo.snap));
  UI.undo = null; hideUndo(); saveState(); applyTheme();
  UI.alarmKey = null;
  renderAll(); toast('Rückgängig gemacht');
}
function showUndo() {
  const el = $('#undo'); if (!el || !UI.undo) return;
  el.innerHTML = `<span>${esc(UI.undo.label)}</span><button data-act="undo">Rückgängig</button><i></i>`;
  el.hidden = false; $('#app').classList.add('has-undo');
  const bar = el.querySelector('i');
  if (bar.animate) bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: 5000, easing: 'linear', fill: 'forwards' });
}
function hideUndo() { const el = $('#undo'); if (el) el.hidden = true; const app = $('#app'); if (app) app.classList.remove('has-undo'); }

/* ==========================================================================
   Grundgerüst
   ========================================================================== */
const ICONS = {
  brand: '<svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#c40f17"/><g transform="translate(256 286)" fill="#fff"><rect x="-40" y="-200" width="80" height="44" rx="14"/><rect x="-14" y="-170" width="28" height="40"/><circle r="140" fill="none" stroke="#fff" stroke-width="34"/><path d="M0 0V-104A104 104 0 0 1 90.07 52Z" fill="#ffd43b"/><circle r="18"/></g></svg>',
  einsatz: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="14" r="7"/><path d="M12 14v-4M10 3h4M12 3v4M18 7.5l1.5-1.5"/></svg>',
  verlauf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5M12 7.5V12l3 2"/></svg>',
  einstellungen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/></svg>'
};
function buildShell() {
  const app = $('#app');
  app.classList.remove('has-undo', 'has-modal');
  app.innerHTML = `
    <header class="appbar">
      <span class="brand">${ICONS.brand}<span>ASÜ-Timer by LZ4</span></span>
      <button class="snd" id="snd" data-act="sound" hidden>🔇 Ton aktivieren</button>
      <span class="clock" id="pclock" aria-label="Uhrzeit">--:--:--</span>
    </header>
    <div class="upd" id="upd" hidden role="status"></div>
    <main class="view" id="view"></main>
    <div class="undo" id="undo" hidden></div>
    <nav class="nav" aria-label="Hauptnavigation">${TABS.map(([k, l]) => `<button data-act="tab" data-tab="${k}">${ICONS[k]}<span>${l}</span></button>`).join('')}</nav>
    <div class="layer" id="modals"></div>
    <div class="alarm" id="alarm" hidden role="alertdialog" aria-live="assertive" aria-label="Alarm"></div>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>
    <textarea class="share-ta" id="share-ta" aria-hidden="true" tabindex="-1"></textarea>`;
  UI.alarmKey = null; UI.modals = [];
}

function renderAll() {
  if (!S) return;
  const view = $('#view'); if (!view) return;
  const same = view.dataset.tab === UI.tab, y = view.scrollTop;
  view.dataset.tab = UI.tab;
  view.innerHTML = UI.tab === 'einsatz' ? viewEinsatz() : UI.tab === 'verlauf' ? viewVerlauf() : viewSettings();
  view.scrollTop = same ? y : 0;
  $$('.nav button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === UI.tab ? 'page' : 'false'));
  UI.modals.slice().forEach(m => { if (m.opts.refresh) m.opts.refresh(m); });
  liveUpdate();
}

/* ==========================================================================
   Tab „Einsatz“
   ========================================================================== */
function installCard() {
  if (isStandalone()) return '';
  if (UI.installEvt) return `<div class="card"><h3>Als App installieren</h3><p class="note">Dann startet der ASÜ-Timer vom Startbildschirm und funktioniert ohne Netz.</p><button class="btn btn-block" data-act="install">📲 App installieren</button></div>`;
  if (isIOS()) return '<div class="card"><h3>Als App installieren</h3><p class="note">In Safari auf „Teilen“ tippen und „Zum Home-Bildschirm“ wählen.</p></div>';
  return '';
}
function viewStart() {
  return `<section class="start">
    <h2>Bereit für den nächsten Einsatz</h2>
    <p class="muted" style="margin:0">Der ASÜ-Timer erinnert, warnt und rechnet. Maßgeblich bleibt die Atemschutzüberwachungstafel.</p>
    <div class="field"><label for="kw-in">Stichwort (optional)</label><input class="input" id="kw-in" placeholder="z. B. B3 Wohnungsbrand" autocomplete="off" enterkeyhint="done"></div>
    <button class="btn btn-primary btn-big" data-act="newMission" data-kind="einsatz">Neuer Einsatz</button>
    <button class="btn btn-big" data-act="newMission" data-kind="uebung">Neue Übung</button>
    <p class="note">Übung und Einsatz verhalten sich identisch. Die Übung trägt nur das Badge „ÜBUNG“.</p>
    ${installCard()}
  </section>`;
}

function viewEinsatz() {
  const m = S.mission;
  if (!m) return viewStart();
  const now = Clock.now(), s = S.settings, isU = m.kind === 'uebung';
  const list = orderedTrupps(m);
  const active = list.filter(t => Calc.status(t) !== 'beendet').length;
  const full = active >= 10;
  return `
  <section class="mhead" aria-label="${isU ? 'Übung' : 'Einsatz'}">
    <div class="mrow"><span class="kind ${m.kind}">${isU ? 'ÜBUNG' : 'EINSATZ'}</span>
      <button class="kw" data-act="editKeyword">${m.keyword ? esc(m.keyword) + cm(m.kwCorr) : '<i>Stichwort ergänzen</i>'}</button></div>
    <div class="mmeta"><span>Beginn <b>${fmtHM(m.t0)}</b> · Dauer <b data-live="mdur">${fmtDur(now - m.t0)}</b></span><span class="wake" data-live="wake"></span></div>
    <div class="row2"><button class="btn" data-act="shareBoard">⇪ Brett teilen</button><button class="btn btn-outline-danger" data-act="endMission">${isU ? 'Übung' : 'Einsatz'} beenden</button></div>
  </section>
  <div class="row2">
    <button class="btn btn-primary" data-act="addTrupp" ${full ? 'disabled' : ''}>＋ Trupp anlegen</button>
    <button class="btn btn-st" data-act="addST" ${full ? 'disabled' : ''}>🛡 Sicherheitstrupp bereitstellen</button>
  </div>
  <p class="note">${full ? 'Maximal 10 Trupps gleichzeitig. Beende einen Trupp, um einen neuen anzulegen.' : `${active} von 10 Trupps aktiv · Reihenfolge wie angelegt, beendete Trupps unten`}</p>
  <div class="tiles">${list.length ? list.map(t => tileHTML(t, Calc.analyze(t, s, now))).join('') : '<div class="empty">Noch kein Trupp angelegt.<br>Tippe auf „＋ Trupp anlegen“.</div>'}</div>`;
}

/* Statusstufe einer Kachel: Farbe immer mit Icon + Text */
function tileLevel(a, hasAlarm) {
  if (a.status === 'bereit') return { lvl: 'st', pill: '🛡 Bereit', cls: 'b-st' };
  if (a.status === 'angelegt') return { lvl: 'grey', pill: '⏸ Angelegt', cls: 'b-grey' };
  if (a.status === 'beendet') return { lvl: 'grey', pill: '⏹ Beendet', cls: 'b-grey' };
  const L = a.warnings.map(w => w.lvl);
  if (hasAlarm) return { lvl: 'red', pill: '🔴 Alarm', cls: 'b-red' };
  if (L.includes('red')) return { lvl: 'red', pill: '🔴 Kritisch', cls: 'b-red' };
  if (a.over >= 0) return { lvl: 'red', pill: '🔴 Überzeit', cls: 'b-red' };
  if (L.includes('orange')) return { lvl: 'orange', pill: '🟠 Vorwarnung', cls: 'b-orange' };
  if (L.includes('yellow')) return { lvl: 'yellow', pill: '🟡 Hinweis', cls: 'b-yellow' };
  if (a.issues.length) return { lvl: 'white', pill: '⚪ Prüfen', cls: 'b-white' };
  return { lvl: 'green', pill: '🟢 OK', cls: 'b-green' };
}
function warnsHTML(a) {
  const rank = { red: 0, orange: 1, yellow: 2, white: 3 };
  const W = a.warnings.slice();
  a.issues.forEach(x => W.push({ lvl: 'white', text: 'Unplausibel: ' + x.text }));
  W.sort((x, y) => rank[x.lvl] - rank[y.lvl]);
  return W.map(w => `<span class="badge b-${w.lvl}">${LVL_ICON[w.lvl]} ${esc(w.text)}</span>`).join('');
}
function metaHTML(t, a) {
  const ex = a.ms.ex;
  return `<div class="meta"><button class="linkish" data-act="editDevice" data-tid="${t.id}">${esc(a.device.label)}${cm(t.corr.device)} · ${ex.label}${cm(t.corr.mode)}: <b>${ex.min} min</b>${ex.fallback ? ' (vorläufig)' : ''}</button></div>`;
}
function marksHTML(t, ms) {
  const ack = t.acks || {};
  const ok = '<span class="ok" title="Druckabfrage erfolgt">✓</span>';
  return `<div class="marks"><span class="mk">⅓ um <b>${fmtHM(ms.t13)}</b>${ack.t13 ? ok : ''}</span><span>·</span><span class="mk">⅔ um <b>${fmtHM(ms.t23)}</b>${ack.t23 ? ok : ''}</span><span>·</span><span class="mk">Ende um <b>${fmtHM(ms.tEnd)}</b></span></div>`;
}
function ruleText(a) {
  const P = a.persons.filter(p => !p.noStart);
  if (!P.length) return 'Rückzugsdruck: Startdruck fehlt';
  const name = p => p.rt.rule === 'ziel' ? 'Ziel-Regel (2 × Hinweg)' : p.rt.rule === 'drittel' ? 'Drittel-Regel' : 'keine, nur Warnsignal-Prognose';
  const u = [...new Set(P.map(name))];
  return u.length === 1 ? `Rückzugsregel: <b>${u[0]}</b>` : 'Rückzugsregel: ' + P.map(p => `${p.role} <b>${name(p)}</b>`).join(' · ');
}

/* Anfangsdruck aus dem Anlegen (vor dem Start) */
function preHTML(t) {
  const an = Calc.anlegeEv(t); if (!an) return '';
  const D = `data-tid="${t.id}"`;
  return `<div class="pre"><div class="lbl">Anfangsdruck · <button class="linkish" data-act="corrTime" ${D} data-eid="${an.id}">angelegt ${fmtHM(an.t)}${cm(an.corr.t)}</button></div>
    <div class="pre-row">${[0, 1].map(i => {
      const v = an.p[i];
      return `<button class="pv${v == null ? ' missing' : ''}" data-act="corrP" ${D} data-eid="${an.id}" data-i="${i}"><small>${t.persons[i].role}</small><span>${v == null ? '＋ eingeben' : `<b>${v}</b> bar${cm(an.corr.p[i])}`}</span></button>`;
    }).join('')}</div></div>`;
}

/* Druck-Tabelle TF | TM nebeneinander (wie auf der Tafel), maßgebliche Person hervorgehoben */
function personsTable(t, a) {
  const D = `data-tid="${t.id}"`, st = Calc.startEv(t), P = a.persons, lead = a.lead;
  const cls = i => (lead === i ? ' class="lead"' : '');
  const no = '<span class="muted">–</span>';
  const head = P.map((p, i) => `<th${cls(i)}><button class="pname" data-act="personName" ${D} data-i="${i}">${p.role}${p.name !== p.role ? ' · ' + esc(p.name) : ''}${cm(t.corr.persons[i])}</button>${lead === i ? '<span class="leadtag">★ maßgeblich</span>' : ''}</th>`).join('');
  const row = (label, fn) => `<tr><th scope="row">${label}</th>${P.map((p, i) => `<td${cls(i)}>${fn(p, i)}</td>`).join('')}</tr>`;
  return `<table class="pt"><thead><tr><th scope="col"><span class="sr">Wert</span></th>${head}</tr></thead><tbody>
    ${row('Start', (p, i) => (p.noStart
      ? `<button class="pv missing" data-act="corrP" ${D} data-eid="${st.id}" data-i="${i}">＋ eingeben</button>`
      : `<button class="pv" data-act="corrP" ${D} data-eid="${p.sp.ev.id}" data-i="${i}"><b>${p.startP}</b> bar${cm(p.sp.ev.corr.p[i])}${p.sp.src === 'anlegen' ? '<small class="src">beim Anlegen</small>' : ''}</button>`))}
    ${row('zuletzt', (p, i) => (p.last ? `<button class="pv" data-act="corrP" ${D} data-eid="${p.last.id}" data-i="${i}"><b>${p.last.p[i]}</b>${cm(p.last.corr.p[i])} <small>${fmtHM(p.last.t)}</small></button>` : no))}
    ${row('jetzt', p => (p.noStart ? no : `<span class="est" data-f="est${p.i}"></span>`))}
    ${row('Verbrauch', p => (p.noStart ? no : `<b>${Math.round(p.lMin)} l/min</b><small>${fmtNum(p.barMin, 1)} bar/min · ${p.basis === 'gemessen' ? 'gemessen' : 'Standard'}</small>`))}
    ${row('Rückzugs&shy;druck', p => (p.noStart ? no : p.rt.value == null ? '<small>keiner</small>' : `<b>${Math.round(p.rt.value)} bar</b>${p.rpReached ? '<span class="badge b-red">⛔ erreicht</span>' : `<span class="est">ca. ${fmtHM(p.tRP)}</span>`}`))}
    ${row('Warn&shy;signal', p => (p.noStart ? no : `<b>${S.settings.warn} bar</b><span class="est">ca. ${fmtHM(p.tWS)}</span>`))}
  </tbody></table>`;
}

function tileHTML(t, a) {
  const D = `data-tid="${t.id}"`;
  const head = `<header class="th"><button class="tname" data-act="rename" ${D} title="Kennung ändern">${t.isST ? '🛡 ' : ''}${esc(t.name)}${cm(t.corr.name)}</button>
     <span data-cls="pillCls" data-f="pill"></span>
     <button class="tmore" data-act="detail" ${D}>Details</button></header>`;
  const meta = metaHTML(t, a);
  const mini = `<div class="mini">${t.persons.map((p, i) => `<button class="linkish" data-act="personName" ${D} data-i="${i}">${p.role} · ${esc(p.name)}${cm(t.corr.persons[i])}</button>`).join('')}</div>`;
  const warns = '<div class="warns" data-html="warns"></div>';

  if (a.status === 'bereit') return `<article class="tile st-bereit" ${D} data-cls="tileCls">${head}
     <p class="note" style="color:var(--text)">Sicherheitstrupp in Bereitstellung, ohne Timer.</p>
     ${mini}${preHTML(t)}${meta}${warns}
     <button class="btn btn-st-solid btn-big" data-act="start" ${D}>🛡 ST einsetzen</button></article>`;

  if (a.status === 'angelegt') return `<article class="tile" ${D} data-cls="tileCls">${head}${mini}${preHTML(t)}${meta}${warns}
     <button class="btn btn-primary btn-big" data-act="start" ${D}>▶ Start (Anschluss)</button></article>`;

  const st = Calc.startEv(t);
  if (a.status === 'beendet') {
    const en = a.end;
    return `<article class="tile st-beendet" ${D} data-cls="tileCls">${head}
      <div class="done-sum"><span>Start ${fmtHM(st.t)}${cm(st.corr.t)} · Ende ${fmtHM(en.t)}${cm(en.corr.t)} · Dauer <b>${fmtDur(a.elapsed)}</b> (erw. ${a.ms.ex.min} min)</span>
      <span>${t.persons.map((p, i) => { const sp = Calc.startPressure(t, i); return `${p.role} ${esc(p.name)}: ${sp.p != null ? sp.p + cm(sp.ev.corr.p[i]) : '–'} → ${en.p[i] != null ? en.p[i] + cm(en.corr.p[i]) : '–'} bar`; }).join('<br>')}</span></div>
      ${warns}
      <button class="btn" data-act="detail" ${D}>Details & Korrektur</button></article>`;
  }

  // läuft
  const ms = a.ms;
  const zi = Calc.firstEv(t, 'ziel'), rz = Calc.firstEv(t, 'rueckzug');
  const lp = a.lead != null ? a.persons[a.lead] : null;
  const leadLine = lp
    ? `<div class="lead-line">Maßgeblich: <b>${lp.role} ${esc(lp.name)}</b><span class="est">${lp.rpReached || lp.tRP == null ? `Warnsignal ca. ${fmtHM(lp.tWS)}` : `Rückzugsdruck ca. ${fmtHM(lp.tRP)}`}</span></div>`
    : '<div class="lead-line muted">Startdruck fehlt – noch keine Druckprognose</div>';
  return `<article class="tile" ${D} data-cls="tileCls">${head}
    <div class="tclock"><div class="timer" data-f="timer" data-cls="timerCls"></div>
      <div style="display:grid;gap:2px"><div class="tsub" data-f="timerSub" data-cls="timerSubCls"></div>
      <button class="linkish small" data-act="corrTime" ${D} data-eid="${st.id}">Start ${fmtHM(st.t)}${cm(st.corr.t)}</button></div></div>
    ${marksHTML(t, ms)}
    ${meta}
    <button class="cta-alarm" data-act="ack" ${D} data-key="t13" data-show="due13" hidden>🔔 ⅓-Druckabfrage fällig · erfolgt</button>
    <button class="cta-alarm" data-act="ack" ${D} data-key="t23" data-show="due23" hidden>🔔 ⅔-Druckabfrage fällig · erfolgt</button>
    ${warns}
    ${leadLine}
    <div class="rule">${ruleText(a)}</div>
    ${personsTable(t, a)}
    <div class="tact">
      ${zi ? `<button class="btn" disabled>✓ Ziel ${fmtHM(zi.t)}</button>` : `<button class="btn" data-act="ziel" ${D}>🎯 Ziel erreicht</button>`}
      ${rz ? `<button class="btn" disabled>✓ Rückzug ${fmtHM(rz.t)}</button>` : `<button class="btn" data-act="rueckzug" ${D}>↩ Rückzug</button>`}
      <button class="btn" data-act="druck" ${D}>＋ Druck erfassen</button>
      <button class="btn btn-end" data-act="ende" ${D}>⏹ Ende</button>
    </div></article>`;
}

/* Live-Werte einer Kachel (ohne DOM-Neuaufbau, damit Taps nicht verloren gehen) */
function tileVM(t, a) {
  const al = UI.alarmByTid[t.id] || [];
  const lv = tileLevel(a, al.length > 0);
  const vm = { tileCls: `tile st-${a.status} lvl-${lv.lvl}${al.length ? ' alarming' : ''}`, pill: lv.pill, pillCls: 'badge ' + lv.cls, warns: warnsHTML(a) };
  if (a.status === 'laeuft') {
    if (a.over >= 0) { vm.timer = '+' + fmtDur(a.over); vm.timerCls = 'timer over'; vm.timerSub = 'Überzeit'; vm.timerSubCls = 'tsub over'; }
    else { vm.timer = fmtDur(a.elapsed); vm.timerCls = 'timer'; vm.timerSub = `noch ${fmtDur(-a.over)} bis Ende`; vm.timerSubCls = 'tsub'; }
    a.persons.forEach(p => { if (!p.noStart) vm['est' + p.i] = `ca. ${Math.round(p.est)} bar`; });
    vm.due13 = al.some(x => x.key === 't13');
    vm.due23 = al.some(x => x.key === 't23');
  }
  return vm;
}
function bind(root, vm) {
  const apply = el => {
    const d = el.dataset;
    if (d.f !== undefined) {
      const v = vm[d.f], s = v == null ? '' : String(v);
      if (el.textContent !== s) el.textContent = s;
      if (el.classList.contains('est')) el.hidden = !s;
    }
    if (d.html !== undefined) { const v = vm[d.html] || ''; if (el._h !== v) { el.innerHTML = v; el._h = v; } }
    if (d.cls !== undefined && vm[d.cls] != null && el.className !== vm[d.cls]) el.className = vm[d.cls];
    if (d.show !== undefined) el.hidden = !vm[d.show];
  };
  if (root.dataset) apply(root);
  root.querySelectorAll('[data-f],[data-html],[data-cls],[data-show]').forEach(apply);
}

/* ==========================================================================
   Takt: Uhr, Kacheln, Alarme, Wake Lock
   ========================================================================== */
function collectAlarms(now) {
  const L = [];
  UI.alarmByTid = {};
  if (S.mission) orderedTrupps(S.mission).forEach((t, k) => {
    const a = Calc.analyze(t, S.settings, now);
    Calc.alarms(t, a, now).forEach(x => {
      x.name = t.name; x.order = k; L.push(x);
      (UI.alarmByTid[t.id] = UI.alarmByTid[t.id] || []).push(x);
    });
  });
  L.sort((x, y) => x.since - y.since || x.order - y.order);
  UI.alarms = L;
}
/* Systembenachrichtigung, wenn die App im Hintergrund ist (bestmöglich, nicht garantiert) */
function notifyHidden(L) {
  const keys = new Set(L.map(a => a.tid + ':' + a.key));
  UI.notified.forEach(k => { if (!keys.has(k)) UI.notified.delete(k); });
  if (document.visibilityState !== 'hidden') return;
  L.forEach(a => { const k = a.tid + ':' + a.key; if (!UI.notified.has(k)) { UI.notified.add(k); notifyAlarm(a); } });
}
function notifyAlarm(a) {
  try {
    if (notifState() !== 'granted') return;
    navigator.serviceWorker.getRegistration().then(reg => {
      if (!reg) return null;
      return reg.showNotification(`🔔 ${a.name}: ${a.title}`, {
        body: a.text, tag: 'asue-' + a.tid + '-' + a.key, renotify: true, requireInteraction: true,
        vibrate: [400, 150, 400, 150, 400], icon: 'icons/icon-192.png', lang: 'de'
      });
    }).catch(() => {});
  } catch (e) { /* keine Benachrichtigung möglich */ }
}
function updateAlarmUI() {
  const box = $('#alarm'); if (!box) return;
  const L = UI.alarms;
  notifyHidden(L);
  if (!L.length) { if (!box.hidden) { box.hidden = true; box.innerHTML = ''; } UI.alarmKey = null; return; }
  if (UI.alarmHold > 0) {
    const k = 'hold:' + L.length;
    if (UI.alarmKey !== k) { box.className = 'alarm held'; box.innerHTML = `🔔 ${L.length === 1 ? '1 Alarm wartet' : L.length + ' Alarme warten'} – erscheint nach der Eingabe`; UI.alarmKey = k; }
    box.hidden = false; return;
  }
  const a = L[0], k = a.tid + ':' + a.key + ':' + L.length;
  if (UI.alarmKey !== k) {
    box.className = 'alarm';
    box.innerHTML = `<div class="al-box">
      <div class="al-kicker">🔔 ALARM</div>
      <div class="al-trupp">${esc(a.name)}</div>
      <div class="al-title">${esc(a.title)}</div>
      <div class="al-text">${esc(a.text)}</div>
      <div class="al-since">ausgelöst ${fmtHM(a.since)}</div>
      <button class="al-ack" data-act="alarmAck" data-tid="${a.tid}" data-key="${a.key}">${esc(a.ackLabel)}</button>
      <div class="al-q">${L.length > 1 ? `Warteschlange: ${L.length - 1} weitere${L.length - 1 === 1 ? 'r Alarm' : ' Alarme'}` : 'Keine weiteren Alarme'}</div></div>`;
    if (box.hidden) UI.lastBeep = 0;
    UI.alarmKey = k;
  }
  box.hidden = false;
  if (Date.now() - UI.lastBeep > 1600) {
    UI.lastBeep = Date.now(); Sound.beep();
    try { if (navigator.vibrate) navigator.vibrate([300, 120, 300]); } catch (e) { /* keine Vibration */ }
  }
}
function liveUpdate() {
  if (!S) return;
  const now = Clock.now();
  const pc = $('#pclock'); if (pc) pc.textContent = fmtHMS(now);
  collectAlarms(now);
  const view = $('#view');
  if (view && UI.tab === 'einsatz' && S.mission) {
    $$('.tile[data-tid]', view).forEach(el => { const t = T(el.dataset.tid); if (t) bind(el, tileVM(t, Calc.analyze(t, S.settings, now))); });
    const md = $('[data-live="mdur"]', view); if (md) md.textContent = fmtDur(now - S.mission.t0);
  }
  const need = !!(S.mission && S.mission.trupps.some(t => Calc.status(t) === 'laeuft'));
  Wake.sync(need);
  const wk = $('[data-live="wake"]');
  if (wk) { wk.textContent = Wake.label(need); wk.classList.toggle('on', need && Wake.state === 'an'); }
  const snd = $('#snd'); if (snd) snd.hidden = !(need && !Sound.running());
  UI.modals.slice().forEach(m => { if (m.opts.live) m.opts.live(m, now); });
  updateAlarmUI();
  if (UI.undo && Date.now() > UI.undo.until) { UI.undo = null; hideUndo(); }
}

/* ==========================================================================
   Dialog-Grundlagen (eigene Dialoge, kein alert/confirm/prompt)
   ========================================================================== */
function openModal(html, opts) {
  opts = opts || {};
  const el = document.createElement('div');
  el.className = 'modal ' + (opts.cls || '');
  el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true');
  el.innerHTML = html;
  $('#modals').appendChild(el);
  const m = { el, opts, close: () => closeModal(m) };
  UI.modals.push(m);
  $('#app').classList.add('has-modal');
  el.addEventListener('click', e => {
    if (e.target === el && opts.backdropClose !== false && !el.classList.contains('full')) { closeModal(m); return; }
    const b = e.target.closest('[data-m]'); if (!b || !el.contains(b)) return;
    if (b.dataset.m === 'close') { closeModal(m); return; }
    const h = opts.on && opts.on[b.dataset.m]; if (h) h(b, m, e);
  });
  if (opts.mount) opts.mount(m);
  if (opts.refresh) opts.refresh(m);
  const f = el.querySelector('[autofocus]'); if (f) setTimeout(() => f.focus(), 40);
  return m;
}
function closeModal(m) {
  if (!m) m = UI.modals[UI.modals.length - 1];
  if (!m || !UI.modals.includes(m)) return;
  UI.modals = UI.modals.filter(x => x !== m);
  m.el.remove();
  const app = $('#app'); if (app) app.classList.toggle('has-modal', UI.modals.length > 0);
  if (m.opts.onClose) m.opts.onClose(m);
}
function closeAllModals() { UI.modals.slice().reverse().forEach(m => closeModal(m)); }
const sheetHead = (title, sub, closeAttr) => `<header class="sheet-h"><div><h2>${title}</h2>${sub ? `<p class="sub">${sub}</p>` : ''}</div><button class="xbtn" data-m="${closeAttr || 'close'}" aria-label="Schließen">✕</button></header>`;

function confirmDialog(o) {
  return openModal(`<div class="sheet">${sheetHead(o.title)}
    <div class="sheet-b">${o.html}</div>
    <footer class="sheet-f"><button class="btn" data-m="no">${esc(o.no || 'Abbrechen')}</button><button class="btn ${o.danger ? 'btn-danger' : 'btn-primary'}" data-m="yes">${esc(o.yes || 'OK')}</button></footer></div>`,
  { cls: 'center', on: { no: (b, m) => { m.close(); if (o.onNo) o.onNo(); }, yes: (b, m) => { m.close(); if (o.onYes) o.onYes(); } } });
}
function plausDialog(issues, onYes) {
  confirmDialog({
    title: '⚪ Unplausibler Wert',
    html: `<ul style="margin:0;padding-left:20px;display:grid;gap:6px">${issues.map(x => `<li>${esc(x)}</li>`).join('')}</ul><p class="note">Bitte prüfen. Speichern ist trotzdem möglich.</p>`,
    no: 'Korrigieren', yes: 'Trotzdem speichern', onYes
  });
}

function textDialog(o) {
  const save = m => {
    const v = $('#txt-in', m.el).value.trim();
    if (!v && o.required) { $('#txt-in', m.el).focus(); return; }
    m.close(); o.onSave(v);
  };
  return openModal(`<div class="sheet">${sheetHead(esc(o.title), o.sub ? esc(o.sub) : '')}
    <div class="sheet-b"><div class="field"><label for="txt-in">${esc(o.label)}</label><input class="input" id="txt-in" value="${esc(o.value)}" placeholder="${esc(o.placeholder || '')}" autocomplete="off" enterkeyhint="done" autofocus></div>
    ${o.chips && o.chips.length ? `<div class="lbl">Schnellauswahl (zuletzt genutzt)</div><div class="chips">${o.chips.map(c => `<button class="chip" data-m="chip" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}</div>
    <footer class="sheet-f"><button class="btn" data-m="close">Abbrechen</button><button class="btn btn-primary" data-m="save">Übernehmen</button></footer></div>`,
  {
    mount: m => { $('#txt-in', m.el).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(m); } }); },
    on: { chip: (b, m) => { $('#txt-in', m.el).value = b.dataset.v; if (o.chipSaves) save(m); }, save: (b, m) => save(m) }
  });
}

/* Plausibilitätsprüfung vor dem Speichern: Hinweis, Speichern trotzdem möglich */
function newIssues(t, mut) {
  const before = new Set(Calc.plausibility(t).map(x => x.key));
  const c = JSON.parse(JSON.stringify(t)); mut(c);
  return Calc.plausibility(c).filter(x => !before.has(x.key)).map(x => x.text);
}
function guarded(t, mut, commit, extra) {
  const issues = newIssues(t, mut).concat(extra || []);
  if (!issues.length) { commit(); return; }
  plausDialog(issues, commit);
}

/* ---------- Nummernblock für Drücke ---------- */
function pressureDialog(o) {
  const t = o.trupp || T(o.tid); if (!t) return null;
  const d = Calc.device(t.device);
  const st = { vals: o.initial.slice(), act: o.idx[0], fresh: true };
  const top = Math.max(300, Math.ceil((d.p || 300) / 10) * 10);
  const quick = []; for (let v = top; v >= 0; v -= 10) quick.push(v);
  const foot = (o.skippable ? `<button class="btn" data-m="skip">${esc(o.skipLabel || 'Überspringen')}</button>` : '<button class="btn" data-m="cancel">Abbrechen</button>')
    + `<button class="btn ${o.saveCls || 'btn-primary'}" data-m="save">${esc(o.saveLabel || 'Speichern')}</button>`
    + (o.extraLabel ? `<button class="btn" data-m="extra">${esc(o.extraLabel)}</button>` : '');
  const html = `<div class="sheet">${sheetHead(esc(o.title), esc(o.sub), 'cancel')}
    <div class="sheet-b np">
      <div class="np-fields${o.idx.length === 1 ? ' one' : ''}">${o.idx.map(i => `<button class="np-f" data-m="sel" data-i="${i}"><span class="np-who">${t.persons[i].role} · ${esc(t.persons[i].name)}</span><span class="np-val" data-v="${i}"></span><span class="np-hint">${esc((o.hints && o.hints[i]) || '')}</span></button>`).join('')}</div>
      <div class="np-quick" aria-label="Schnelltasten in bar">${quick.map(v => `<button data-m="q" data-v="${v}">${v}</button>`).join('')}</div>
      <div class="np-adj"><button data-m="adj" data-d="-10">−10</button><button data-m="adj" data-d="10">+10</button></div>
      <div class="np-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-m="dig" data-n="${n}">${n}</button>`).join('')}<button data-m="bs" aria-label="Ziffer löschen">⌫</button><button data-m="dig" data-n="0">0</button><button class="next" data-m="next">${o.idx.length > 1 ? 'Weiter ›' : 'Leeren'}</button></div>
    </div>
    <footer class="sheet-f${o.extraLabel ? ' three' : ''}">${foot}</footer></div>`;
  const paint = m => {
    $$('.np-f', m.el).forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.i) === st.act)));
    o.idx.forEach(i => { const v = st.vals[i]; $(`[data-v="${i}"]`, m.el).innerHTML = v == null ? '—' : `${v}<small> bar</small>`; });
  };
  const scrollQuick = m => {
    const box = $('.np-quick', m.el);
    const target = st.vals[st.act] != null ? st.vals[st.act] : (o.base ? o.base[st.act] : null);
    if (target == null) return;
    const btn = box.querySelector(`[data-v="${Math.max(0, Math.min(top, Math.round(target / 10) * 10))}"]`);
    if (btn) box.scrollLeft = btn.offsetLeft - box.offsetLeft - box.clientWidth / 2 + btn.offsetWidth / 2;
  };
  const advance = () => { const k = o.idx.indexOf(st.act); if (k < o.idx.length - 1) { st.act = o.idx[k + 1]; st.fresh = true; } };
  const setV = v => { st.vals[st.act] = v; };
  const collect = () => { const vals = [undefined, undefined]; o.idx.forEach(i => { vals[i] = st.vals[i]; }); return vals; };
  return openModal(html, {
    cls: 'full', onClose: o.onClose,
    mount: m => { paint(m); setTimeout(() => scrollQuick(m), 0); },
    on: {
      sel: (b, m) => { st.act = Number(b.dataset.i); st.fresh = true; paint(m); scrollQuick(m); },
      q: (b, m) => { setV(Number(b.dataset.v)); st.fresh = true; advance(); paint(m); scrollQuick(m); },
      adj: (b, m) => { const cur = st.vals[st.act] != null ? st.vals[st.act] : ((o.base && o.base[st.act]) || 0); setV(Math.max(0, cur + Number(b.dataset.d))); st.fresh = false; paint(m); },
      dig: (b, m) => { const n = Number(b.dataset.n), cur = st.vals[st.act]; if (st.fresh || cur == null) setV(n); else if (cur < 100) setV(cur * 10 + n); st.fresh = false; paint(m); },
      bs: (b, m) => { const cur = st.vals[st.act]; setV(cur == null || cur < 10 ? null : Math.floor(cur / 10)); st.fresh = false; paint(m); },
      next: (b, m) => { if (o.idx.length > 1) advance(); else setV(null); paint(m); scrollQuick(m); },
      cancel: (b, m) => m.close(),
      skip: (b, m) => { if (o.onSkip) o.onSkip(() => m.close()); else m.close(); },
      save: (b, m) => o.onSave(collect(), () => m.close()),
      extra: (b, m) => { if (o.onExtra) o.onExtra(collect(), () => m.close()); }
    }
  });
}

/* ---------- Zeitkorrektur ---------- */
function applyHMS(orig, h, mi, s) {
  const d = new Date(orig); d.setHours(h, mi, s, 0);
  let t = d.getTime(); const H12 = 12 * 3600e3;
  if (t - orig > H12) t -= 864e5; else if (orig - t > H12) t += 864e5;
  return t;
}
function timeDialog(o) {
  let v = o.value; const orig = o.value;
  const paint = (m, fromInput) => {
    $('[data-tv]', m.el).textContent = fmtHMS(v);
    const df = Math.round((v - orig) / 1000);
    $('[data-td]', m.el).textContent = df ? `${df > 0 ? '+' : '−'}${fmtDur(Math.abs(df) * 1000)} gegenüber bisher (${fmtHMS(orig)})` : 'unverändert';
    if (!fromInput) $('#tm-in', m.el).value = fmtHMS(v);
  };
  return openModal(`<div class="sheet">${sheetHead(esc(o.title), esc(o.sub))}
    <div class="sheet-b">
      <div class="tbig" data-tv></div><div class="tdiff" data-td></div>
      <div class="row4">${[-5, -1, 1, 5].map(x => `<button class="btn" data-m="add" data-d="${x}">${x > 0 ? '+' : '−'}${Math.abs(x)} min</button>`).join('')}</div>
      <div class="field"><label for="tm-in">Direkteingabe (hh:mm:ss)</label><input type="time" step="1" class="input" id="tm-in"></div>
      <button class="btn" data-m="now">Auf jetzt setzen</button>
    </div>
    <footer class="sheet-f"><button class="btn" data-m="close">Abbrechen</button><button class="btn btn-primary" data-m="save">Speichern</button></footer></div>`, {
    mount: m => {
      paint(m);
      $('#tm-in', m.el).addEventListener('input', e => {
        const p = e.target.value.split(':').map(Number);
        if (p.length >= 2 && p.every(x => !isNaN(x))) { v = applyHMS(orig, p[0], p[1], p[2] || 0); paint(m, true); }
      });
    },
    on: {
      add: (b, m) => { v += Number(b.dataset.d) * MIN; paint(m); },
      now: (b, m) => { v = Math.floor(Clock.now() / 1000) * 1000; paint(m); },
      save: (b, m) => o.onSave(v, () => m.close())
    }
  });
}

/* ==========================================================================
   Fachliche Aktionen
   ========================================================================== */
function pushRecent(v) { if (!v || /^Trupp \d+$/.test(v)) return; S.recent = [v].concat(S.recent.filter(x => x !== v)).slice(0, 6); }
function nextSTName() { const n = S.mission.trupps.filter(t => t.isST).length; return n ? `ST ${n + 1}` : 'ST'; }

function newMission(kind) {
  const kw = (($('#kw-in') || {}).value || '').trim();
  act(kind === 'uebung' ? 'Übung gestartet' : 'Einsatz gestartet', () => {
    S.mission = { id: uid('m'), kind, keyword: kw, t0: Clock.now(), tEnd: null, nextNo: 1, trupps: [] };
  });
}
function endMissionDialog() {
  const m = S.mission, isU = m.kind === 'uebung', noun = isU ? 'Übung' : 'Einsatz';
  const running = m.trupps.filter(t => Calc.status(t) === 'laeuft');
  confirmDialog({
    title: `${noun} beenden?`,
    html: `<p style="margin:0">${running.length ? `<b>${running.length === 1 ? '1 Trupp läuft' : running.length + ' Trupps laufen'} noch</b> (${running.map(t => esc(t.name)).join(', ')}). ${running.length === 1 ? 'Er wird' : 'Sie werden'} mit Ende = jetzt und ohne Enddruck abgeschlossen.` : 'Alle Trupps sind abgeschlossen.'}</p>
      <p class="note">${isU ? 'Die Übung wandert' : 'Der Einsatz wandert'} in den Verlauf (die letzten 5 bleiben erhalten).</p>`,
    yes: `${noun} beenden`, danger: true, onYes: endMission
  });
}
function endMission() {
  const now = Clock.now();
  closeAllModals();
  act(`${S.mission.kind === 'uebung' ? 'Übung' : 'Einsatz'} beendet`, () => {
    const m = S.mission;
    m.trupps.forEach(t => { if (Calc.status(t) === 'laeuft') t.events.push(mkEvent('ende', now, [null, null], { auto: true })); });
    m.tEnd = now;
    S.history.unshift(m); S.history = S.history.slice(0, 5);   // ältere automatisch gelöscht
    S.mission = null;
  });
}

/* Trupp anlegen (Formular → Anfangsdruck) oder Gerät/Zeitmodus ändern */
function truppForm(o) {
  const s = S.settings, edit = o.mode === 'edit';
  const src = edit ? T(o.tid) : null;
  if (edit && !src) return;
  if (!edit && !S.mission) return;
  const f = edit
    ? { name: src.name, tf: src.persons[0].name, tm: src.persons[1].name, device: Object.assign({}, src.device), mode: src.mode, fixMin: src.fixMin }
    : { name: o.isST ? nextSTName() : `Trupp ${S.mission.nextNo}`, tf: 'TF', tm: 'TM', device: { key: S.lastDevice || '68-300', V: null, p: null }, mode: s.defaultMode, fixMin: s.defaultFix };
  if (f.device.V == null) f.device.V = 6.8;
  if (f.device.p == null) f.device.p = 300;
  const defName = f.name;
  const title = edit ? 'Gerät & Zeitmodus' : o.isST ? 'Sicherheitstrupp bereitstellen' : 'Neuer Trupp';
  const chips = o.isST ? ['ST'].concat(S.recent.filter(x => x !== 'ST')) : S.recent;
  const partDev = () => DEVICES.map(dv => {
    const on = f.device.key === dv.key;
    const sp = Calc.device(dv.key === 'custom' ? { key: 'custom', V: f.device.V, p: f.device.p } : { key: dv.key });
    return `<button class="opt" role="radio" aria-checked="${on}" data-m="dev" data-v="${dv.key}"><span class="r"></span><span>${esc(dv.label)}<small>${dv.key === 'custom' ? 'Volumen gesamt und Nenndruck selbst eingeben' : `${fmtNum(sp.cap)} l Atemluft · ${fmtNum(sp.lpb, 2)} l/bar`}</small></span></button>`;
  }).join('') + (f.device.key === 'custom' ? `<div class="row2"><div class="field"><label for="f-V">Volumen gesamt (l)</label><input class="input" id="f-V" type="number" inputmode="decimal" step="0.1" min="0" value="${f.device.V}"></div><div class="field"><label for="f-p">Nenndruck (bar)</label><input class="input" id="f-p" type="number" inputmode="numeric" step="10" min="0" value="${f.device.p}"></div></div><p class="note" data-part="cap"></p>` : '');
  const partMode = () => MODES.map(([k, l, sm]) => `<button class="opt" role="radio" aria-checked="${f.mode === k}" data-m="mode" data-v="${k}"><span class="r"></span><span>${l}<small>${sm}</small></span></button>`).join('');
  const partFix = () => f.mode === 'fix' ? `<div class="set-row" style="border:0;padding:0"><div class="lbl2">Fester Wert</div><div class="stepper"><button data-m="fix" data-d="-5" aria-label="5 Minuten weniger">−</button><output>${f.fixMin} min</output><button data-m="fix" data-d="5" aria-label="5 Minuten mehr">+</button></div></div>` : '';
  const partPrev = () => {
    const ex = Calc.expected({ mode: f.mode, fixMin: f.fixMin, device: f.device, events: edit ? src.events : [] }, s);
    const later = ex.fallback ? (edit ? ' · wird mit dem Anfangsdruck neu berechnet' : ' · wird nach Eingabe des Anfangsdrucks genau berechnet') : '';
    return `Erwartete Einsatzzeit: <b>ca. ${ex.min} min</b><br><small>${esc(ex.text)}${later}</small>`;
  };
  const PARTS = { dev: partDev, mode: partMode, fix: partFix, prev: partPrev };
  const paintCap = m => {
    const el = $('[data-part="cap"]', m.el); if (!el) return;
    const sp = Calc.device({ key: 'custom', V: f.device.V, p: f.device.p });
    el.textContent = `Atemluft = ${fmtNum(f.device.V || 0, 1)} l × ${f.device.p || 0} bar${f.device.p > 200 ? ' × 0,9' : ''} = ${fmtNum(sp.cap)} l · ${fmtNum(sp.lpb, 2)} l/bar`;
  };
  const paint = (m, which) => { (which || Object.keys(PARTS)).forEach(k => { const el = $(`[data-part="${k}"]`, m.el); if (el) el.innerHTML = PARTS[k](); }); paintCap(m); };
  const read = m => {
    ['name', 'tf', 'tm'].forEach(k => { const el = $('#f-' + k, m.el); if (el) f[k] = el.value.trim(); });
    const V = $('#f-V', m.el), p = $('#f-p', m.el);
    if (V) f.device.V = parseFloat(String(V.value).replace(',', '.')) || 0;
    if (p) f.device.p = parseFloat(p.value) || 0;
  };

  /* Schritt 2 beim Anlegen: Anfangsdruck TF/TM (z. B. im Fahrzeug beim Anlegen des Geräts) */
  const askPressure = (m, dev) => {
    const name = f.name || defName;
    const persons = [{ role: 'TF', name: f.tf || 'TF' }, { role: 'TM', name: f.tm || 'TM' }];
    const d = Calc.device(dev);
    const create = (vals, startNow, close) => {
      const now = Clock.now();
      const p = [0, 1].map(i => (vals[i] == null ? null : vals[i]));
      const commit = () => {
        close(); m.close();
        act(o.isST ? `${name} bereitgestellt` : startNow ? `${name} angelegt und gestartet` : `${name} angelegt`, () => {
          const mm = S.mission; if (!mm) return false;
          const t = mkTrupp({ name, isST: o.isST, created: now, device: dev, mode: f.mode, fixMin: f.fixMin, tf: persons[0].name, tm: persons[1].name });
          t.events.push(mkEvent('anlegen', now, p));
          if (startNow) t.events.push(mkEvent('start', now, [null, null]));
          if (!o.isST && name === `Trupp ${mm.nextNo}`) mm.nextNo++;
          mm.trupps.push(t);
          if (dev.key !== 'custom') S.lastDevice = dev.key;
          pushRecent(name);
        });
      };
      const issues = Calc.plausibility({ device: dev, persons, events: [mkEvent('anlegen', now, p)] }).map(x => x.text);
      if (issues.length) plausDialog(issues, commit); else commit();
    };
    pressureDialog({
      trupp: { device: dev, persons }, title: 'Anfangsdruck', sub: `${name} · beim Anlegen · Nenndruck ${d.p} bar`,
      idx: [0, 1], initial: [null, null], base: [d.p, d.p], hints: [`Nenndruck ${d.p} bar`, `Nenndruck ${d.p} bar`],
      skippable: true, skipLabel: 'Ohne Druck', saveLabel: o.isST ? '🛡 Bereitstellen' : 'Anlegen', saveCls: o.isST ? 'btn-st-solid' : 'btn-primary',
      extraLabel: o.isST ? null : '▶ Anlegen & starten',
      onSave: (vals, close) => create(vals, false, close),
      onExtra: (vals, close) => create(vals, true, close),
      onSkip: close => create([null, null], false, close)
    });
  };

  const submit = m => {
    read(m);
    if (f.device.key === 'custom' && !(f.device.V > 0 && f.device.p > 0)) { toast('Bitte Volumen und Nenndruck eingeben'); return; }
    const dev = f.device.key === 'custom' ? { key: 'custom', V: f.device.V, p: f.device.p } : { key: f.device.key, V: null, p: null };
    if (!edit) { askPressure(m, dev); return; }
    m.close();
    act(`${src.name}: Gerät/Zeitmodus geändert`, () => {
      const tt = T(o.tid), started = !!Calc.startEv(tt);
      const devChanged = JSON.stringify(dev) !== JSON.stringify({ key: tt.device.key, V: tt.device.V, p: tt.device.p });
      const modeChanged = f.mode !== tt.mode || (f.mode === 'fix' && f.fixMin !== tt.fixMin);
      if (!devChanged && !modeChanged) return false;
      if (started && devChanged) tt.corr.device = true;
      if (started && modeChanged) tt.corr.mode = true;
      tt.device = dev; tt.mode = f.mode; tt.fixMin = f.fixMin;
    });
  };
  openModal(`<div class="sheet">${sheetHead(title, edit ? esc(src.name) + ' · Änderungen an laufenden Trupps werden mit ✎ markiert' : 'Das Gerät gilt für TF und TM')}
    <div class="sheet-b">
      ${edit ? '' : `<div class="field"><label for="f-name">Kennung</label><input class="input" id="f-name" value="${esc(f.name)}" autocomplete="off"></div>
      <div class="chips">${chips.slice(0, 6).map(c => `<button class="chip" data-m="chip" data-v="${esc(c)}">${esc(c)}</button>`).join('')}</div>
      <div class="row2"><div class="field"><label for="f-tf">Truppführer</label><input class="input" id="f-tf" value="${esc(f.tf)}" autocomplete="off"></div><div class="field"><label for="f-tm">Truppmann</label><input class="input" id="f-tm" value="${esc(f.tm)}" autocomplete="off"></div></div>`}
      <div class="lbl">Gerät</div>
      <div class="optlist" role="radiogroup" aria-label="Gerät" data-part="dev"></div>
      <div class="lbl">Erwartete Einsatzzeit</div>
      <div class="optlist" role="radiogroup" aria-label="Zeitmodus" data-part="mode"></div>
      <div data-part="fix"></div>
      <div class="preview" data-part="prev"></div>
    </div>
    <footer class="sheet-f">${edit ? '<button class="btn" data-m="close">Abbrechen</button><button class="btn btn-primary" data-m="save">Übernehmen</button>'
      : '<button class="btn" data-m="close">Abbrechen</button><button class="btn btn-primary" data-m="save">Weiter › Anfangsdruck</button>'}</footer></div>`, {
    cls: 'full',
    mount: m => {
      paint(m);
      m.el.addEventListener('input', e => { if (e.target.id === 'f-V' || e.target.id === 'f-p') { read(m); paintCap(m); paint(m, ['prev']); } });
    },
    on: {
      chip: (b, m) => { $('#f-name', m.el).value = b.dataset.v; },
      dev: (b, m) => { read(m); f.device.key = b.dataset.v; paint(m, ['dev', 'prev']); },
      mode: (b, m) => { read(m); f.mode = b.dataset.v; paint(m, ['mode', 'fix', 'prev']); },
      fix: (b, m) => { f.fixMin = Math.min(120, Math.max(5, f.fixMin + Number(b.dataset.d))); paint(m, ['fix', 'prev']); },
      save: (b, m) => submit(m)
    }
  });
}

function renameDialog(tid) {
  const t = T(tid); if (!t) return;
  textDialog({
    title: 'Kennung ändern', sub: t.name, label: 'Kennung', value: t.name, required: true, chipSaves: true,
    chips: S.recent.filter(x => x !== t.name),
    onSave: v => { if (v === t.name) return; act(`Kennung: ${v}`, () => { const tt = T(tid); if (Calc.startEv(tt)) tt.corr.name = true; tt.name = v; pushRecent(v); }); }
  });
}
function personDialog(tid, i) {
  const t = T(tid); if (!t) return;
  const p = t.persons[i];
  textDialog({
    title: p.role === 'TF' ? 'Name Truppführer (TF)' : 'Name Truppmann (TM)', sub: t.name, label: 'Name', value: p.name === p.role ? '' : p.name, placeholder: p.role,
    onSave: v => { const nv = v || p.role; if (nv === p.name) return; act(`${p.role}-Name geändert`, () => { const tt = T(tid); if (Calc.startEv(tt)) tt.corr.persons[i] = true; tt.persons[i].name = nv; }); }
  });
}
function keywordDialog() {
  const m = S.mission; if (!m) return;
  textDialog({
    title: 'Stichwort', label: 'Stichwort', value: m.keyword, placeholder: 'z. B. B3 Wohnungsbrand',
    onSave: v => { if (v === m.keyword) return; act('Stichwort geändert', () => { if (S.mission.keyword) S.mission.kwCorr = true; S.mission.keyword = v; }); }
  });
}

/* Drücke eines Ereignisses setzen (Erfassung oder Korrektur) */
function setPressures(tid, eid, vals, label, close) {
  const t = T(tid); const e = t && t.events.find(x => x.id === eid);
  if (!e) { if (close) close(); return; }
  if (vals.every((v, i) => v === undefined || v === e.p[i])) { if (close) close(); return; }
  const mut = tt => {
    const ee = tt.events.find(x => x.id === eid);
    vals.forEach((v, i) => { if (v === undefined) return; if (ee.p[i] != null && ee.p[i] !== v) ee.corr.p[i] = true; ee.p[i] = v; });
  };
  guarded(t, mut, () => { if (close) close(); act(label, () => mut(T(tid))); });
}

/* Start = Anschluss / Losgehen. Druck ist hier optional: der Anfangsdruck liegt meist schon vor. */
function startTrupp(tid) {
  const t = T(tid); if (!t || Calc.startEv(t)) return;
  const now = Clock.now(); let eid = null;
  act(t.isST ? `${t.name} eingesetzt` : `${t.name} gestartet`, () => { const ev = mkEvent('start', now, [null, null]); eid = ev.id; T(tid).events.push(ev); });
  const d = Calc.device(t.device), an = Calc.anlegeEv(t);
  const pre = [0, 1].map(i => (an && an.p[i] != null ? an.p[i] : null));
  const both = pre.every(v => v != null);
  pressureDialog({
    tid, title: both ? 'Druck beim Anschluss (optional)' : 'Startdruck',
    sub: `${t.name} · Start ${fmtHM(now)} · ${both ? `Anfangsdruck ${pre[0]} / ${pre[1]} bar` : `Nenndruck ${d.p} bar`}`,
    idx: [0, 1], initial: [null, null], base: pre.map(v => (v != null ? v : d.p)),
    hints: pre.map(v => (v != null ? `Anfangsdruck ${v} bar` : `Nenndruck ${d.p} bar`)),
    skippable: true, skipLabel: both ? 'Unverändert' : 'Später eingeben', saveLabel: 'Druck speichern',
    onSave: (vals, close) => setPressures(tid, eid, vals, 'Druck beim Anschluss erfasst', close)
  });
}

const EVD = {
  ziel: { title: 'Ziel erreicht', save: 'Ziel speichern', skip: 'Ohne Druck speichern', optional: true, done: 'Ziel erreicht' },
  rueckzug: { title: 'Rückzug', save: 'Rückzug speichern', skip: 'Ohne Druck speichern', optional: true, done: 'Rückzug erfasst' },
  ende: { title: 'Ende · Enddruck', save: 'Trupp beenden', skip: 'Ohne Enddruck beenden', optional: true, done: 'beendet' },
  abfrage: { title: 'Druckabfrage', save: 'Druck speichern', optional: false, done: 'Druck erfasst' }
};
function eventDialog(tid, type) {
  const t = T(tid); if (!t || Calc.status(t) !== 'laeuft') return;
  if ((type === 'ziel' || type === 'rueckzug') && Calc.firstEv(t, type)) { toast('Bereits erfasst – Korrektur über „Details“'); return; }
  const now = Clock.now(), cfg = EVD[type], a = Calc.analyze(t, S.settings, now);
  const commit = (vals, close) => {
    const ev = mkEvent(type, now, vals.map(v => (v == null ? null : v)));
    const mut = tt => { tt.events.push(JSON.parse(JSON.stringify(ev))); };
    guarded(t, mut, () => { close(); act(`${t.name}: ${cfg.done}`, () => mut(T(tid))); });
  };
  pressureDialog({
    tid, title: cfg.title, sub: `${t.name} · ${fmtHM(now)}${cfg.optional ? ' · Druck optional' : ''}`, idx: [0, 1], initial: [null, null],
    base: a.persons.map(p => (p.noStart ? null : Math.round(p.est))),
    hints: a.persons.map(p => (p.noStart ? '' : `Schätzung ca. ${Math.round(p.est)} bar`)),
    skippable: cfg.optional, skipLabel: cfg.skip, saveLabel: cfg.save,
    onSave: (vals, close) => { if (!cfg.optional && vals.every(v => v == null)) { toast('Bitte mindestens einen Druck eingeben'); return; } commit(vals, close); },
    onSkip: close => commit([null, null], close)
  });
}

/* Alarm quittieren; ⅓/⅔ öffnet direkt die Druckeingabe */
function ackAlarm(tid, key) {
  const t = T(tid); if (!t) return;
  const now = Clock.now();
  UI.alarmKey = null;
  if (key === 't13' || key === 't23') {
    const tag = key === 't13' ? '1/3' : '2/3', sym = key === 't13' ? '⅓' : '⅔';
    let eid = null;
    act(`${t.name}: ${sym}-Druckabfrage quittiert`, () => { const tt = T(tid); tt.acks[key] = now; const ev = mkEvent('abfrage', now, [null, null], { tag }); eid = ev.id; tt.events.push(ev); });
    const a = Calc.analyze(T(tid), S.settings, now);
    UI.alarmHold++;
    pressureDialog({
      tid, title: `${sym}-Druckabfrage`, sub: `${t.name} · ${fmtHM(now)} · Druck TF und TM`, idx: [0, 1], initial: [null, null],
      base: a.persons.map(p => (p.noStart ? null : Math.round(p.est))),
      hints: a.persons.map(p => (p.noStart ? '' : `Schätzung ca. ${Math.round(p.est)} bar`)),
      skippable: true, skipLabel: 'Überspringen', saveLabel: 'Druck speichern',
      onSave: (vals, close) => setPressures(tid, eid, vals, `${sym}-Druck erfasst`, close),
      onClose: () => { UI.alarmHold = Math.max(0, UI.alarmHold - 1); UI.alarmKey = null; }
    });
  } else {
    act(`${t.name}: Alarm quittiert`, () => { T(tid).acks[key] = now; });
  }
}

function corrTime(tid, eid) {
  const t = T(tid); const e = t && t.events.find(x => x.id === eid); if (!e) return;
  timeDialog({
    title: `Zeit korrigieren · ${evLabel(e)}`, sub: `${t.name} · bisher ${fmtHMS(e.t)}`, value: e.t,
    onSave: (nt, close) => {
      if (nt === e.t) { close(); return; }
      const mut = tt => { const ee = tt.events.find(x => x.id === eid); ee.t = nt; ee.corr.t = true; };
      const extra = nt > Clock.now() + 30000 ? [`Der Zeitpunkt ${fmtHM(nt)} liegt in der Zukunft`] : [];
      guarded(t, mut, () => { close(); act(`${evLabel(e)} korrigiert`, () => mut(T(tid))); }, extra);
    }
  });
}
function corrPressure(tid, eid, i) {
  const t = T(tid); const e = t && t.events.find(x => x.id === eid); if (!e) return;
  const d = Calc.device(t.device), filling = e.p[i] == null, role = t.persons[i].role;
  pressureDialog({
    tid, title: `${filling ? 'Druck eintragen' : 'Druck korrigieren'} · ${evLabel(e)}`, sub: `${t.name} · ${role} ${t.persons[i].name} · ${fmtHM(e.t)}`,
    idx: [i], initial: [e.p[0], e.p[1]], base: [e.p[0] != null ? e.p[0] : d.p, e.p[1] != null ? e.p[1] : d.p],
    hints: [e.p[0] != null ? `bisher ${e.p[0]} bar` : '', e.p[1] != null ? `bisher ${e.p[1]} bar` : ''],
    saveLabel: 'Speichern',
    onSave: (vals, close) => setPressures(tid, eid, vals, `${role}-Druck ${filling ? 'eingetragen' : 'korrigiert'}`, close)
  });
}
function delEvent(tid, eid) {
  const t = T(tid); const e = t && t.events.find(x => x.id === eid); if (!e || e.type === 'start' || e.type === 'anlegen') return;
  confirmDialog({
    title: 'Ereignis löschen?',
    html: `<p style="margin:0">${evLabel(e)} um ${fmtHM(e.t)} wird entfernt. Alle Werte werden neu berechnet.${e.tag ? ' Die Druckabfrage gilt danach wieder als offen.' : ''}</p>`,
    yes: 'Löschen', danger: true,
    onYes: () => act(`${evLabel(e)} gelöscht`, () => {
      const tt = T(tid); tt.events = tt.events.filter(x => x.id !== eid);
      if (e.tag === '1/3') delete tt.acks.t13;
      if (e.tag === '2/3') delete tt.acks.t23;
    })
  });
}
function removeTrupp(tid) {
  const t = T(tid); if (!t) return;
  confirmDialog({
    title: `${esc(t.name)} entfernen?`, html: '<p style="margin:0">Der Trupp und alle seine Werte werden aus diesem Einsatz gelöscht.</p>', yes: 'Entfernen', danger: true,
    onYes: () => act(`${t.name} entfernt`, () => { S.mission.trupps = S.mission.trupps.filter(x => x.id !== tid); })
  });
}

/* ---------- Trupp-Detailansicht mit Ereignisliste ---------- */
function detailHTML(t) {
  const { hist, m } = findTrupp(t.id);
  const now = Clock.now(), s = S.settings, a = Calc.analyze(t, s, hist ? m.tEnd : now);
  const D = `data-tid="${t.id}"`;
  const ed = (actn, extra) => `<button class="edit" data-act="${actn}" ${D} ${extra || ''}>ändern</button>`;
  const lv = tileLevel(a, false), ex = a.ms.ex, st = Calc.startEv(t), an = Calc.anlegeEv(t);
  const statusTxt = a.status === 'laeuft' ? `läuft seit ${fmtHM(st.t)} · <span data-f="dtimer"></span>`
    : a.status === 'beendet' ? `beendet ${fmtHM(a.end.t)} · Dauer ${fmtDur(a.elapsed)}`
      : a.status === 'bereit' ? `Sicherheitstrupp bereit${an ? ' · angelegt ' + fmtHM(an.t) : ''}` : `angelegt${an ? ' ' + fmtHM(an.t) : ''} · noch nicht gestartet`;
  const rows = [
    ['Kennung', `${esc(t.name)}${cm(t.corr.name)}${t.isST ? '<small>Sicherheitstrupp</small>' : ''}`, ed('rename')],
    ['Truppführer', `${esc(t.persons[0].name)}${cm(t.corr.persons[0])}<small>TF</small>`, ed('personName', 'data-i="0"')],
    ['Truppmann', `${esc(t.persons[1].name)}${cm(t.corr.persons[1])}<small>TM</small>`, ed('personName', 'data-i="1"')],
    ['Gerät', `${esc(a.device.label)}${cm(t.corr.device)}<small>${fmtNum(a.device.cap)} l Atemluft · ${fmtNum(a.device.lpb, 2)} l/bar</small>`, ed('editDevice')],
    ['Zeitmodus', `${ex.label}: ${ex.min} min${cm(t.corr.mode)}<small>${esc(ex.text)}</small>`, ed('editDevice')]
  ];
  let calc = '';
  if (st) {
    const P = a.persons;
    const tr = (label, fn) => `<tr><th>${label}</th>${P.map(p => `<td>${p.noStart ? '–' : fn(p)}</td>`).join('')}</tr>`;
    const live = a.status === 'laeuft';
    calc = `<div class="card"><h3>Berechnet</h3>
      <p class="small muted" style="margin:0">Wird nach jeder Korrektur sofort neu berechnet. Schätzwerte sind kursiv und gestrichelt.</p>
      ${marksHTML(t, a.ms)}
      <table class="ptable"><thead><tr><th></th>${P.map((p, i) => `<th>${p.role}${live && a.lead === i ? ' ★' : ''}</th>`).join('')}</tr></thead><tbody>
        ${tr('Startdruck', p => `${p.startP} bar<br><small>${p.sp.src === 'anlegen' ? 'beim Anlegen' : 'beim Anschluss'}</small>`)}
        ${tr('Rückzugsdruck', p => (p.rt.value != null ? `<b>${Math.round(p.rt.value)} bar</b><br><small>${esc(p.rt.short)}</small>` : '<small>keiner</small>'))}
        ${tr('Verbrauch', p => `${Math.round(p.lMin)} l/min<br><small>${fmtNum(p.barMin, 1)} bar/min · ${p.basis === 'gemessen' ? 'gemessen' : 'Standard'}</small>`)}
        ${live
          ? tr('Druck jetzt', p => `<span class="est" data-f="dest${p.i}"></span>`)
            + tr('Prognose Rückzugsdruck', p => (p.rt.value == null ? '–' : p.rpReached ? '<b>erreicht</b>' : `<span class="est">ca. ${fmtHM(p.tRP)}</span>`))
            + tr('Prognose Warnsignal', p => `<span class="est">ca. ${fmtHM(p.tWS)}</span>`)
          : tr('Zuletzt', p => (p.last ? `${p.last.p[p.i]} bar<br><small>${fmtHM(p.last.t)}</small>` : '–'))}
      </tbody></table>
      <div class="small muted">${P.filter(p => !p.noStart).map(p => `${p.role}: ${esc(p.rt.text)}`).join('<br>')}</div>
      <div class="warns" data-html="dwarns"></div></div>`;
  }
  const evs = Calc.sorted(t.events);
  const fixed = e => e.type === 'start' || e.type === 'anlegen';
  const evRows = evs.map(e => `<div class="evrow"><div class="lab">${e.type === 'start' ? 'Start' : evLabel(e)}${e.auto ? '<small>automatisch</small>' : ''}</div>
      <button class="evbtn" data-act="corrTime" ${D} data-eid="${e.id}" aria-label="Zeit ${evLabel(e)} korrigieren">${fmtHM(e.t)}${e.corr.t ? '✎' : ''}</button>
      ${[0, 1].map(i => `<button class="evbtn${e.p[i] == null ? ' missing' : ''}" data-act="corrP" ${D} data-eid="${e.id}" data-i="${i}" aria-label="${t.persons[i].role}-Druck ${evLabel(e)} korrigieren">${e.p[i] == null ? '—' : e.p[i]}${e.corr.p[i] ? '✎' : ''}</button>`).join('')}
      ${fixed(e) ? '<span></span>' : `<button class="evdel" data-act="delEvent" ${D} data-eid="${e.id}" aria-label="${evLabel(e)} löschen">🗑</button>`}</div>`).join('');
  const issues = a.issues.length ? `<div class="warns">${a.issues.map(x => `<span class="badge b-white">⚪ ${esc(x.text)}</span>`).join('')}</div>` : '';
  let actions = '';
  if (!hist) {
    if (a.status === 'laeuft') actions = `<div class="tact">
      <button class="btn" data-act="ziel" ${D} ${Calc.firstEv(t, 'ziel') ? 'disabled' : ''}>🎯 Ziel erreicht</button>
      <button class="btn" data-act="rueckzug" ${D} ${Calc.firstEv(t, 'rueckzug') ? 'disabled' : ''}>↩ Rückzug</button>
      <button class="btn" data-act="druck" ${D}>＋ Druck erfassen</button>
      <button class="btn btn-end" data-act="ende" ${D}>⏹ Ende</button></div>`;
    else if (a.status !== 'beendet') actions = `<button class="btn btn-primary btn-big" data-act="start" ${D}>${t.isST ? '🛡 ST einsetzen' : '▶ Start (Anschluss)'}</button>`;
    actions += `<button class="btn btn-outline-danger" data-act="removeTrupp" ${D}>Trupp entfernen</button>`;
  }
  return `<header class="sheet-h"><button class="backbtn" data-m="close">‹ Zurück</button><div><h2>${t.isST ? '🛡 ' : ''}${esc(t.name)}</h2><p class="sub">${statusTxt}</p></div><span class="badge ${lv.cls}" data-cls="dpillCls" data-f="dpill">${lv.pill}</span></header>
    <div class="sheet-b">
      <div class="card"><h3>Stammdaten</h3><div class="dl">${rows.map(r => `<div class="dl-row"><div class="k">${r[0]}</div><div class="v">${r[1]}</div>${r[2]}</div>`).join('')}</div></div>
      ${calc}
      <div class="card"><h3>Ereignisse</h3>${evs.length ? `<div class="evhead"><span>Ereignis</span><span>Zeit</span><span>TF</span><span>TM</span><span></span></div><div class="evlist">${evRows}</div>` : '<p class="note">Noch keine Ereignisse.</p>'}
        ${issues}<p class="note">Tippe auf Zeit oder Druck zum Korrigieren. Korrigierte Werte tragen ✎. Als Startdruck zählt der Druck beim Anschluss, sonst der Druck beim Anlegen.</p></div>
      ${actions ? `<div class="card">${actions}</div>` : ''}
    </div>`;
}
function detailVM(t, now) {
  const { hist, m } = findTrupp(t.id);
  const a = Calc.analyze(t, S.settings, hist ? m.tEnd : now);
  const lv = tileLevel(a, !hist && (UI.alarmByTid[t.id] || []).length > 0);
  const vm = { dpill: lv.pill, dpillCls: 'badge ' + lv.cls, dwarns: a.status === 'laeuft' ? warnsHTML(a) : '' };
  if (a.status === 'laeuft') {
    vm.dtimer = a.over >= 0 ? `Überzeit +${fmtDur(a.over)}` : `${fmtDur(a.elapsed)} gelaufen`;
    a.persons.forEach(p => { if (!p.noStart) vm['dest' + p.i] = `ca. ${Math.round(p.est)} bar`; });
  }
  return vm;
}
function detailDialog(tid) {
  if (!T(tid)) return;
  openModal('<div class="sheet"></div>', {
    cls: 'full',
    refresh: m => {
      const t = T(tid); if (!t) { m.close(); return; }
      const b0 = $('.sheet-b', m.el), y = b0 ? b0.scrollTop : 0;
      m.el.firstElementChild.innerHTML = detailHTML(t);
      const b1 = $('.sheet-b', m.el); if (b1) b1.scrollTop = y;
      bind(m.el, detailVM(t, Clock.now()));
    },
    live: (m, now) => { const t = T(tid); if (t) bind(m.el, detailVM(t, now)); }
  });
}

/* ---------- Brett teilen: Textexport wie auf der Tafel ---------- */
function boardText(m, now) {
  const s = S.settings, refNow = m.tEnd || now;
  const W = [10, 12, 9, 6, 6, 7, 11, 11, 11, 11, 11, 0];
  const H = ['Trupp', 'Person', 'Gerät', 'erw.EZ', 'Start', 'St.-Dr.', '⅓ Zt/Dr', 'Ziel Zt/Dr', '⅔ Zt/Dr', 'Rückz.Zt/Dr', 'Ende Zt/Dr', 'Bemerkungen'];
  const cell = (v, w) => { v = String(v); if (!w) return v; return v.length > w ? v.slice(0, w - 1) + '…' : v.padEnd(w, ' '); };
  const line = arr => arr.map((v, k) => cell(v, W[k])).join(' | ').replace(/\s+$/, '');
  const sep = W.map(w => '-'.repeat(w || 11)).join('-+-');
  const mk = c => (c ? '✎' : '');
  const tp = (e, i) => (e ? `${fmtHM(e.t)}${mk(e.corr.t)}/${e.p[i] == null ? '–' : e.p[i] + mk(e.corr.p[i])}` : '');
  const out = [
    'ASÜ-TIMER · BRETT  (maßgeblich bleibt die Tafel)',
    `${m.kind === 'uebung' ? 'ÜBUNG' : 'EINSATZ'}${m.keyword ? ' · ' + m.keyword : ''} · ${fmtDate(m.t0)} · Beginn ${fmtHM(m.t0)}${m.tEnd ? ' · Ende ' + fmtHM(m.tEnd) : ' · Stand ' + fmtHM(now)}`,
    `Verbrauch ${s.consumption} l/min · Warnsignal ${s.warn} bar · Drittel-Regel ${s.thirdRule ? 'an' : 'aus'} · ✎ = korrigiert`,
    'St.-Dr. = Druck beim Anschluss, sonst Druck beim Anlegen',
    '', line(H), sep
  ];
  orderedTrupps(m).forEach(t => {
    const a = Calc.analyze(t, s, refNow), st = Calc.startEv(t), an = Calc.anlegeEv(t);
    const q13 = t.events.find(e => e.type === 'abfrage' && e.tag === '1/3');
    const q23 = t.events.find(e => e.type === 'abfrage' && e.tag === '2/3');
    const zi = Calc.firstEv(t, 'ziel'), rz = Calc.firstEv(t, 'rueckzug'), en = Calc.firstEv(t, 'ende');
    const extra = Calc.sorted(t.events).filter(e => e.type === 'abfrage' && !e.tag);
    [0, 1].forEach(i => {
      const p = a.persons[i], sp = Calc.startPressure(t, i), rem = [];
      if (i === 0) {
        if (t.isST) rem.push('Sicherheitstrupp');
        if (a.status === 'bereit') rem.push('bereit');
        if (a.status === 'angelegt') rem.push('nicht gestartet');
        if (an && !st) rem.push(`angelegt ${fmtHM(an.t)}${mk(an.corr.t)}`);
        if (a.status === 'laeuft') rem.push(a.over >= 0 ? `ÜBERZEIT +${fmtDur(a.over)}` : 'läuft');
        if (a.status === 'beendet') rem.push(`Dauer ${fmtDur(a.elapsed)}`);
        if (en && en.auto) rem.push('autom. beendet');
        if (t.corr.name || t.corr.device || t.corr.mode) rem.push('Stammdaten ✎');
      }
      if (t.corr.persons[i]) rem.push('Name ✎');
      if (sp.src === 'anschluss' && an && an.p[i] != null && an.p[i] !== sp.p) rem.push(`Anlegen ${an.p[i]}${mk(an.corr.p[i])} bar`);
      if (p.lowStart) rem.push('Startdr. < 90 %');
      if (p.rt) {
        if (p.rt.value != null) rem.push(`RZ ${Math.round(p.rt.value)} bar (${p.rt.rule === 'ziel' ? 'Ziel' : 'Drittel'})`);
        if (a.status === 'laeuft' && p.rpReached) rem.push('RZ-DRUCK ERREICHT');
        if (p.basis === 'gemessen' && p.lMin > s.consThreshold) rem.push(`Verbr. ${Math.round(p.lMin)} l/min`);
      }
      extra.forEach(e => { if (e.p[i] != null) rem.push(`Abfr. ${tp(e, i)}`); });
      out.push(line([
        i === 0 ? t.name + mk(t.corr.name) : '',
        `${t.persons[i].role} ${t.persons[i].name}`,
        i === 0 ? a.device.short + mk(t.corr.device) : '',
        i === 0 ? `${a.ms.ex.min} min` : '',
        st ? fmtHM(st.t) + mk(st.corr.t) : '',
        sp.p != null ? `${sp.p}${mk(sp.ev.corr.p[i])}` : '',
        tp(q13, i), tp(zi, i), tp(q23, i), tp(rz, i), tp(en, i),
        rem.join('; ')
      ]));
    });
    out.push(sep);
  });
  return out.join('\n');
}
async function copyText(text, prefix) {
  const pre = prefix ? prefix + ' – ' : '';
  try { await navigator.clipboard.writeText(text); toast(pre + 'In Zwischenablage kopiert'); return true; } catch (e) { /* weiter mit Fallback */ }
  try { const ta = $('#share-ta'); ta.value = text; ta.select(); if (document.execCommand('copy')) { toast(pre + 'In Zwischenablage kopiert'); return true; } } catch (e) { /* weiter */ }
  toast('Kopieren blockiert – bitte den Text in der Vorschau markieren und kopieren');
  return false;
}
async function shareText(title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  copyText(text, 'Teilen nicht verfügbar');
}
function shareDialog(title, sub, text) {
  openModal(`<div class="sheet">${sheetHead(esc(title), esc(sub))}
    <div class="sheet-b"><pre class="board">${esc(text)}</pre>
    <p class="note">Spalten wie auf der Tafel, feste Breiten (Monospace). ✎ = korrigierter Wert. Seitlich wischen für alle Spalten.</p></div>
    <footer class="sheet-f"><button class="btn" data-m="copy">In Zwischen&shy;ablage kopieren</button><button class="btn btn-primary" data-m="share">⇪ Teilen</button></footer></div>`,
  { cls: 'full', on: { copy: () => copyText(text), share: () => shareText(title, text) } });
}

/* ---------- Verlauf-Details ---------- */
function historyDialog(mid) {
  openModal('<div class="sheet"></div>', {
    cls: 'full',
    refresh: m => {
      const h = S.history.find(x => x.id === mid); if (!h) { m.close(); return; }
      m.el.firstElementChild.innerHTML = `<header class="sheet-h"><button class="backbtn" data-m="close">‹ Zurück</button><div><h2>${esc(h.keyword || 'ohne Stichwort')}</h2><p class="sub">${h.kind === 'uebung' ? 'Übung' : 'Einsatz'} · ${fmtDate(h.t0)} · ${fmtHM(h.t0)}–${fmtHM(h.tEnd)}</p></div></header>
      <div class="sheet-b">${orderedTrupps(h).map(t => {
        const a = Calc.analyze(t, S.settings, h.tEnd), st = Calc.startEv(t), en = a.end;
        return `<div class="card"><div class="hrow"><b>${esc(t.name)}${cm(t.corr.name)}</b><span class="badge b-grey">${a.status === 'beendet' ? '⏹ beendet' : a.status === 'bereit' ? '🛡 bereit' : '⏸ nicht gestartet'}</span></div>
          <div class="small">${esc(a.device.label)} · erw. ${a.ms.ex.min} min${st ? ` · ${fmtHM(st.t)}–${en ? fmtHM(en.t) : '?'} (${fmtDur(a.elapsed)})` : ''}</div>
          <div class="small">${t.persons.map((p, i) => { const sp = Calc.startPressure(t, i); return `${p.role} ${esc(p.name)}: ${sp.p != null ? sp.p : '–'} → ${en && en.p[i] != null ? en.p[i] : '–'} bar`; }).join('<br>')}</div>
          <button class="btn" data-act="detail" data-tid="${t.id}">Details & Korrektur</button></div>`;
      }).join('') || '<p class="note">Keine Trupps.</p>'}</div>
      <footer class="sheet-f"><button class="btn btn-primary" data-act="shareBoard" data-mid="${h.id}">⇪ Brett teilen</button></footer>`;
    }
  });
}

/* ==========================================================================
   Tabs „Verlauf“ und „Einstellungen“
   ========================================================================== */
function viewVerlauf() {
  const H = S.history;
  return `<h2>Verlauf</h2>
  <p class="muted" style="margin:0">Die letzten 5 beendeten Einsätze und Übungen. Ältere werden automatisch gelöscht.</p>
  ${H.length ? H.map(h => `<div class="card"><div class="hrow"><span class="kind ${h.kind}">${h.kind === 'uebung' ? 'ÜBUNG' : 'EINSATZ'}</span><b>${esc(h.keyword || 'ohne Stichwort')}</b></div>
     <div class="small muted">${fmtDate(h.t0)} · ${fmtHM(h.t0)}–${fmtHM(h.tEnd)} · ${h.trupps.length} ${h.trupps.length === 1 ? 'Trupp' : 'Trupps'}</div>
     <div class="row2"><button class="btn" data-act="histDetail" data-mid="${h.id}">Details</button><button class="btn" data-act="shareBoard" data-mid="${h.id}">⇪ Brett teilen</button></div></div>`).join('')
    : '<div class="empty">Noch keine beendeten Einsätze oder Übungen.</div>'}`;
}

function viewSettings() {
  const s = S.settings;
  const step = (k, label, unit, d, min, max, small) => `<div class="set-row"><div class="lbl2">${label}${small ? `<small>${small}</small>` : ''}</div><div class="stepper"><button data-act="step" data-k="${k}" data-d="${-d}" data-min="${min}" data-max="${max}" aria-label="${label} verringern">−</button><output>${s[k]} ${unit}</output><button data-act="step" data-k="${k}" data-d="${d}" data-min="${min}" data-max="${max}" aria-label="${label} erhöhen">+</button></div></div>`;
  const sw = (k, label, small) => `<div class="set-row"><div class="lbl2">${label}${small ? `<small>${small}</small>` : ''}</div><button class="switch" role="switch" aria-checked="${!!s[k]}" data-act="toggle" data-k="${k}" aria-label="${label}"><span>${s[k] ? 'AN' : 'AUS'}</span></button></div>`;
  const tests = selfTest();
  const ns = notifState();
  const notif = ns === 'granted' ? '<span class="badge b-green">✓ erlaubt</span>'
    : ns === 'default' ? '<button class="btn" data-act="notify">Erlauben</button>'
      : ns === 'denied' ? '<span class="badge b-grey">✕ blockiert</span>' : '<span class="badge b-grey">nicht verfügbar</span>';
  const inst = isStandalone() ? ['läuft als installierte App', '<span class="badge b-green">✓ installiert</span>']
    : UI.installEvt ? ['startet dann vom Startbildschirm, auch offline', '<button class="btn" data-act="install">📲 Installieren</button>']
      : isIOS() ? ['Safari: „Teilen“ → „Zum Home-Bildschirm“', '<span class="badge b-grey">manuell</span>']
        : ['Browsermenü → „App installieren“ bzw. „Zum Startbildschirm hinzufügen“', '<span class="badge b-grey">manuell</span>'];
  const swOk = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  const store = !UI.storageOk ? ['nicht verfügbar – Daten gehen beim Schließen verloren', '<span class="badge b-orange">⚠ aus</span>']
    : UI.persisted === true ? ['auf diesem Gerät, vor automatischem Löschen geschützt', '<span class="badge b-green">✓ dauerhaft</span>']
      : ['auf diesem Gerät im Browser-Speicher', '<span class="badge b-green">✓ aktiv</span>'];
  return `<h2>Einstellungen</h2>
  <div class="card"><h3>Berechnung</h3>
    ${step('consumption', 'Standardverbrauch', 'l/min', 5, 20, 120, 'gilt bis zur ersten Druckabfrage')}
    ${step('warn', 'Warnsignal-Schwelle', 'bar', 5, 30, 100)}
    ${sw('thirdRule', 'Drittel-Regel', 'Rückzugsdruck, solange kein Ziel erfasst ist')}
    ${step('prewarn', 'Vorwarnzeit', 'min', 1, 1, 10, 'für 🟠 und 🔴 Prognose-Warnungen')}
    ${step('consThreshold', 'Verbrauchs-Schwelle', 'l/min', 5, 40, 150, '🟠 bei höherem gemessenem Verbrauch')}
    <p class="note">Änderungen wirken sofort auf alle laufenden Trupps.</p>
  </div>
  <div class="card"><h3>Vorgaben für neue Trupps</h3>
    <div class="lbl">Standard-Zeitmodus</div>
    <div class="optlist" role="radiogroup" aria-label="Standard-Zeitmodus">${MODES.map(([k, l, sm]) => `<button class="opt" role="radio" aria-checked="${s.defaultMode === k}" data-act="set" data-k="defaultMode" data-v="${k}"><span class="r"></span><span>${l}<small>${sm}</small></span></button>`).join('')}</div>
    ${step('defaultFix', 'Fester Standardwert', 'min', 5, 5, 120)}
  </div>
  <div class="card"><h3>Alarm</h3>
    <div class="set-row"><div class="lbl2">Alarm testen<small>Ton und Vibration einmal auslösen</small></div><button class="btn" data-act="testAlarm">🔔 Testen</button></div>
    <div class="set-row"><div class="lbl2">Benachrichtigungen<small>Hinweis, wenn die App im Hintergrund ist</small></div>${notif}</div>
    <p class="note">Der Alarmton läuft über die Medienlautstärke; den Lautlos-Modus kann eine Web-App nicht übersteuern. Zuverlässig alarmiert die App nur im Vordergrund. Solange ein Trupp läuft, hält sie den Bildschirm an.</p>
  </div>
  <div class="card"><h3>Darstellung</h3>
    <div class="set-row"><div class="lbl2">Farbschema</div><div class="seg">${[['dark', 'Dunkel'], ['light', 'Hell']].map(([k, l]) => `<button data-act="set" data-k="theme" data-v="${k}" aria-pressed="${s.theme === k}" style="min-height:52px;padding:0 16px">${l}</button>`).join('')}</div></div>
  </div>
  <div class="card"><h3>App & Daten</h3>
    <div class="set-row"><div class="lbl2">Installation<small>${inst[0]}</small></div>${inst[1]}</div>
    <div class="set-row"><div class="lbl2">Offline-Betrieb<small>${swOk ? 'App ist vollständig auf dem Gerät' : 'wird beim ersten Laden eingerichtet'}</small></div>${swOk ? '<span class="badge b-green">✓ bereit</span>' : '<span class="badge b-grey">⏳</span>'}</div>
    <div class="set-row"><div class="lbl2">Datenspeicher<small>${store[0]}</small></div>${store[1]}</div>
    <div class="set-row"><div class="lbl2">Verlauf<small>${S.history.length} von 5 gespeichert</small></div><button class="btn btn-outline-danger" data-act="clearHistory" ${S.history.length ? '' : 'disabled'}>Löschen</button></div>
    <p class="note">Alle Daten bleiben auf diesem Gerät. Es gibt keinen Server und keine Übertragung, außer du teilst das Brett selbst.</p>
  </div>
  <div class="card"><h3>Info</h3>
    <p style="margin:0"><b>ASÜ-Timer ${APP_VERSION}</b> · Unterstützung der Atemschutzüberwachung nach FwDV 7</p>
    <p class="small muted" style="margin:0">Maßgeblich bleibt die Atemschutzüberwachungstafel. Die App ersetzt sie nicht.</p>
    <div class="lbl">Selbsttest Rechenkern: ${tests.filter(x => x.ok).length} von ${tests.length} bestanden</div>
    <ul class="tests">${tests.map(x => `<li>${x.ok ? '✅' : '❌'} ${esc(x.name)}</li>`).join('')}</ul>
  </div>`;
}

/* ==========================================================================
   PWA: Service Worker, Updates, Installation, dauerhafter Speicher
   ========================================================================== */
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); UI.installEvt = e; if ($('#view')) renderAll(); });
window.addEventListener('appinstalled', () => { UI.installEvt = null; toast('ASÜ-Timer wurde installiert'); if ($('#view')) renderAll(); });

function initSW() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    const track = w => { if (w) w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(reg); }); };
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg);
    reg.addEventListener('updatefound', () => track(reg.installing));
    setInterval(() => { reg.update().catch(() => {}); }, 60 * 60 * 1000);
  }).catch(() => { /* ohne Service Worker läuft die App online weiter */ });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (UI.updating && !reloading) { reloading = true; location.reload(); return; }
    if (UI.tab === 'einstellungen') renderAll();
  });
}
function showUpdate(reg) {
  UI.waitingSW = reg.waiting;
  const el = $('#upd'); if (!el) return;
  el.innerHTML = '<span>Neue Version verfügbar. Laufende Einsätze bleiben erhalten.</span><button data-act="update">Aktualisieren</button>';
  el.hidden = false;
}
function initPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persisted) return;
    navigator.storage.persisted().then(p => {
      UI.persisted = p;
      if (!p && navigator.storage.persist) return navigator.storage.persist().then(x => { UI.persisted = x; });
      return null;
    }).catch(() => {});
  } catch (e) { /* ignorieren */ }
}

/* ==========================================================================
   Aktions-Verteilung (ein Klick-Handler für alles mit data-act)
   ========================================================================== */
const ACT = {
  tab: b => { UI.tab = b.dataset.tab; renderAll(); },
  newMission: b => newMission(b.dataset.kind),
  editKeyword: () => keywordDialog(),
  endMission: () => endMissionDialog(),
  shareBoard: b => {
    const m = b.dataset.mid ? S.history.find(h => h.id === b.dataset.mid) : S.mission; if (!m) return;
    shareDialog('Brett teilen', `${m.kind === 'uebung' ? 'Übung' : 'Einsatz'}${m.keyword ? ' · ' + m.keyword : ''} · Vorschau`, boardText(m, Clock.now()));
  },
  addTrupp: () => truppForm({ mode: 'new' }),
  addST: () => truppForm({ mode: 'new', isST: true }),
  rename: b => renameDialog(b.dataset.tid),
  personName: b => personDialog(b.dataset.tid, Number(b.dataset.i)),
  editDevice: b => truppForm({ mode: 'edit', tid: b.dataset.tid }),
  start: b => startTrupp(b.dataset.tid),
  ziel: b => eventDialog(b.dataset.tid, 'ziel'),
  rueckzug: b => eventDialog(b.dataset.tid, 'rueckzug'),
  ende: b => eventDialog(b.dataset.tid, 'ende'),
  druck: b => eventDialog(b.dataset.tid, 'abfrage'),
  ack: b => ackAlarm(b.dataset.tid, b.dataset.key),
  alarmAck: b => ackAlarm(b.dataset.tid, b.dataset.key),
  detail: b => detailDialog(b.dataset.tid),
  corrTime: b => corrTime(b.dataset.tid, b.dataset.eid),
  corrP: b => corrPressure(b.dataset.tid, b.dataset.eid, Number(b.dataset.i)),
  delEvent: b => delEvent(b.dataset.tid, b.dataset.eid),
  removeTrupp: b => removeTrupp(b.dataset.tid),
  undo: () => undo(),
  histDetail: b => historyDialog(b.dataset.mid),
  step: b => {
    const k = b.dataset.k;
    const v = Math.min(Number(b.dataset.max), Math.max(Number(b.dataset.min), S.settings[k] + Number(b.dataset.d)));
    if (v !== S.settings[k]) act(`${SET_LABEL[k]}: ${v}`, () => { S.settings[k] = v; });
  },
  toggle: b => { const k = b.dataset.k; act(`${SET_LABEL[k]} ${S.settings[k] ? 'aus' : 'an'}`, () => { S.settings[k] = !S.settings[k]; }); },
  set: b => { const k = b.dataset.k, v = b.dataset.v; if (S.settings[k] !== v) act(`${SET_LABEL[k]} geändert`, () => { S.settings[k] = v; }); },
  sound: () => { Sound.unlock(); setTimeout(liveUpdate, 150); },
  testAlarm: () => {
    Sound.unlock(); setTimeout(() => Sound.beep(), 150);
    try { if (navigator.vibrate) navigator.vibrate([300, 120, 300]); } catch (e) { /* keine Vibration */ }
    toast('Testalarm: Ton und Vibration ausgelöst');
  },
  notify: () => { try { Promise.resolve(Notification.requestPermission()).then(() => renderAll()).catch(() => {}); } catch (e) { /* nicht verfügbar */ } },
  install: async () => { const e = UI.installEvt; if (!e) return; UI.installEvt = null; try { e.prompt(); await e.userChoice; } catch (x) { /* abgebrochen */ } renderAll(); },
  update: () => { UI.updating = true; saveState(); if (UI.waitingSW) UI.waitingSW.postMessage('skipWaiting'); else location.reload(); },
  clearHistory: () => confirmDialog({
    title: 'Verlauf löschen?', html: `<p style="margin:0">${S.history.length} beendete Einsätze/Übungen werden von diesem Gerät gelöscht. Der laufende Einsatz bleibt erhalten.</p>`,
    yes: 'Löschen', danger: true, onYes: () => act('Verlauf gelöscht', () => { S.history = []; })
  })
};

/* ==========================================================================
   Start
   ========================================================================== */
function init() {
  UI.storageOk = Store.available();
  applyTheme();
  const app = $('#app');
  app.addEventListener('click', e => {
    if (!S) return;
    const b = e.target.closest('[data-act]');
    if (!b || !app.contains(b) || b.disabled) return;
    const f = ACT[b.dataset.act]; if (f) { e.preventDefault(); f(b, e); }
  });
  document.addEventListener('pointerdown', () => Sound.unlock(), true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && UI.modals.length) closeModal(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') liveUpdate(); });
  // Zweites Fenster/Tab: Daten synchron halten
  window.addEventListener('storage', e => {
    if (e.key !== STORE_PREFIX + 'state' && e.key !== STORE_PREFIX + 'settings') return;
    S = loadState(); UI.undo = null; hideUndo(); UI.alarmKey = null; applyTheme(); renderAll();
  });
  buildShell();
  renderAll();
  if (!UI.storageOk) toast('⚠ Speicher nicht verfügbar – Daten bleiben nur bis zum Schließen erhalten');
  initSW();
  initPersist();
  setInterval(liveUpdate, 250);
}
document.addEventListener('DOMContentLoaded', init);
