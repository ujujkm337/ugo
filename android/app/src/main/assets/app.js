/* ══════════════════════════════════════════════════════════════
   УГО / ЕСКД — приложение
     • «Учить»       — Duolingo-подобный тренажёр с интервальными
                       повторениями (SM-2), сериями и жизнями
     • «Собирать»    — редактор схем на SVG + расчёт через circuit.js
     • «Справочник»  — 52 символа ЕСКД с поиском
   ══════════════════════════════════════════════════════════════ */
'use strict';

/* ── Мелкие утилиты ─────────────────────────────────────────── */
const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const pick  = a => a[Math.floor(Math.random() * a.length)];
const esc   = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const DAY = 86400000;
const dayOf = ts => Math.floor(ts / DAY);

let toastT = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, 2100);
}

const GCOL = Object.fromEntries([...GROUPS, ...PLAN_GROUPS].map(g => [g.id, g.color]));

/*  Два стандарта: ЕСКД 2.7xx (векторные УГО схем) и ГОСТ 21.210-2014
    (вырезки из скана — обозначения на планах). У каждого раздела свой
    текущий стандарт, прогресс обучения общий: id у наборов не пересекаются. */
const STD = { learn: 'escd', ref: 'escd' };
const setOf    = k => STD[k] === 'plan' ? PLAN_SYMBOLS : ALL_SYMBOLS;
const groupsOf = k => STD[k] === 'plan' ? PLAN_GROUPS  : GROUPS;
const symById  = id => ALL_SYMBOLS.find(s => s.id === id) || PLAN_SYMBOLS.find(s => s.id === id);
const groupColorOfSym = sym => GCOL[sym.gid] || '#6f93b0';

/** ЕСКД рисуется вектором, планы — вырезкой из оригинала ГОСТ. */
function symHTML(s, cls) {
  if (s.img) return `<img class="symimg ${cls || ''}" src="${esc(s.img)}" alt="${esc(s.name)}" loading="lazy">`;
  return svgOf(s);
}

/* ═══════════════════ СОСТОЯНИЕ ═══════════════════ */
const LS = 'ugo.v1';
const GOAL = 20;                 // дневная цель, карточек
const MAXHP = 5;
const HPTIME = 20 * 60000;       // жизнь восстанавливается за 20 минут

let ST = loadState();

function loadState() {
  const blank = { cards: {}, xp: 0, streak: 0, lastDay: null, hp: MAXHP, hpAt: Date.now(), today: null, todayN: 0, board: null };
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return blank;
    return Object.assign(blank, JSON.parse(raw));
  } catch (e) { return blank; }
}
function save() {
  try { localStorage.setItem(LS, JSON.stringify(ST)); } catch (e) { /* приватный режим — просто работаем дальше */ }
}

/** Обновляет серию дней и дневную цель. Возвращает true, если это первый урок сегодня. */
function touchDay() {
  const d = dayOf(Date.now());
  if (ST.lastDay === null) { ST.lastDay = d; ST.streak = 1; }
  else if (d > ST.lastDay) { ST.streak = (d - ST.lastDay === 1) ? ST.streak + 1 : 1; ST.lastDay = d; }
  if (ST.today !== d) { ST.today = d; ST.todayN = 0; }
  ST.todayN++;
}
function regenHP() {
  if (ST.hp >= MAXHP) { ST.hpAt = Date.now(); return; }
  const add = Math.floor((Date.now() - (ST.hpAt || 0)) / HPTIME);
  if (add > 0) { ST.hp = Math.min(MAXHP, ST.hp + add); ST.hpAt = ST.hpAt + add * HPTIME; }
  if (ST.hp >= MAXHP) ST.hpAt = Date.now();
}

/* ── Интервальные повторения (SM-2 в днях) ──────────────────── */
function card(id) {
  if (!ST.cards[id]) ST.cards[id] = { reps: 0, ef: 2.5, iv: 0, due: 0, ok: 0, bad: 0 };
  return ST.cards[id];
}
function schedule(c, ok) {
  if (!ok) {
    c.iv = 0; c.bad++;
    c.ef = Math.max(1.3, (c.ef || 2.5) - 0.2);
    c.due = Date.now();                       // сразу в повтор
  } else {
    c.ok++;
    c.ef = clamp((c.ef || 2.5) + 0.1 - 0.0, 1.3, 2.8);
    c.reps = (c.reps || 0) + 1;
    c.iv = c.reps === 1 ? 1 / 48            // 30 минут
         : c.reps === 2 ? 1 / 5             // ~5 часов
         : Math.min(45, (c.iv || 0.2) * c.ef);
    c.due = Date.now() + c.iv * DAY;
  }
}
const dueList = ids => ids.filter(id => card(id).due <= Date.now());
function weakList() {
  return setOf('learn')
    .map(s => ({ s, c: card(s.id) }))
    .filter(x => x.c.bad > 0 || x.c.reps > 0)
    .sort((a, b) => (b.c.bad / Math.max(1, b.c.ok + b.c.bad)) - (a.c.bad / Math.max(1, a.c.ok + a.c.bad)))
    .slice(0, 12).map(x => x.s);
}

/* ═══════════════════ НАВИГАЦИЯ ═══════════════════ */
function go(tab) {
  $$('.tab').forEach(t => { t.hidden = t.id !== 't-' + tab; });
  $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  if (tab === 'build') requestAnimationFrame(fitIfNeeded);
}
$$('#tabbar button').forEach(b => b.onclick = () => go(b.dataset.tab));

/* ══════════════════════════════════════════════════════════════
   1. УЧИТЬ
   ══════════════════════════════════════════════════════════════ */

let RUN = null;   // активный урок

function renderHome() {
  regenHP();
  $('#std-badge').textContent = STD.learn === 'plan' ? 'ГОСТ 21.210' : 'ЕСКД 2.7xx';
  $('#s-xp').textContent = ST.xp;
  $('#s-streak').textContent = ST.streak;
  $('#s-hp').textContent = ST.hp;

  const d = dayOf(Date.now());
  const n = ST.today === d ? ST.todayN : 0;
  const pct = Math.min(1, n / GOAL);
  $('#goalarc').setAttribute('stroke-dashoffset', String(138.2 * (1 - pct)));
  $('#goaltxt').textContent = n + '/' + GOAL;
  $('#goaltitle').textContent = n >= GOAL ? 'Цель выполнена' : 'Дневная цель';
  $('#goalsub').textContent = n >= GOAL
    ? 'Можно остановиться — серия сохранена.'
    : (ST.streak > 1 ? `Серия ${ST.streak} дн. — не потеряй её.` : 'Пройди урок, чтобы начать серию.');

  // слабые места
  const w = weakList();
  const wb = $('#weakbox');
  wb.innerHTML = w.length >= 3 ? `
    <button class="weak" id="btn-weak">
      <span style="font-size:19px">↻</span>
      <span style="flex:1 1 auto;min-width:0">
        <b>Повторить слабое</b><br><span>${w.length} символов, в которых были ошибки</span>
      </span>
    </button>` : '';
  if (w.length >= 3) $('#btn-weak').onclick = () => startRun(w.map(s => s.id), 'Повторение');

  // разделы
  const GS = groupsOf('learn');
  $('#units').innerHTML = GS.map(g => {
    const ids = g.items.map(s => s.id);
    const done = ids.filter(id => card(id).reps > 0).length;
    const p = Math.round(done / ids.length * 100);
    return `<button class="unit" data-g="${g.id}" style="--uc:${g.color}">
      <span class="ico">${symHTML(g.items[0])}</span>
      <span class="u"><b>${esc(g.name)}</b><span>${done} из ${ids.length} · ${g.items.length} символов</span></span>
      <span class="pct">${p}%</span>
    </button>`;
  }).join('');
  $$('#units .unit').forEach(b => b.onclick = () => {
    const g = groupsOf('learn').find(x => x.id === b.dataset.g);
    startRun(g.items.map(s => s.id), g.name);
  });

  $('#btn-mixed').onclick = () => startRun(null, 'Смешанный урок');
  $('#btn-reset').onclick = () => {
    if (!confirm('Сбросить весь прогресс обучения? Действие необратимо.')) return;
    ST = { cards: {}, xp: 0, streak: 0, lastDay: null, hp: MAXHP, hpAt: Date.now(), today: null, todayN: 0, board: ST.board };
    save(); renderHome(); toast('Прогресс сброшен');
  };
}

/** Формирует урок: сначала просроченные, потом новые, потом остальные. */
function buildQueue(ids) {
  const pool = ids ? ids.slice() : setOf('learn').map(s => s.id);
  const now = Date.now();
  const scored = pool.map(id => {
    const c = card(id);
    return { id, due: c.due || 0, reps: c.reps || 0, bad: c.bad || 0 };
  });
  const due = scored.filter(x => x.due <= now).sort((a, b) => a.due - b.due);
  const fresh = shuffle(scored.filter(x => x.due > now && x.reps === 0));
  const rest = shuffle(scored.filter(x => x.due > now && x.reps > 0));
  return [...due, ...fresh, ...rest].slice(0, 10);
}

function startRun(ids, title) {
  if (ST.hp <= 0) { toast('Жизни закончились — подожди восстановления'); return; }
  const q = buildQueue(ids);
  if (!q.length) { toast('В этом разделе нечего учить'); return; }
  RUN = { title, queue: q, i: 0, right: 0, wrong: 0, locked: false, q: null };
  $('#learn-home').hidden = true;
  $('#learn-done').hidden = true;
  $('#learn-run').hidden = false;
  $('#btn-quit').onclick = () => { $('#learn-run').hidden = true; $('#learn-home').hidden = false; RUN = null; renderHome(); };
  nextQ();
}

/** Выбор формы вопроса: чем лучше卡片 усвоена, тем хитрее вопрос. */
function pickType(id) {
  const c = card(id);
  const s = symById(id);
  const r = Math.random();
  if ((c.reps || 0) === 0) return r < 0.5 ? 's2n' : 'n2s';
  const hasSi = !!(s.si && s.si.trim());
  if (r < 0.3) return 's2n';
  if (r < 0.55) return 'n2s';
  if (r < 0.8) return 'd2s';
  return hasSi ? 'c2s' : 'd2s';
}

/** Черты вариантов ответа: приоритет — символы того же раздела. */
function distractors(s, n) {
  const pool = setOf('learn');
  const same = shuffle(pool.filter(x => x.id !== s.id && x.gid === s.gid));
  const other = shuffle(pool.filter(x => x.id !== s.id && x.gid !== s.gid));
  const out = same.slice(0, n);
  let i = 0;
  while (out.length < n && i < other.length) out.push(other[i++]);
  return out;
}

function nextQ() {
  if (RUN.i >= RUN.queue.length) return finishRun();
  if (ST.hp <= 0) return finishRun(true);

  const id = RUN.queue[RUN.i].id;
  const sym = symById(id);
  const type = pickType(id);
  const opts = shuffle([sym, ...distractors(sym, 3)]);
  RUN.q = { sym, type, opts, answered: false };

  const L = { s2n: 'Что это за элемент?', n2s: 'Найди обозначение', d2s: 'О каком элементе речь?', c2s: 'Какой символ имеет этот код?' }[type];
  let big;
  if (type === 's2n') big = `<div class="bigsym" style="color:${groupColorOfSym(sym)}">${symHTML(sym)}</div>`;
  else if (type === 'n2s') big = `<div class="big">${esc(sym.name)}</div>`;
  else if (type === 'd2s') big = `<div class="desc">${esc(sym.desc)}</div>`;
  else big = `<div class="big" style="letter-spacing:2px">${esc(sym.si)}</div>`;

  const optHtml = opts.map((o, i) => {
    const showSym = type !== 's2n';
    const inner = showSym
      ? `<span class="v" style="color:${groupColorOfSym(o)}">${symHTML(o)}</span>`
      : `<span class="v">${esc(o.name)}</span>`;
    return `<button class="opt" data-i="${i}"><span class="k">${i + 1}</span>${inner}</button>`;
  }).join('');

  $('#qnum').textContent = (RUN.i + 1) + '/' + RUN.queue.length;
  $('#barfill').style.width = (RUN.i / RUN.queue.length * 100) + '%';
  $('#barfill').classList.remove('bad');
  $('#qwrap').innerHTML = `<div class="qprompt"><div class="lbl">${L}</div>${big}</div><div class="opts">${optHtml}</div>`;
  $('#fb').hidden = true;
  $$('#qwrap .opt').forEach(b => b.onclick = () => answer(+b.dataset.i));
}

function answer(i) {
  if (!RUN || RUN.q.answered) return;
  RUN.q.answered = true;
  const { sym, type, opts } = RUN.q;
  const right = opts[i].id === sym.id;

  $$('#qwrap .opt').forEach((b, k) => {
    b.disabled = true;
    if (opts[k].id === sym.id) b.classList.add('right');
    else if (k === i) b.classList.add('wrong');
    else b.classList.add('dim');
  });

  const c = card(sym.id);
  schedule(c, right);
  if (right) { RUN.right++; ST.xp += 10; }
  else {
    RUN.wrong++; ST.hp = Math.max(0, ST.hp - 1);
    c.due = Date.now();                       // ошибочное — сразу в конец очереди сегодня
    RUN.queue.push({ id: sym.id });           // и вернётся в этом же уроке
  }

  const fb = $('#fb');
  fb.hidden = false;
  fb.className = right ? 'ok' : 'no';
  fb.innerHTML = `
    <div class="fbrow">
      <span class="mk">${right ? '✓' : '✕'}</span>
      <span class="t">
        <b>${right ? 'Верно' : 'Неверно'}</b>
        <span><em>${esc(sym.name)}</em> — ${esc(sym.desc)}</span>
        ${sym.si ? `<span style="margin-top:4px">Буквенный код: <em>${esc(sym.si)}</em>${sym.unit ? ' · единица: ' + esc(sym.unit) : ''}</span>` : ''}
      </span>
    </div>
    <button class="btn" id="btn-next">${RUN.i + 1 >= RUN.queue.length ? 'Завершить' : 'Далее'}</button>`;
  $('#btn-next').onclick = () => { RUN.i++; nextQ(); };

  $('#s-xp').textContent = ST.xp;
  $('#s-hp').textContent = ST.hp;
  if (!right) $('#barfill').classList.add('bad');
  save();
}

function finishRun(dead) {
  touchDay();
  const total = RUN.right + RUN.wrong;
  const acc = total ? Math.round(RUN.right / total * 100) : 0;
  const perfect = RUN.wrong === 0;
  if (perfect) ST.xp += 25;

  const hp = ST.hp;
  $('#learn-run').hidden = true;
  $('#learn-done').hidden = false;
  $('#learn-done').innerHTML = `
    <div class="done">
      <div class="em">${dead ? '☁' : perfect ? '★' : acc >= 70 ? '✓' : '◐'}</div>
      <h2>${dead ? 'Жизни закончились' : perfect ? 'Идеально!' : 'Урок пройден'}</h2>
      <p class="sub">${esc(RUN.title)} · серия ${ST.streak} дн.</p>
      <div class="donestats">
        <div class="g"><b>${acc}%</b><span>точность</span></div>
        <div class="b"><b>${RUN.wrong}</b><span>ошибок</span></div>
        <div class="p"><b>+${ST.xp}</b><span>опыта</span></div>
      </div>
      <button class="btn" id="btn-again">${dead && hp <= 0 ? 'Вернуться' : 'Ещё урок'}</button>
      <button class="btn ghost" id="btn-home" style="margin-top:9px">К разделам</button>
    </div>`;
  $('#btn-again').onclick = () => {
    $('#learn-done').hidden = true;
    if (dead && ST.hp <= 0) { $('#learn-home').hidden = false; RUN = null; renderHome(); }
    else startRun(RUN.queue.length ? RUN.queue.map(q => q.id) : null, RUN.title);
  };
  $('#btn-home').onclick = () => { $('#learn-done').hidden = true; $('#learn-home').hidden = false; RUN = null; renderHome(); };
  const R = RUN; RUN = null;
  save();
  void R;
}

/* ══════════════════════════════════════════════════════════════
   2. СОБИРАТЬ
   ══════════════════════════════════════════════════════════════ */

const PW = 96, PH = 48;                       // размер детали в мировых единицах
const GRID = 12;                              // шаг сетки для выравнивания
const SNAP = 18;                              // радиус магнитного захвата вывода
const PIN_LAYOUT = {
  2: [{ x: 0, y: 24 }, { x: 96, y: 24 }],
  3: [{ x: 0, y: 24 }, { x: 48, y: 0 }, { x: 96, y: 24 }]   // 1, W(движок), 2
};

const B = { comps: [], wires: [], sol: null, diag: [], sel: null, wireFrom: null };
const V = { x: 40, y: 60, k: 1 };
let uid = 1;

const pinsOf = c => PIN_LAYOUT[PARTS[c.type].pins.length] || PIN_LAYOUT[2];
const pinPos = (c, i) => ({ x: c.x + pinsOf(c)[i].x, y: c.y + pinsOf(c)[i].y });
const compById = id => B.comps.find(c => c.id === id);

function addPart(type, x, y) {
  const c = { id: 'c' + (uid++), type, x: Math.round(x / GRID) * GRID, y: Math.round(y / GRID) * GRID, props: { ...PARTS[type].props } };
  B.comps.push(c);
  B.sol = null; B.diag = [];
  render(); return c;
}

/* ── Провода: кубическая кривая Безье ───────────────────────── */
function wirePath(p, q) {
  const dx = q.x - p.x, dy = q.y - p.y;
  const d = clamp(Math.abs(dx) * 0.45 + Math.abs(dy) * 0.12, 26, 96);
  if (Math.abs(dx) < 10) {                       // почти вертикально — изгиб по y
    const s = Math.sign(dy) || 1;
    return `M${p.x} ${p.y} C${p.x} ${p.y + s * d} ${q.x} ${q.y - s * d} ${q.x} ${q.y}`;
  }
  const s = Math.sign(dx);
  return `M${p.x} ${p.y} C${p.x + s * d} ${p.y} ${q.x - s * d} ${q.y} ${q.x} ${q.y}`;
}
function bez(p0, p1, p2, p3, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}
function wireGeom(w) {
  const ca = compById(w.a.c), cb = compById(w.b.c);
  const ia = PARTS[ca.type].pins.indexOf(w.a.p), ib = PARTS[cb.type].pins.indexOf(w.b.p);
  const p = pinPos(ca, ia), q = pinPos(cb, ib);
  const dx = q.x - p.x, dy = q.y - p.y;
  const d = clamp(Math.abs(dx) * 0.45 + Math.abs(dy) * 0.12, 26, 96);
  const c1 = Math.abs(dx) < 10 ? { x: p.x, y: p.y + (Math.sign(dy) || 1) * d } : { x: p.x + Math.sign(dx) * d, y: p.y };
  const c2 = Math.abs(dx) < 10 ? { x: q.x, y: q.y - (Math.sign(dy) || 1) * d } : { x: q.x - Math.sign(dx) * d, y: q.y };
  return { p, q, c1, c2, path: `M${p.x} ${p.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${q.x} ${q.y}` };
}
const key = e => e.c + '::' + e.p;
const wireExists = (a, b) => B.wires.some(w => (key(w.a) === key(a) && key(w.b) === key(b)) || (key(w.a) === key(b) && key(w.b) === key(a)));

function connect(a, b) {
  if (key(a) === key(b)) { toast('Это один и тот же вывод'); return false; }
  if (wireExists(a, b)) { toast('Такой провод уже есть'); return false; }
  B.wires.push({ id: 'w' + (uid++), a: { ...a }, b: { ...b } });
  B.sol = null; B.diag = [];
  return true;
}

/* ── Расчёт ─────────────────────────────────────────────────── */
function runCheck() {
  if (!B.comps.length) { toast('Сначала добавь детали'); return; }
  const comps = B.comps.map(c => ({ id: c.id, type: c.type, props: { ...c.props } }));
  const wires = B.wires.map(w => ({ a: { ...w.a }, b: { ...w.b } }));
  let sol;
  try { sol = solve(comps, wires); }
  catch (e) { B.sol = null; B.diag = [{ level: 'err', text: 'Схема не посчиталась: ' + e.message }]; render(); return; }
  B.sol = sol;
  try { B.diag = diagnose(comps, wires, sol) || []; }
  catch (e) { B.diag = []; }
  render();
  const errs = B.diag.filter(d => d.level === 'err').length;
  toast(errs ? `Найдено проблем: ${errs}` : (B.diag.length ? 'Схема рабочая' : 'Расчёт выполнен'));
}

/** Потенциал узла, нормированный 0…1 между самым минусовым и самым плюсовым. */
function netRatio(n) {
  if (!B.sol) return null;
  let lo = Infinity, hi = -Infinity;
  for (const u of B.sol.v) { if (u < lo) lo = u; if (u > hi) hi = u; }
  const span = hi - lo;
  if (!(span > 1e-9)) return 0;
  return clamp(((B.sol.v[n] ?? 0) - lo) / span, 0, 1);
}
function wireColor(n) {
  const r = netRatio(n);
  if (r === null) return 'var(--wire)';
  if (r > 0.72) return 'var(--wire-p)';
  if (r < 0.18) return 'var(--wire-n)';
  return 'var(--wire)';
}

/** Направление тока в проводе: выводится из тока соседней детали. */
function wireDir(w) {
  if (!B.sol) return 1;
  for (const side of ['a', 'b']) {
    const end = w[side];
    const comp = compById(end.c);
    if (!comp) continue;
    const P = PARTS[comp.type];
    if (P.pins.length !== 2) continue;          // потенциометр — неоднозначно
    const r = B.sol.result[end.c];
    if (!r || Math.abs(r.I) < 1e-7) continue;
    const idx = P.pins.indexOf(end.p);
    const into = (idx === 0) === (r.I > 0);     // ток втекает в вывод 0 при I > 0
    if (side === 'a') return into ? -1 : 1;
    return into ? 1 : -1;
  }
  return 1;
}
/** Есть ли в цепи этой сети заметный ток. */
function netLive(n) {
  if (!B.sol) return false;
  for (const c of B.comps) {
    const P = PARTS[c.type];
    for (let i = 0; i < P.pins.length; i++) {
      if (B.sol.nets.net(c.id, P.pins[i]) !== n) continue;
      const r = B.sol.result[c.id];
      if (r && Math.abs(r.I) > 1e-6) return true;
    }
  }
  return false;
}

function fmtI(i) {
  const a = Math.abs(i);
  if (a < 1e-6) return '0';
  if (a < 1e-3) return (i * 1e6).toFixed(0) + ' мкА';
  if (a < 1) return (i * 1000).toFixed(a < 0.01 ? 2 : 1) + ' мА';
  return i.toFixed(2) + ' А';
}
const fmtU = u => Math.abs(u) < 1 ? (u * 1000).toFixed(0) + ' мВ' : u.toFixed(2) + ' В';
const fmtR = r => r >= 1e6 ? (r / 1e6).toFixed(2) + ' МОм' : r >= 1000 ? (r / 1000).toFixed(r >= 10000 ? 1 : 2) + ' кОм' : r.toFixed(r < 10 ? 1 : 0) + ' Ом';

/* ── Отрисовка ──────────────────────────────────────────────── */
function render() {
  const vp = $('#viewport');
  vp.setAttribute('transform', `translate(${V.x} ${V.y}) scale(${V.k})`);
  const ws = $('#ws');
  ws.style.backgroundSize = `${24 * V.k}px ${24 * V.k}px`;
  ws.style.backgroundPosition = `${V.x}px ${V.y}px`;

  $('#wshint').hidden = B.comps.length > 0;

  /* провода */
  $('#layer-wire').innerHTML = B.wires.map(w => {
    const g = wireGeom(w);
    const n = B.sol ? B.sol.nets.net(w.a.c, w.a.p) : -1;
    const live = B.sol && netLive(n);
    const dir = wireDir(w);
    const sel = B.sel && B.sel.kind === 'wire' && B.sel.id === w.id;
    const cls = 'wire' + (live ? ' flow' : '') + (sel ? ' sel' : '');
    const style = live ? `;animation-direction:${dir < 0 ? 'reverse' : 'normal'}` : '';
    return `<path class="${cls}" d="${g.path}" style="stroke:${wireColor(n)}${style}"/>` +
           `<path class="hit" data-wire="${w.id}" d="${g.path}"/>`;
  }).join('');

  /* свечения (светодиод, лампа) */
  const glow = [];
  if (B.sol) {
    for (const c of B.comps) {
      const r = B.sol.result[c.id];
      if (!r) continue;
      const mA = Math.abs(r.I) * 1000;
      const cx = c.x + PW / 2, cy = c.y + PH / 2;
      if (c.type === 'led' && mA > 0.4) {
        const a = clamp(mA / 20, 0.15, 1) * 0.85;
        const rad = 12 + clamp(mA / 20, 0, 1) * 16;
        glow.push(`<circle class="glow" cx="${cx}" cy="${cy}" r="${rad}" fill="${c.props.color || '#c8563c'}" opacity="${a.toFixed(2)}" filter="url(#softglow)"/>`);
      }
      if (c.type === 'lamp' && mA > 5) {
        const a = clamp(mA / 400, 0.12, 0.8);
        glow.push(`<circle class="glow" cx="${cx}" cy="${cy}" r="${14 + clamp(mA / 400, 0, 1) * 18}" fill="#d8b070" opacity="${a.toFixed(2)}" filter="url(#softglow)"/>`);
      }
    }
  }
  $('#layer-glow').innerHTML = glow.join('');

  /* детали */
  $('#layer-part').innerHTML = B.comps.map(c => {
    const P = PARTS[c.type];
    const sym = symById(P.sym) || ALL_SYMBOLS[0];
    const col = groupColorOfSym(sym);
    const sel = B.sel && B.sel.kind === 'part' && B.sel.id === c.id;
    const pr = { ...P.props, ...c.props };
    let label = '';
    if (P.model === 'V') label = pr.V + ' В';
    else if (c.type === 'r') label = fmtR(pr.R);
    else if (c.type === 'lamp' || c.type === 'buzz' || c.type === 'motor') label = fmtR(pr.R);
    else if (c.type === 'led') label = pr.vf + ' В';
    else if (c.type === 'fuse') label = pr.I + ' А';
    else if (c.type === 'pot') label = fmtR(pr.R);
    else if (c.type === 'sw') label = pr.closed ? 'замкнут' : 'разомкнут';

    let val = '';
    if (B.sol && B.sol.result[c.id]) {
      const r = B.sol.result[c.id];
      const bits = [];
      if (P.model === 'AM') bits.push(fmtI(r.I));
      else if (P.model === 'VM') bits.push(fmtU(Math.abs(r.U)));
      else bits.push(fmtI(r.I));
      // ВАЖНО: координаты локальные — группа уже сдвинута translate(...) scale(0.8)
      val = `<text class="badge hi" x="48" y="${PH + 32}" transform="scale(1.25)">${bits[0]}</text>`;
    }
    return `<g class="part" data-part="${c.id}" transform="translate(${c.x} ${c.y}) scale(0.8)"
              style="color:${col}">
      ${sel ? `<rect x="-3" y="-3" width="${PW + 6}" height="${PH + 6}" rx="5" fill="none" stroke="#6f93b0" stroke-width="1.5" stroke-dasharray="4 3" transform="scale(1.25)"/>` : ''}
      ${LEADS}${sym.body}
      <text class="badge" x="${48}" y="${PH + 12}" transform="scale(1.25)">${esc(label)}</text>
      ${val}
    </g>`;
  }).join('');

  /* выводы */
  $('#layer-pin').innerHTML = B.comps.map(c => {
    const P = PARTS[c.type];
    return P.pins.map((p, i) => {
      const q = pinPos(c, i);
      const from = B.wireFrom;
      const hl = from && from.c === c.id && from.p === p;
      return `<circle data-c="${c.id}" data-p="${esc(p)}" cx="${q.x}" cy="${q.y}" r="${hl ? 6.5 : 4.5}"
        fill="${hl ? '#6f93b0' : '#1b1f26'}" stroke="${hl ? '#6f93b0' : '#6b7683'}" stroke-width="1.6"/>`;
    }).join('');
  }).join('');

  $('#t-check').disabled = !B.comps.length;
  renderDiag();
  saveBoard();
}

function renderDiag() {
  const box = $('#diag');
  if (!B.diag.length) { box.innerHTML = ''; return; }
  const icons = { err: '✕', warn: '!', ok: '✓' };
  box.innerHTML = `<div class="diag-in">` + B.diag.map(d =>
    `<div class="dmsg ${d.level}"><i>${icons[d.level] || '·'}</i><span>${esc(d.text)}</span></div>`
  ).join('') + `</div>`;
}

/* ── Панель свойств ─────────────────────────────────────────── */
function showProps() {
  const box = $('#props');
  if (!B.sel || B.sel.kind !== 'part') { box.hidden = true; return; }
  const c = compById(B.sel.id);
  if (!c) { B.sel = null; box.hidden = true; return; }
  const P = PARTS[c.type];
  const r = B.sol && B.sol.result[c.id];

  let fields = '';
  for (const [k, e] of Object.entries(P.editable || {})) {
    const v = c.props[k] ?? P.props[k];
    const disp = k === 'pos' ? Math.round(v * 100) + ' %' : v + (e.unit ? ' ' + e.unit : '');
    fields += `<div class="fld">
      <label>${esc(e.label)} <b id="pv-${k}">${esc(disp)}</b></label>
      <input type="range" data-k="${k}" min="${e.min}" max="${e.max}" step="${e.step}" value="${v}">
    </div>`;
  }
  if (c.type === 'sw') {
    fields += `<div class="fld"><label>Состояние <b>${c.props.closed ? 'замкнут' : 'разомкнут'}</b></label>
      <button class="btn ghost" data-tog="sw" style="padding:9px">${c.props.closed ? 'Разомкнуть' : 'Замкнуть'}</button></div>`;
  }
  if (c.type === 'led') {
    fields += `<div class="fld"><label>Цвет свечения</label>
      <div style="display:flex;gap:7px;flex-wrap:wrap">${[['#c8563c', 'красный'], ['#d8a13c', 'жёлтый'], ['#6f9e7a', 'зелёный'], ['#5f87b5', 'синий'], ['#cfd3d8', 'белый']]
        .map(([hx, nm]) => `<button data-col="${hx}" title="${nm}" style="width:34px;height:28px;border-radius:6px;background:${hx};border:2px solid ${c.props.color === hx ? '#dfe3e8' : 'transparent'}"></button>`).join('')}</div></div>`;
  }

  const readout = r ? `<div class="readout">
      <div><span>ТОК</span><b>${fmtI(r.I)}</b></div>
      <div><span>НАПРЯЖЕНИЕ</span><b>${fmtU(Math.abs(r.U))}</b></div>
      <div><span>МОЩНОСТЬ</span><b>${Math.abs(r.P) < 1 ? (Math.abs(r.P) * 1000).toFixed(0) + ' мВт' : Math.abs(r.P).toFixed(2) + ' Вт'}</b></div>
    </div>` : `<div class="pos">Нажми «Проверить», чтобы увидеть токи</div>`;

  box.hidden = false;
  box.innerHTML = `<h4>${esc(P.name)}</h4>
    <div class="pos">${P.pins.join(' · ')}${P.pins.length === 3 ? ' (1 — край, W — движок, 2 — край)' : ''}</div>
    ${readout}${fields}
    <div class="acts">
      <button data-act="rot">Повернуть</button>
      <button data-act="dup">Дублировать</button>
      <button class="del" data-act="del">Удалить</button>
    </div>`;

  box.querySelectorAll('input[type=range]').forEach(inp => {
    inp.oninput = () => {
      const k = inp.dataset.k;
      const val = parseFloat(inp.value);
      c.props[k] = val;
      const e = P.editable[k];
      $('#pv-' + k).textContent = k === 'pos' ? Math.round(val * 100) + ' %' : val + (e.unit ? ' ' + e.unit : '');
      B.sol = null; B.diag = [];
      render();
    };
  });
  box.querySelectorAll('[data-col]').forEach(b => b.onclick = () => { c.props.color = b.dataset.col; B.sol = null; render(); showProps(); });
  box.querySelector('[data-tog=sw]').onclick = () => { c.props.closed = !c.props.closed; B.sol = null; B.diag = []; render(); showProps(); };
  box.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    if (a === 'del') { B.comps = B.comps.filter(x => x.id !== c.id); B.wires = B.wires.filter(w => w.a.c !== c.id && w.b.c !== c.id); B.sel = null; }
    if (a === 'dup') { const n = addPart(c.type, c.x + 30, c.y + 30); n.props = { ...c.props }; B.sel = { kind: 'part', id: n.id }; }
    if (a === 'rot') {
      // поворот на 90°: меняем местами габариты через сдвиг — символ ГОСТ рисуется вдоль выводов,
      // поэтому физически поворачиваем только положение выводов
      toast('Символы ГОСТ рисуют строго по направлению тока — поворот недоступен');
    }
    B.sol = null; B.diag = [];
    render(); showProps();
  });
}

/* ── Взаимодействие с полем ─────────────────────────────────── */
const svg = $('#sheet');
const ptrs = new Map();
let drag = null, pan = null, pinch = null, moved = 0;

function toWorld(cx, cy) {
  const r = svg.getBoundingClientRect();
  return { x: (cx - r.left - V.x) / V.k, y: (cy - r.top - V.y) / V.k };
}

function hitPin(wx, wy) {
  const R = 13 / V.k + 4;
  for (const c of B.comps) {
    const P = PARTS[c.type];
    for (let i = 0; i < P.pins.length; i++) {
      const q = pinPos(c, i);
      if ((q.x - wx) ** 2 + (q.y - wy) ** 2 <= R * R) return { c: c.id, p: P.pins[i] };
    }
  }
  return null;
}
function hitPart(wx, wy) {
  for (let i = B.comps.length - 1; i >= 0; i--) {
    const c = B.comps[i];
    if (wx >= c.x - 4 && wx <= c.x + PW + 4 && wy >= c.y - 4 && wy <= c.y + PH + 4) return c;
  }
  return null;
}
function hitWire(wx, wy) {
  const R = (10 / V.k + 4) ** 2;
  for (const w of B.wires) {
    const g = wireGeom(w);
    for (let t = 0; t <= 1.0001; t += 1 / 24) {
      const p = bez(g.p, g.c1, g.c2, g.q, t);
      if ((p.x - wx) ** 2 + (p.y - wy) ** 2 <= R) return w;
    }
  }
  return null;
}

svg.addEventListener('pointerdown', e => {
  svg.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  moved = 0;
  if (ptrs.size === 2) {                       // щипок
    const [a, b] = [...ptrs.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: V.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    drag = null; pan = null;
    return;
  }
  const w = toWorld(e.clientX, e.clientY);
  const pinned = hitPin(w.x, w.y);

  if (B.wireFrom) {                            // второй вывод — завершаем провод
    if (pinned) {
      if (connect(B.wireFrom, pinned)) render();
      B.wireFrom = null;
    } else { B.wireFrom = null; render(); }    // нажатие мимо — отмена
    return;
  }
  if (pinned) { B.wireFrom = pinned; B.sel = null; render(); return; }

  const part = hitPart(w.x, w.y);
  if (part) {
    B.sel = { kind: 'part', id: part.id };
    drag = { id: part.id, dx: w.x - part.x, dy: w.y - part.y };
    const arr = B.comps.filter(x => x.id === part.id);
    B.comps = B.comps.filter(x => x.id !== part.id).concat(arr);
    render(); showProps();
    return;
  }
  const wire = hitWire(w.x, w.y);
  if (wire) { B.sel = { kind: 'wire', id: wire.id }; render(); showProps(); return; }

  B.sel = null; showProps();
  pan = { x: e.clientX - V.x, y: e.clientY - V.y };
  render();
});

svg.addEventListener('pointermove', e => {
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && ptrs.size >= 2) {
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch.d > 0) zoomAt(pinch.cx, pinch.cy, clamp(pinch.k * (d / pinch.d), 0.35, 3.2));
    return;
  }
  if (pan) { V.x = e.clientX - pan.x; V.y = e.clientY - pan.y; render(); return; }
  if (!drag) return;
  moved++;
  const w = toWorld(e.clientX, e.clientY);
  const c = compById(drag.id);
  if (!c) return;
  let nx = w.x - drag.dx, ny = w.y - drag.dy;

  // магнитные выводы: если вывод рядом с чужим — притягиваем
  let snapped = false;
  for (let i = 0; i < PARTS[c.type].pins.length; i++) {
    const q = { x: nx + pinsOf(c)[i].x, y: ny + pinsOf(c)[i].y };
    for (const o of B.comps) {
      if (o.id === c.id) continue;
      const OP = PARTS[o.type];
      for (let j = 0; j < OP.pins.length; j++) {
        const t = pinPos(o, j);
        if (Math.abs(q.x - t.x) < SNAP && Math.abs(q.y - t.y) < SNAP) {
          nx += t.x - q.x; ny += t.y - q.y; snapped = true; break;
        }
      }
      if (snapped) break;
    }
    if (snapped) break;
  }
  if (!snapped) { nx = Math.round(nx / GRID) * GRID; ny = Math.round(ny / GRID) * GRID; }
  c.x = nx; c.y = ny;
  render();
});

svg.addEventListener('pointerup', e => {
  ptrs.delete(e.pointerId);
  if (ptrs.size < 2) pinch = null;
  if (drag) { drag = null; saveBoard(); }
  pan = null;
});
svg.addEventListener('pointercancel', e => { ptrs.delete(e.pointerId); pinch = null; drag = null; pan = null; });

svg.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, clamp(V.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12), 0.35, 3.2));
}, { passive: false });

function zoomAt(cx, cy, k) {
  const r = svg.getBoundingClientRect();
  const sx = cx - r.left, sy = cy - r.top;
  const wx = (sx - V.x) / V.k, wy = (sy - V.y) / V.k;
  V.k = k;
  V.x = sx - wx * V.k; V.y = sy - wy * V.k;
  render();
}
$('#z-in').onclick = () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, clamp(V.k * 1.25, 0.35, 3.2)); };
$('#z-out').onclick = () => { const r = svg.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, clamp(V.k / 1.25, 0.35, 3.2)); };
$('#z-fit').onclick = () => fit();

function fit() {
  if (!B.comps.length) { V = { x: 40, y: 60, k: 1 }; Object.assign(V, { x: 40, y: 60, k: 1 }); render(); return; }
  const r = svg.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of B.comps) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + PW); y1 = Math.max(y1, c.y + PH); }
  const pad = 60;
  const k = clamp(Math.min((r.width - pad * 2) / (x1 - x0), (r.height - pad * 2) / (y1 - y0)), 0.35, 2);
  V.k = k;
  V.x = (r.width - (x1 - x0) * k) / 2 - x0 * k;
  V.y = (r.height - (y1 - y0) * k) / 2 - y0 * k;
  render();
}
let fitted = false;
function fitIfNeeded() { if (!fitted && B.comps.length) { fitted = true; fit(); } }

/* ── Палитра ────────────────────────────────────────────────── */
function buildPalette() {
  $('#pal-row').innerHTML = Object.entries(PARTS).map(([k, P]) => {
    const sym = symById(P.sym) || ALL_SYMBOLS[0];
    return `<button class="pchip" data-t="${k}" style="--pc:${groupColorOfSym(sym)}">
      ${svgOf(sym)}<span>${esc(P.name)}</span></button>`;
  }).join('');
  $$('#pal-row .pchip').forEach(b => b.onclick = () => {
    const r = svg.getBoundingClientRect();
    const w = toWorld(r.left + r.width / 2, r.top + r.height / 2);
    let x = w.x - PW / 2, y = w.y - PH / 2;
    // сдвигаем, пока не найдём свободное место
    let guard = 0;
    while (B.comps.some(c => Math.abs(c.x - x) < 30 && Math.abs(c.y - y) < 30) && guard++ < 40) { x += 26; y += 20; }
    const c = addPart(b.dataset.t, x, y);
    B.sel = { kind: 'part', id: c.id };
    render(); showProps();
    toast(PARTS[b.dataset.t].name + ' добавлен');
  });
}

$('#t-check').onclick = runCheck;
$('#t-clear').onclick = () => {
  if (!B.comps.length) return;
  if (!confirm('Очистить поле?')) return;
  B.comps = []; B.wires = []; B.sol = null; B.diag = []; B.sel = null; B.wireFrom = null;
  render(); showProps();
};

/* ── Готовые примеры ────────────────────────────────────────── */
const DEMOS = {
  'Светодиод с резистором': () => {
    const bat = addPart('bat', 60, 150), r = addPart('r', 260, 150), led = addPart('led', 460, 150);
    r.props.R = 470;
    // ток: +батареи → резистор → анод → катод → −батареи
    connect({ c: bat.id, p: '+' }, { c: r.id, p: '1' });
    connect({ c: r.id, p: '2' }, { c: led.id, p: 'A' });
    connect({ c: led.id, p: 'K' }, { c: bat.id, p: '−' });
  },
  'Светодиод без резистора': () => {
    const bat = addPart('bat', 120, 150), led = addPart('led', 380, 150);
    connect({ c: bat.id, p: '+' }, { c: led.id, p: 'A' });
    connect({ c: led.id, p: 'K' }, { c: bat.id, p: '−' });
  },
  'Делитель на потенциометре': () => {
    const bat = addPart('bat', 60, 130), pot = addPart('pot', 300, 130), vm = addPart('volt', 300, 280);
    connect({ c: bat.id, p: '−' }, { c: pot.id, p: '1' });
    connect({ c: pot.id, p: '2' }, { c: bat.id, p: '+' });
    connect({ c: pot.id, p: 'W' }, { c: vm.id, p: '+' });
    connect({ c: vm.id, p: '−' }, { c: bat.id, p: '−' });
  },
  'Лампа через выключатель': () => {
    const bat = addPart('bat', 60, 130), sw = addPart('sw', 250, 130), am = addPart('amp', 420, 130), lamp = addPart('lamp', 250, 290);
    sw.props.closed = false;
    connect({ c: bat.id, p: '−' }, { c: sw.id, p: '1' });
    connect({ c: sw.id, p: '2' }, { c: am.id, p: '+' });
    connect({ c: am.id, p: '−' }, { c: lamp.id, p: '1' });
    connect({ c: lamp.id, p: '2' }, { c: bat.id, p: '+' });
  },
  'Короткое замыкание': () => {
    const bat = addPart('bat', 200, 150);
    connect({ c: bat.id, p: '+' }, { c: bat.id, p: '−' });
  }
};
$('#t-demo').onclick = () => {
  openSheet(`<h2>Примеры схем</h2><p class="sub">Загрузи и нажми «Проверить»</p>` +
    Object.keys(DEMOS).map(k => `<button class="btn ghost" data-demo="${esc(k)}" style="margin-bottom:8px">${esc(k)}</button>`).join(''));
  $$('#sheet-host [data-demo]').forEach(b => b.onclick = () => {
    closeSheet();
    B.comps = []; B.wires = []; B.sol = null; B.diag = []; B.sel = null; B.wireFrom = null;
    DEMOS[b.dataset.demo]();
    fit(); render(); showProps();
    runCheck();
  });
};

/* ── Универсальная нижняя панель ────────────────────────────── */
function openSheet(html) {
  $('#sheet-host').innerHTML = `<div class="sheet"><div class="card"><div class="grab"></div>${html}</div></div>`;
  $('#sheet-host .sheet').onclick = e => { if (e.target.classList.contains('sheet')) closeSheet(); };
  $('#sheet-host .grab').onclick = closeSheet;
}
function closeSheet() { $('#sheet-host').innerHTML = ''; }

/* ── Сохранение поля ────────────────────────────────────────── */
function saveBoard() {
  ST.board = { comps: B.comps, wires: B.wires, view: { ...V } };
  save();
}
function loadBoard() {
  if (!ST.board || !ST.board.comps) return false;
  try {
    B.comps = ST.board.comps.filter(c => PARTS[c.type]).map(c => ({ ...c, props: { ...PARTS[c.type].props, ...(c.props || {}) } }));
    B.wires = (ST.board.wires || []).filter(w => compById(w.a.c) && compById(w.b.c));
    if (ST.board.view) Object.assign(V, ST.board.view);
    uid = 1 + B.comps.reduce((m, c) => Math.max(m, parseInt(String(c.id).slice(1)) || 0), 0)
           + B.wires.reduce((m, w) => Math.max(m, parseInt(String(w.id).slice(1)) || 0), 0);
    return B.comps.length > 0;
  } catch (e) { return false; }
}

/* ══════════════════════════════════════════════════════════════
   3. СПРАВОЧНИК
   ══════════════════════════════════════════════════════════════ */
function renderRef(filter) {
  const f = (filter || '').trim().toLowerCase();
  const pool = setOf('ref');
  const hits = !f ? pool : pool.filter(s =>
    s.name.toLowerCase().includes(f) || (s.si || '').toLowerCase().includes(f) ||
    (s.desc || '').toLowerCase().includes(f) || s.gname.toLowerCase().includes(f) || s.id.includes(f));

  if (!hits.length) { $('#reflist').innerHTML = `<div class="gempty">Ничего не найдено.</div>`; return; }

  const byGroup = {};
  for (const s of hits) (byGroup[s.gid] = byGroup[s.gid] || []).push(s);

  $('#reflist').innerHTML = Object.entries(byGroup).map(([gid, items]) => {
    const g = groupsOf('ref').find(x => x.id === gid);
    return `<div class="sec-title" style="--x:1;margin-top:14px">${esc(g.name)}</div>` +
      items.map(s => `<button class="gitem" data-id="${s.id}" style="--gc:${g.color}">
        <span class="ico">${symHTML(s)}</span>
        <span class="u"><b>${esc(s.name)}</b><span>${esc(s.desc.slice(0, 46))}…</span></span>
        ${s.si ? `<span class="si">${esc(s.si)}</span>` : ''}
      </button>`).join('');
  }).join('');

  $$('#reflist .gitem').forEach(b => b.onclick = () => openSym(b.dataset.id));
}

function openSym(id) {
  const s = symById(id);
  const g = groupsOf('ref').find(x => x.id === s.gid);
  openSheet(`
    <div class="big" style="--sc:${g.color}">${symHTML(s)}</div>
    <h2>${esc(s.name)}</h2>
    <p class="sub">${esc(g.name)}</p>
    <div class="dsc">${esc(s.desc)}</div>
    <div class="kv">
      <div><span>Код</span><b>${s.si ? esc(s.si) : '—'}</b></div>
      <div><span>Единица</span><b>${s.unit ? esc(s.unit) : '—'}</b></div>
      <div><span>Раздел</span><b>${esc(g.id)}</b></div>
    </div>
    <button class="btn ghost" onclick="closeSheet()">Закрыть</button>`);
}

/* ═══════════════════ ПЕРЕКЛЮЧАТЕЛЬ СТАНДАРТОВ ═══════════════════ */
function wireSeg(sel, key) {
  const box = $(sel);
  if (!box) return;
  box.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      if (STD[key] === b.dataset.std) return;
      STD[key] = b.dataset.std;
      box.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      if (key === 'learn') { RUN = null; renderHome(); $('#learn-home').hidden = false; $('#learn-run').hidden = true; $('#learn-done').hidden = true; }
      else renderRef($('#q').value);
      save();
    };
  });
}

/* ═══════════════════ ОРИГИНАЛ ГОСТ (страницы) ═══════════════════ */
const PAGES = 18;
let pvPage = 1;
function renderPage() {
  const host = $('#pv');
  host.innerHTML = `<img src="gost/p${String(pvPage).padStart(2, '0')}.jpg" alt="Страница ${pvPage} ГОСТ 21.210-2014">`;
  $('#pv-num').textContent = pvPage + ' / ' + PAGES;
  host.scrollTop = 0;
}
function pvGo(d) { pvPage = clamp(pvPage + d, 1, PAGES); renderPage(); }

/* ═══════════════════ ИНИЦИАЛИЗАЦИЯ ═══════════════════ */
function init() {
  regenHP();
  renderHome();
  buildPalette();
  renderRef('');
  wireSeg('#seg-learn', 'learn');
  wireSeg('#seg-ref', 'ref');
  $('#pv-prev').onclick = () => pvGo(-1);
  $('#pv-next').onclick = () => pvGo(1);
  renderPage();

  $('#q').oninput = e => renderRef(e.target.value);

  // восстанавливаем поле или показываем первый пример
  if (!loadBoard()) {
    DEMOS['Светодиод с резистором']();
    fitted = false;
  }
  render();
  fit();
  runCheck();
  go('learn');
  save();
}

/* клавиатура: 1..4 — выбор варианта, Enter — далее */
document.addEventListener('keydown', e => {
  if (RUN && !$('#learn-run').hidden) {
    if (/^[1-4]$/.test(e.key)) { const b = $('#qwrap .opt[data-i="' + (+e.key - 1) + '"]'); if (b && !b.disabled) b.click(); }
    if (e.key === 'Enter') { const b = $('#btn-next'); if (b) b.click(); }
  }
  if (e.key === 'Escape') closeSheet();
});

// «Повернуть» и closeSheet доступны из инлайн-обработчиков
window.closeSheet = closeSheet;

/**
 * Системная кнопка «Назад» (вызывается из MainActivity).
 * Возвращает true, если страница обработала нажатие сама.
 */
window.onBack = function () {
  if ($('#sheet-host').children.length) { closeSheet(); return true; }
  if (!$('#learn-run').hidden) { $('#btn-quit').click(); return true; }
  if (!$('#learn-done').hidden) { $('#btn-home').click(); return true; }
  if (!$('#t-build').hidden) {
    if (B.wireFrom) { B.wireFrom = null; render(); return true; }
    if (B.sel) { B.sel = null; render(); showProps(); return true; }
    go('learn'); return true;
  }
  if (!$('#t-ref').hidden) { go('learn'); return true; }
  if (!$('#t-orig').hidden) { go('learn'); return true; }
  return false;
};

init();
