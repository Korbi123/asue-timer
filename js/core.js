'use strict';
/* ==========================================================================
   ASÜ-Timer – Rechenkern (reine Funktionen, kein DOM)
   Gespeichert werden nur Rohdaten (Zeitstempel, Drücke, Gerät, Namen).
   Alle abgeleiteten Werte werden bei jeder Anzeige neu berechnet.
   ========================================================================== */

const APP_VERSION = '1.0.0';   // bei jeder Änderung auch VERSION in sw.js erhöhen
const MIN = 60000;

/* Zentrale Uhr: alle Zeitlogik nutzt dieselbe Quelle */
const Clock = { now: () => Date.now() };

/* ---------- Formatierung ---------- */
const pad2 = n => String(n).padStart(2, '0');
function fmtHM(t) { const d = new Date(t); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
function fmtHMS(t) { const d = new Date(t); return fmtHM(t) + ':' + pad2(d.getSeconds()); }
function fmtDate(t) { const d = new Date(t); return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear(); }
function fmtDur(ms) {
  const s = Math.floor(Math.abs(ms) / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return h ? h + ':' + pad2(m) + ':' + pad2(x) : pad2(m) + ':' + pad2(x);
}
function fmtNum(n, d = 0) { return Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d }); }

/* ---------- Geräteliste – V = Volumen gesamt in l, p = Nenndruck in bar ---------- */
const DEVICES = [
  { key: '2x4-200', label: '2 × 4 l / 200 bar', short: '2x4l/200', V: 8, p: 200 },
  { key: '6-300st', label: '6 l / 300 bar Stahl', short: '6l/300St', V: 6, p: 300 },
  { key: '68-300', label: '6,8 l / 300 bar CFK', short: '6,8l/300', V: 6.8, p: 300 },
  { key: '9-300', label: '9 l / 300 bar CFK', short: '9l/300', V: 9, p: 300 },
  { key: 'lz-2x68', label: 'Langzeit-PA 2 × 6,8 l / 300 bar', short: 'LZ2x6,8l', V: 13.6, p: 300 },
  { key: 'custom', label: 'Eigene Eingabe', short: 'eigen', V: null, p: null }
];

/* ---------- Ereignisse ----------
   anlegen  = Gerät angelegt (z. B. im Fahrzeug), Anfangsdruck
   start    = Anschluss / Losgehen, Druck optional
   abfrage, ziel, rueckzug, ende */
const EV_ORDER = { anlegen: -1, start: 0, abfrage: 1, ziel: 2, rueckzug: 3, ende: 4 };
const EV_LABEL = { anlegen: 'Anlegen', start: 'Start (Anschluss)', abfrage: 'Druckabfrage', ziel: 'Ziel erreicht', rueckzug: 'Rückzug', ende: 'Ende' };
function evLabel(e) {
  if (e.type === 'abfrage') return e.tag === '1/3' ? '⅓-Abfrage' : e.tag === '2/3' ? '⅔-Abfrage' : 'Druckabfrage';
  return EV_LABEL[e.type];
}

/* ---------- Standard-Einstellungen ---------- */
const DEFAULTS = {
  consumption: 50,      // Standardverbrauch l/min
  warn: 55,             // Warnsignal-Schwelle bar
  thirdRule: true,      // Drittel-Regel an
  prewarn: 3,           // Vorwarnzeit min
  consThreshold: 80,    // Verbrauchs-Schwelle l/min
  defaultMode: 'fix',   // Standard-Zeitmodus
  defaultFix: 30,       // fester Standardwert min
  theme: 'dark'
};

/* ==========================================================================
   Rechenfunktionen
   ========================================================================== */
const Calc = {
  /* Atemluftmenge in Litern: V × p × 0,9 bei p > 200 bar, sonst V × p */
  capacity(V, p) {
    if (!(V > 0) || !(p > 0)) return 0;
    return p > 200 ? V * p * 0.9 : V * p;
  },

  /* Gerätedaten inkl. Liter pro bar */
  device(dev) {
    const base = DEVICES.find(d => d.key === (dev && dev.key)) || DEVICES[2];
    const custom = base.key === 'custom';
    const V = custom ? Number(dev.V) : base.V;
    const p = custom ? Number(dev.p) : base.p;
    const cap = Calc.capacity(V, p);
    const label = custom ? `Eigen: ${fmtNum(V || 0, 1)} l / ${p || 0} bar` : base.label;
    const short = custom ? `${fmtNum(V || 0, 1)}l/${p || 0}` : base.short;
    return { key: base.key, V, p, cap, lpb: p > 0 ? cap / p : 0, label, short };
  },

  sorted(events) { return events.slice().sort((a, b) => a.t - b.t || EV_ORDER[a.type] - EV_ORDER[b.type]); },
  startEv(t) { return t.events.find(e => e.type === 'start') || null; },
  anlegeEv(t) { return t.events.find(e => e.type === 'anlegen') || null; },
  firstEv(t, type) { return t.events.find(e => e.type === type) || null; },

  /* Maßgeblicher Startdruck je Person: Druck beim Anschluss, sonst Druck beim Anlegen */
  startPressure(t, i) {
    const st = Calc.startEv(t), an = Calc.anlegeEv(t);
    if (st && st.p[i] != null) return { p: st.p[i], ev: st, src: 'anschluss' };
    if (an && an.p[i] != null) return { p: an.p[i], ev: an, src: 'anlegen' };
    return { p: null, ev: st || an, src: null };
  },

  /* Status nur aus Rohdaten ableiten */
  status(t) {
    if (t.events.some(e => e.type === 'ende')) return 'beendet';
    if (Calc.startEv(t)) return 'laeuft';
    return t.isST ? 'bereit' : 'angelegt';
  },

  /* Erwartete Einsatzzeit in ganzen Minuten, abgerundet */
  expected(t, s) {
    const d = Calc.device(t.device);
    const floor = x => Math.floor(x + 1e-9);
    if (t.mode === 'fix') {
      const m = floor(Number(t.fixMin) || 0);
      return { min: m, raw: m, label: 'fester Wert', text: `fester Wert ${m} min` };
    }
    if (t.mode === 'geraet') {
      const raw = d.cap / s.consumption;
      return { min: floor(raw), raw, label: 'nach Gerät', text: `${fmtNum(d.cap)} l ÷ ${s.consumption} l/min = ${fmtNum(raw, 1)} min` };
    }
    // aus Startdruck: niedrigerer Startdruck von TF/TM
    const ps = [0, 1].map(i => Calc.startPressure(t, i).p).filter(x => x != null);
    if (!ps.length) {
      const raw = d.cap / s.consumption;
      return { min: floor(raw), raw, label: 'aus Startdruck', fallback: true, text: `Anfangsdruck fehlt – Nenndruck ${d.p} bar angenommen: ${fmtNum(raw, 1)} min` };
    }
    const pmin = Math.min(...ps);
    const raw = pmin * d.lpb / s.consumption;
    return { min: floor(raw), raw, label: 'aus Startdruck', text: `${pmin} bar × ${fmtNum(d.lpb, 2)} l/bar ÷ ${s.consumption} l/min = ${fmtNum(raw, 1)} min` };
  },

  /* ⅓-, ⅔- und Endzeitpunkt ab Anschluss */
  milestones(t, s) {
    const ex = Calc.expected(t, s);
    const st = Calc.startEv(t);
    if (!st) return { ex, start: null };
    const T = ex.min * MIN;
    return { ex, start: st.t, t13: st.t + T / 3, t23: st.t + 2 * T / 3, tEnd: st.t + T };
  },

  /* Rückzugsdruck pro Person */
  retreat(startP, zielP, s) {
    if (startP == null) return { value: null, rule: 'none', short: '–', text: 'Startdruck fehlt' };
    if (zielP != null) {
      const twice = 2 * (startP - zielP);
      const v = Math.max(twice, s.warn);
      return { value: v, rule: 'ziel', short: 'Ziel-Regel', text: `Ziel-Regel: max(2 × (${startP} − ${zielP}), ${s.warn}) = ${v} bar` };
    }
    if (s.thirdRule) {
      const v = startP - (startP - s.warn) / 3;
      return { value: v, rule: 'drittel', short: 'Drittel-Regel', text: `Drittel-Regel: ${startP} − (${startP} − ${s.warn}) ÷ 3 ≈ ${Math.round(v)} bar` };
    }
    return { value: null, rule: 'keine', short: 'keine Regel', text: 'Kein Rückzugsdruck (Drittel-Regel aus, kein Ziel erfasst) – nur Warnsignal-Prognose' };
  },

  /* Verbrauch, Prognose und Rückzugsdruck für Person i */
  person(t, i, s, now) {
    const d = Calc.device(t.device);
    const st = Calc.startEv(t);
    const sp = Calc.startPressure(t, i);
    const out = { i, role: t.persons[i].role, name: t.persons[i].name, nominal: d.p, sp, startP: sp.p };
    if (sp.p == null) { out.noStart = true; return out; }
    out.lowStart = d.p > 0 && sp.p < 0.9 * d.p;
    if (!st) { out.notStarted = true; return out; }
    const startP = sp.p;
    // Messwerte ab Anschluss (ohne Anlegen und ohne den Startdruck selbst)
    const readings = Calc.sorted(t.events).filter(e => e.type !== 'anlegen' && e !== st && e.p[i] != null && e.t >= st.t);
    const last = readings.length ? readings[readings.length - 1] : null;
    const ziel = Calc.firstEv(t, 'ziel');
    const rt = Calc.retreat(startP, ziel ? ziel.p[i] : null, s);

    // Verbrauch: vor der ersten Abfrage Standardverbrauch, danach gemessen seit Anschluss
    const stdBar = s.consumption / d.lpb;
    let barMin = stdBar, basis = 'standard', note = 'Standardverbrauch';
    if (last) {
      const mins = (last.t - st.t) / MIN;
      const used = startP - last.p[i];
      if (mins >= 0.2 && used > 0) { barMin = used / mins; basis = 'gemessen'; note = 'gemessen seit Anschluss'; }
      else note = used <= 0 ? 'kein Druckabfall – Standardverbrauch' : 'Abstand zu kurz – Standardverbrauch';
    }
    const lMin = barMin * d.lpb;

    // Prognose ab letztem gemeldetem Druck (oder Startdruck zum Anschlusszeitpunkt)
    const ref = last ? { t: last.t, p: last.p[i], ev: last } : { t: st.t, p: startP, ev: sp.ev };
    const refEnd = Calc.firstEv(t, 'ende');
    const at = refEnd ? Math.min(now, refEnd.t) : now;
    const est = Math.max(0, ref.p - barMin * Math.max(0, at - ref.t) / MIN);
    const tRP = rt.value == null ? null : (ref.p > rt.value ? ref.t + (ref.p - rt.value) / barMin * MIN : ref.t);
    const tWS = ref.p > s.warn ? ref.t + (ref.p - s.warn) / barMin * MIN : ref.t;
    const rpReached = rt.value != null && ref.p <= rt.value;

    return Object.assign(out, {
      startEv: st, last, ref, rt, barMin, lMin, basis, note, est, tRP, tWS, rpReached,
      // früheste noch offene Prognose: Rückzugsdruck, nach Erreichen das Warnsignal
      crit: (tRP != null && !rpReached) ? Math.min(tRP, tWS) : tWS
    });
  },

  /* Warnstufen – nur für laufende Trupps */
  warnings(t, s, now, persons) {
    const W = [];
    const pre = s.prewarn * MIN;
    persons.forEach(p => {
      if (p.noStart || p.notStarted) return;
      if (p.lowStart) W.push({ lvl: 'yellow', code: 'startlow', i: p.i, text: `Startdruck ${p.role} ${p.startP} bar < 90 % von ${p.nominal} bar` });
      if (p.rpReached) W.push({ lvl: 'red', code: 'rp', i: p.i, alarm: true, since: p.ref.t, text: `Rückzugsdruck erreicht: ${p.role} ${p.ref.p} ≤ ${Math.round(p.rt.value)} bar` });
      else if (p.tRP != null && p.tRP - now <= pre) W.push({ lvl: 'orange', code: 'rpsoon', i: p.i, text: `Rückzugsdruck ${p.role} ca. ${fmtHM(p.tRP)}` });
      if (p.tWS - now <= pre) W.push({ lvl: 'red', code: 'ws', i: p.i, alarm: true, since: p.tWS - pre, text: `Warnsignal ${p.role} ca. ${fmtHM(p.tWS)}` });
      if (p.basis === 'gemessen' && p.lMin > s.consThreshold) W.push({ lvl: 'orange', code: 'cons', i: p.i, text: `Verbrauch ${p.role} ${Math.round(p.lMin)} l/min > ${s.consThreshold}` });
    });
    return W;
  },

  /* Plausibilität: höher als vorher, > Nenndruck + 10 %, Zeitreihenfolge */
  plausibility(t) {
    const d = Calc.device(t.device);
    const st = Calc.startEv(t), an = Calc.anlegeEv(t);
    const evs = Calc.sorted(t.events);
    const out = [];
    for (let i = 0; i < 2; i++) {
      let prev = null;
      const role = t.persons[i].role;
      evs.forEach(e => {
        const p = e.p[i];
        if (p == null) return;
        if (d.p > 0 && p > d.p * 1.1) out.push({ key: `${e.id}|${i}|max`, ev: e.id, i, text: `${evLabel(e)}: ${role} ${p} bar liegt über Nenndruck + 10 % (${Math.round(d.p * 1.1)} bar)` });
        // Der Anschlussdruck ersetzt den Anlegedruck (z. B. nach Flaschenwechsel) – kein Vergleich damit
        if (prev != null && p > prev && e.type !== 'start') out.push({ key: `${e.id}|${i}|up`, ev: e.id, i, text: `${evLabel(e)}: ${role} ${p} bar ist höher als der vorherige Wert (${prev} bar)` });
        prev = p;
      });
    }
    if (st) {
      evs.forEach(e => {
        if (e.type !== 'anlegen' && e !== st && e.t < st.t) out.push({ key: `${e.id}|t|before`, ev: e.id, i: null, text: `${evLabel(e)} um ${fmtHM(e.t)} liegt vor dem Start (${fmtHM(st.t)})` });
      });
      if (an && an.t > st.t) out.push({ key: `${an.id}|t|after`, ev: an.id, i: null, text: `Anlegen um ${fmtHM(an.t)} liegt nach dem Start (${fmtHM(st.t)})` });
    }
    return out;
  },

  /* Gesamtauswertung eines Trupps */
  analyze(t, s, now) {
    const status = Calc.status(t);
    const ms = Calc.milestones(t, s);
    const persons = [0, 1].map(i => Calc.person(t, i, s, now));
    let lead = null;
    persons.forEach(p => { if (p.crit != null && (lead == null || p.crit < persons[lead].crit)) lead = p.i; });
    const end = Calc.firstEv(t, 'ende');
    const refNow = end ? end.t : now;
    const elapsed = ms.start != null ? refNow - ms.start : 0;
    const over = ms.start != null ? refNow - ms.tEnd : -Infinity;
    let warnings = [];
    if (status === 'laeuft') warnings = Calc.warnings(t, s, now, persons);
    else if (status === 'angelegt' || status === 'bereit') {
      persons.forEach(p => { if (p.lowStart) warnings.push({ lvl: 'yellow', code: 'startlow', i: p.i, text: `Anfangsdruck ${p.role} ${p.startP} bar < 90 % von ${p.nominal} bar` }); });
    }
    const issues = Calc.plausibility(t);
    return { status, ms, persons, lead, elapsed, over, warnings, issues, end, device: Calc.device(t.device) };
  },

  /* Aktive (nicht quittierte) Alarme eines Trupps */
  alarms(t, a, now) {
    if (a.status !== 'laeuft') return [];
    const ack = t.acks || {};
    const ms = a.ms;
    const L = [];
    if (now >= ms.t13 && !ack.t13) L.push({ key: 't13', since: ms.t13, title: '⅓ der Einsatzzeit erreicht', text: 'Druckabfrage bei TF und TM durchführen', ackLabel: 'Druckabfrage erfolgt' });
    if (now >= ms.t23 && !ack.t23) L.push({ key: 't23', since: ms.t23, title: '⅔ der Einsatzzeit erreicht', text: 'Druckabfrage bei TF und TM durchführen', ackLabel: 'Druckabfrage erfolgt' });
    if (now >= ms.tEnd && !ack.end) L.push({ key: 'end', since: ms.tEnd, title: 'Erwartete Einsatzzeit abgelaufen', text: 'Trupp ist in Überzeit – Rückzug prüfen', ackLabel: 'Quittieren' });
    a.warnings.filter(w => w.alarm).forEach(w => {
      const key = w.code + w.i;
      if (!ack[key]) L.push({ key, since: w.since, title: w.code === 'rp' ? 'Rückzugsdruck erreicht' : 'Warnsignal in Kürze', text: w.text, ackLabel: 'Quittieren' });
    });
    return L.map(x => Object.assign(x, { tid: t.id }));
  }
};

/* ==========================================================================
   Datenmodell (nur Rohdaten)
   ========================================================================== */
let _uid = 0;
function uid(p) { return p + Math.random().toString(36).slice(2, 7) + (++_uid).toString(36) + Date.now().toString(36).slice(-3); }

function mkEvent(type, t, p, extra) {
  return Object.assign({ id: uid('e'), type, t, tag: null, p: p ? p.slice() : [null, null], corr: { t: false, p: [false, false] } }, extra || {});
}

function mkTrupp(o) {
  return {
    id: uid('t'), name: o.name, isST: !!o.isST, created: o.created,
    persons: [{ role: 'TF', name: o.tf || 'TF' }, { role: 'TM', name: o.tm || 'TM' }],
    device: Object.assign({ key: '68-300', V: null, p: null }, o.device || {}),
    mode: o.mode || 'fix', fixMin: o.fixMin || 30,
    events: [], acks: {},
    corr: { name: false, persons: [false, false], device: false, mode: false }
  };
}

/* Reihenfolge: feste Anlage-Reihenfolge, abgeschlossene Trupps am Ende */
function orderedTrupps(m) {
  const by = (a, b) => a.created - b.created;
  const act = m.trupps.filter(t => Calc.status(t) !== 'beendet').sort(by);
  const done = m.trupps.filter(t => Calc.status(t) === 'beendet').sort(by);
  return act.concat(done);
}

/* ==========================================================================
   Selbsttest des Rechenkerns
   ========================================================================== */
function selfTest() {
  const s = Object.assign({}, DEFAULTS);
  const P = [{ role: 'TF' }, { role: 'TM' }];
  const nur = { mode: 'druck', device: { key: '68-300' }, persons: P, events: [{ type: 'anlegen', t: 0, p: [300, 300] }, { type: 'start', t: 60000, p: [null, null] }] };
  const beide = { mode: 'druck', device: { key: '68-300' }, persons: P, events: [{ type: 'anlegen', t: 0, p: [300, 300] }, { type: 'start', t: 60000, p: [280, null] }] };
  const caps = DEVICES.filter(d => d.key !== 'custom').map(d => Math.round(Calc.capacity(d.V, d.p)));
  return [
    { name: '6,8 l/300 bar, Anfangsdruck 300 bar, 50 l/min → 36 min', ok: Calc.expected(nur, s).min === 36 },
    { name: 'Anschlussdruck geht vor Anlegedruck (280 statt 300 bar)', ok: Calc.startPressure(beide, 0).p === 280 && Calc.startPressure(beide, 1).p === 300 },
    { name: 'Drittel-Regel: Start 300, Warnsignal 55 → ≈ 218 bar', ok: Math.round(Calc.retreat(300, null, s).value) === 218 },
    { name: 'Ziel bei 260 bar (Start 300) → Rückzugsdruck 80 bar', ok: Calc.retreat(300, 260, s).value === 80 },
    { name: 'Geräteliste: 1600 / 1620 / 1836 / 2430 / 3672 l', ok: caps.join('/') === '1600/1620/1836/2430/3672' }
  ];
}

if (typeof module !== 'undefined' && module.exports) module.exports = { Calc, DEVICES, DEFAULTS, selfTest, mkTrupp, mkEvent, orderedTrupps, Clock, MIN, APP_VERSION };
