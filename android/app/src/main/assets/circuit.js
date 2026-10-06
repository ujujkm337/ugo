/* ══════════════════════════════════════════════════════════════
   Решатель электрических цепей постоянного тока.
   Метод узловых потенциалов (MNA) + метод Ньютона для
   нелинейных элементов (диоды, светодиоды).

   Реальные вычисления, а не «картинка»: считаются токи в каждой
   ветви, напряжения в каждом узле, мощность, и выдаются
   диагностики — КЗ, обрыв, отсутствие токоограничения.
   ══════════════════════════════════════════════════════════════ */
'use strict';

const VT = 0.025852;          // тепловой потенциал, В (при 25 °C)
const G_LEAK = 1e-9;          // утечка на землю, чтобы матрица не вырождалась
const R_CLOSED = 1e-3;        // замкнутый ключ / амперметр
const R_OPEN = 1e9;           // разомкнутый ключ / вольтметр
const R_INT = 0.35;           // внутреннее сопротивление батареи, Ом — как у реальной

/* ── Каталог деталей для режима сборки ───────────────────────── */
const PARTS = {
  bat: {
    name: 'Батарея', pins: ['+', '−'], model: 'V',
    props: { V: 9 }, editable: { V: { label: 'Напряжение', unit: 'В', min: 1, max: 48, step: 0.5 } },
    sym: 'bat_1', w: 2, h: 1
  },
  r: {
    name: 'Резистор', pins: ['1', '2'], model: 'R',
    props: { R: 220 }, editable: { R: { label: 'Сопротивление', unit: 'Ом', min: 1, max: 100000, step: 10 } },
    sym: 'r', w: 2, h: 1
  },
  led: {
    name: 'Светодиод', pins: ['A', 'K'], model: 'D',
    props: { vf: 2.0, color: '#c8563c' }, editable: { vf: { label: 'Падение напряжения', unit: 'В', min: 1.2, max: 3.6, step: 0.1 } },
    sym: 'd_led', w: 2, h: 1
  },
  lamp: {
    name: 'Лампа 12В 5Вт', pins: ['1', '2'], model: 'R',
    props: { R: 28.8 }, editable: { R: { label: 'Сопротивление', unit: 'Ом', min: 1, max: 1000, step: 1 } },
    sym: 'lamp', w: 2, h: 1
  },
  sw: {
    name: 'Выключатель', pins: ['1', '2'], model: 'SW',
    props: { closed: false }, editable: {},
    sym: 'sw', w: 2, h: 1
  },
  amp: {
    name: 'Амперметр', pins: ['+', '−'], model: 'AM',
    props: {}, editable: {}, sym: 'amp', w: 2, h: 1
  },
  volt: {
    name: 'Вольтметр', pins: ['+', '−'], model: 'VM',
    props: {}, editable: {}, sym: 'volt', w: 2, h: 1
  },
  fuse: {
    name: 'Предохранитель 0.5А', pins: ['1', '2'], model: 'F',
    props: { I: 0.5, R: 0.05 }, editable: { I: { label: 'Номинал', unit: 'А', min: 0.05, max: 10, step: 0.05 } },
    sym: 'fuse', w: 2, h: 1
  },
  buzz: {
    name: 'Зуммер', pins: ['+', '−'], model: 'R',
    props: { R: 32 }, editable: { R: { label: 'Сопротивление', unit: 'Ом', min: 4, max: 500, step: 4 } },
    sym: 'bell', w: 2, h: 1
  },
  motor: {
    name: 'Мотор', pins: ['+', '−'], model: 'R',
    props: { R: 15 }, editable: { R: { label: 'Сопротивление', unit: 'Ом', min: 1, max: 200, step: 1 } },
    sym: 'motor', w: 2, h: 1
  },
  pot: {
    name: 'Потенциометр 10к', pins: ['1', 'W', '2'], model: 'POT',
    props: { R: 10000, pos: 0.5 }, editable: { pos: { label: 'Положение', unit: '', min: 0, max: 1, step: 0.02 } },
    sym: 'r_var', w: 2, h: 1
  },
};

/* ── Диод: параметры модели из прямого падения ───────────────── */
function diodeParams(vf, n = 2.0) {
  const Is = 0.02 / (Math.exp(vf / (n * VT)) - 1);
  return { Is, n };
}
// Защита от переполнения — зажимаем ПОКАЗАТЕЛЬ, а не напряжение.
// exp(300) ≈ 1.9e130, далеко от потолка double (~1.8e308).
// Раньше здесь ошибочно зажималось само напряжение на 1.2 В, из-за чего
// светодиод с Vf = 2.0 В не мог открыться вообще.
const EXP_MAX = 300;
const dCurrent = (v, p) => p.Is * (Math.exp(Math.min(v / (p.n * VT), EXP_MAX)) - 1);
const dConduct = (v, p) => (p.Is / (p.n * VT)) * Math.exp(Math.min(v / (p.n * VT), EXP_MAX));

/*  Vcrit — напряжение, при котором p-n переход уже явно открыт.
    Ограничитель ШПАЙСА (pnjlim): новый рабочий point не берётся напрямую
    из решения линейной системы (оно может подскочить на вольты), а
    притягивается логарифмом. Это единственный способ заставить Ньютон
    сходиться на экспоненте: без него ток улетает за 1e60 А.           */
function dVcrit(p) {
  const vt = p.n * VT;
  if (!(p.Is > 0) || !isFinite(p.Is)) return 1.0;
  return vt * Math.log(vt / (Math.SQRT2 * p.Is));
}

function pnjlim(vnew, vold, p) {
  const vt = p.n * VT;
  const vcrit = dVcrit(p);
  if (!isFinite(vnew)) vnew = 0;
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      vnew = arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    } else {
      vnew = vt * Math.log(Math.max(vnew / vt, 1e-9));
    }
  }
  // в обратном направлении не даём уйти глубже −5 В (грубая модель пробоя)
  return Math.max(-5, Math.min(vnew, 40));
}

/* ── Union-Find: пины → эквипотенциальные узлы ───────────────── */
function makeDSU() {
  const p = new Map();
  const find = x => {
    if (!p.has(x)) p.set(x, x);
    while (p.get(x) !== x) { p.set(x, p.get(p.get(x))); x = p.get(x); }
    return x;
  };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) p.set(ra, rb); };
  return { find, union, keys: () => [...p.keys()] };
}

/** Пины компонентов + провода → список сетей */
function buildNets(components, wires) {
  const dsu = makeDSU();
  const pinKey = (cid, pin) => `${cid}::${pin}`;
  for (const c of components) for (const pin of PARTS[c.type].pins) dsu.find(pinKey(c.id, pin));
  for (const w of wires) {
    dsu.find(pinKey(w.a.c, w.a.p));
    dsu.find(pinKey(w.b.c, w.b.p));
    dsu.union(pinKey(w.a.c, w.a.p), pinKey(w.b.c, w.b.p));
  }
  const netId = new Map();
  const netOf = k => {
    const r = dsu.find(k);
    if (!netId.has(r)) netId.set(r, netId.size);
    return netId.get(r);
  };

  // ВАЖНО: пронумеровать все выводы ДО чтения netId.size — иначе счётчик
  // вернёт 0 (лентивая нумерация) и внутренние узлы источников
  // получат индексы, уже занятые настоящими сетями.
  const allPins = [];
  for (const c of components) {
    const P = PARTS[c.type];
    if (!P) continue;
    for (const pin of P.pins) allPins.push(pinKey(c.id, pin));
  }
  for (const k of allPins) netOf(k);

  return {
    netOf,
    netCount: netId.size,
    net: (cid, pin) => netOf(pinKey(cid, pin))
  };
}

/* ── Построение MNA-системы ──────────────────────────────────── */
function stamp(A, z, i, j, g) {
  if (i === j) return;
  A[i][i] += g; A[j][j] += g; A[i][j] -= g; A[j][i] -= g;
}

function buildSystem(branches, netCount, vd) {
  const N = netCount;
  const vsrc = branches.filter(b => b.kind === 'V');
  const M = vsrc.length;
  const S = N + M;                                  // + неизвестные токи источников

  // индексы токовых неизвестных присваиваем ДО основного цикла
  vsrc.forEach((b, k) => { b.idx = N + k; });

  const A = Array.from({ length: S }, () => new Array(S).fill(0));
  const z = new Array(S).fill(0);

  // утечка 1 ГОм на узел 0 — держит матрицу невырожденной при обрывах
  for (let i = 1; i < N; i++) A[i][i] += G_LEAK;

  let di = 0;
  for (const br of branches) {
    const { a, b } = br;
    switch (br.kind) {
      case 'R':
        stamp(A, z, a, b, 1 / Math.max(br.R, 1e-12));
        break;

      case 'D': {                                   // диод: линейный компаньон Ньютона
        const v = vd[di++];
        const G = dConduct(v, br.p);
        const Ieq = dCurrent(v, br.p) - G * v;
        stamp(A, z, a, b, G);
        z[a] -= Ieq; z[b] += Ieq;                   // ток Ieq вытекает из анода
        break;
      }

      case 'V': {
        // Классическая MNA-ветвь источника напряжения:
        //   неизвестная x[idx] — ток, вытекающий из узла a в ветвь
        //   ограничение: V(a) − V(b) = E
        A[a][br.idx] += 1; A[b][br.idx] -= 1;
        A[br.idx][a] += 1; A[br.idx][b] -= 1;
        z[br.idx] = br.V;
        break;
      }
    }
  }
  return { A, z, S };
}

/* ── Гаусс с выбором ведущего элемента ───────────────────────── */
function gauss(A, z) {
  const n = z.length;
  const M = A.map((row, i) => [...row, z[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-15) continue;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let r = col + 1; r < n; r++) {
      const f = M[r][col] / d;
      if (!f) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let c = r + 1; c < n; c++) s -= M[r][c] * x[c];
    x[r] = Math.abs(M[r][r]) < 1e-15 ? 0 : s / M[r][r];
  }
  return x;
}

/* ── Основной расчёт ─────────────────────────────────────────── */
function solve(components, wires) {
  const nets = buildNets(components, wires);
  const branches = [];
  const diodes = [];

  // Каждому источнику ЭДС выделяем внутренний узел: без него идеальный
  // источник, замкнутый накоротко, вырождал бы матрицу (Va−Vb одновременно
  // 0 и E). Внутренний узел превращает его в реальную схему замещения
  // Теве́нена: E последовательно с R_INT — ровно как у настоящей батареи.
  const vInt = new Map();
  let extra = 0;
  for (const c of components) {
    if (PARTS[c.type].model === 'V') vInt.set(c.id, nets.netCount + extra++);
  }
  const netCount = nets.netCount + extra;

  for (const c of components) {
    const P = PARTS[c.type];
    const pr = { ...P.props, ...(c.props || {}) };
    const a = nets.net(c.id, P.pins[0]);

    if (P.model === 'POT') {
      // потенциометр раскладывается в два последовательных резистора
      const w = nets.net(c.id, P.pins[1]), b = nets.net(c.id, P.pins[2]);
      const pos = Math.min(Math.max(pr.pos ?? 0.5, 0), 1);
      branches.push({ kind: 'R', a, b: w, R: Math.max(pr.R * pos, 1e-3), src: c.id });
      branches.push({ kind: 'R', a: w, b, R: Math.max(pr.R * (1 - pos), 1e-3), src: c.id });
      continue;
    }

    const b = nets.net(c.id, P.pins[1]);
    switch (P.model) {
      case 'V': {
        // a — плюс, b — минус. Внутри: a ←[R_INT]← int, а int ←[E]→ b
        // Ветвь R записана как (int → a), поэтому её ток == ток, отдаваемый
        // источником во внешнюю цепь (положительный при разряде).
        const int = vInt.get(c.id);
        branches.push({ kind: 'R', a: int, b: a, R: R_INT, src: c.id });
        branches.push({ kind: 'V', a: int, b, V: pr.V, src: c.id });
        break;
      }
      case 'R':  branches.push({ kind: 'R', a, b, R: Math.max(pr.R, 1e-6), src: c.id }); break;
      case 'SW': branches.push({ kind: 'R', a, b, R: pr.closed ? R_CLOSED : R_OPEN, src: c.id }); break;
      case 'AM': branches.push({ kind: 'R', a, b, R: R_CLOSED, src: c.id }); break;
      case 'VM': branches.push({ kind: 'R', a, b, R: R_OPEN, src: c.id }); break;
      case 'F':  branches.push({ kind: 'R', a, b, R: pr.R ?? 0.05, src: c.id }); break;
      case 'D': {
        const p = diodeParams(pr.vf);
        diodes.push({ src: c.id, a, b, p });
        branches.push({ kind: 'D', a, b, p, src: c.id });
        break;
      }
    }
  }

  // Ньютон по диодам
  const vd = diodes.map(() => 0.7);
  let sol = new Array(netCount).fill(0);
  for (let it = 0; it < 400; it++) {
    const { A, z } = buildSystem(branches, netCount, vd);
    sol = gauss(A, z);
    if (!diodes.length) break;
    let maxd = 0;
    diodes.forEach((d, i) => {
      const vbr = sol[d.a] - sol[d.b];
      const next = pnjlim(vbr, vd[i], d.p);
      maxd = Math.max(maxd, Math.abs(next - vd[i]));
      vd[i] = next;
    });
    if (maxd < 1e-9) break;
  }
  const v = sol.slice(0, netCount);

  // токи и мощности по ветвям
  const result = {};
  for (const c of components) {
    const P = PARTS[c.type];
    const pr = { ...P.props, ...(c.props || {}) };
    const cur = [], vol = [];
    for (const br of branches) {
      if (br.src !== c.id) continue;
      const dv = v[br.a] - v[br.b];
      let i;
      if (br.kind === 'R') i = dv / br.R;
      else if (br.kind === 'D') i = dCurrent(dv, br.p);
      else i = -sol[br.idx];   // ток, который источник отдаёт во внешнюю цепь
      cur.push(i); vol.push(dv);
    }
    const I = cur.length ? cur[0] : 0;
    result[c.id] = {
      I, U: vol.reduce((s, x, k) => s + Math.abs(x) * (cur.length > 1 ? 0.5 : 1), 0),
      P: Math.abs(I * vol.reduce((s, x) => s + x, 0)),
      branches: cur.map((i, k) => ({ I: i, U: vol[k] }))
    };
  }

  return { v, sol, result, nets, netCount: netCount, branches, vd };
}

/* ── Диагностика: то, ради чего всё затевалось ───────────────── */
function diagnose(components, wires, sol) {
  const warn = [];
  const byId = Object.fromEntries(components.map(c => [c.id, c]));
  const res = sol.result;

  // 1. Короткое замыкание: источник отдаёт слишком большой ток
  for (const c of components) {
    if (PARTS[c.type].model !== 'V') continue;
    const I = Math.abs(res[c.id]?.I || 0);
    if (I > 2.0) {
      warn.push({ level: 'err', text: `Короткое замыкание: батарея отдаёт ${fmtA(I)}. Между + и − нет нагрузки.` });
    } else if (I > 1.0) {
      warn.push({ level: 'warn', text: `Ток источника ${fmtA(I)} — подозрительно много, проверь номиналы.` });
    }
  }

  // 2. Светодиод без токоограничения
  for (const c of components) {
    if (PARTS[c.type].model !== 'D') continue;
    const r = res[c.id]; if (!r) continue;
    const ImA = r.I * 1000;
    if (ImA > 45) warn.push({ level: 'err', text: `Светодиод: ${ImA.toFixed(0)} мА — сгорит. Нужен резистор последовательно.` });
    else if (ImA > 25) warn.push({ level: 'warn', text: `Светодиод: ${ImA.toFixed(1)} мА — выше нормы 20 мА, ресурс падает.` });
    else if (ImA > 0.5 && ImA <= 25) warn.push({ level: 'ok', text: `Светодиод горит: ${ImA.toFixed(1)} мА — норма.` });
  }

  // 3. Обратное включение светодиода
  for (const c of components) {
    if (PARTS[c.type].model !== 'D') continue;
    const r = res[c.id]; if (!r) continue;
    if (r.branches[0] && r.branches[0].U < -0.3)
      warn.push({ level: 'warn', text: 'Светодиод включён в обратной полярности — ток не идёт.' });
  }

  // 4. Обрыв: лампа/мотор не получают тока
  for (const c of components) {
    const m = PARTS[c.type].model;
    if (!['R'].includes(m)) continue;
    const pr = { ...PARTS[c.type].props, ...(c.props || {}) };
    if (c.type === 'r') continue;
    const I = Math.abs(res[c.id]?.I || 0);
    if (I < 1e-6) warn.push({ level: 'warn', text: `${PARTS[c.type].name}: ток не течёт — цепь разомкнута.` });
  }

  // 5. Предохранитель
  for (const c of components) {
    if (PARTS[c.type].model !== 'F') continue;
    const pr = { ...PARTS[c.type].props, ...(c.props || {}) };
    const I = Math.abs(res[c.id]?.I || 0);
    if (I > pr.I) warn.push({ level: 'err', text: `Предохранитель перегорел: ${fmtA(I)} при номинале ${pr.I} А.` });
  }

  // 6. Провода, висящие в воздухе
  const used = new Set();
  for (const w of wires) { used.add(`${w.a.c}::${w.a.p}`); used.add(`${w.b.c}::${w.b.p}`); }
  for (const c of components) {
    const P = PARTS[c.type];
    const hanging = P.pins.filter(p => !used.has(`${c.id}::${p}`));
    if (hanging.length) {
      const all = hanging.length === P.pins.length;
      warn.push({
        level: all ? 'warn' : 'warn',
        text: `${P.name}: ${all ? 'не подключён совсем' : `не подключён вывод ${hanging.join(', ')}`}.`
      });
    }
  }

  return warn;
}

const fmtA = i => Math.abs(i) >= 1 ? `${i.toFixed(2)} А` : `${(i * 1000).toFixed(1)} мА`;

if (typeof module !== 'undefined') module.exports = { PARTS, solve, diagnose, buildNets, diodeParams };
