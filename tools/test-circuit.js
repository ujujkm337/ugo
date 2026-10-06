const { PARTS, solve, diagnose } = require('/home/user/gost/app/circuit.js');

let pass = 0, fail = 0;
const near = (a, b, tol, msg) => {
  const ok = Math.abs(a - b) <= tol;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✔' : '✖'} ${msg}: ${a.toFixed(4)} (ожидалось ~${b})`);
};

const comp = (id, type, props) => ({ id, type, props: props || {} });
const wire = (c1, p1, c2, p2) => ({ a: { c: c1, p: p1 }, b: { c: c2, p: p2 } });

console.log('── 1. Батарея 9 В + резистор 220 Ом ──────────────────');
{
  const C = [comp('B', 'bat', { V: 9 }), comp('R', 'r', { R: 220 })];
  const W = [wire('B', '+', 'R', '1'), wire('R', '2', 'B', '−')];
  const s = solve(C, W);
  near(s.result.R.I * 1000, 9000 / 220.35, 0.05, 'ток через резистор, мА');
  near(Math.abs(s.result.B.I) * 1000, 9000 / 220.35, 0.05, 'ток батареи, мА');
  near(s.result.R.branches[0].U, 9 * 220 / 220.35, 0.02, 'напряжение на резисторе, В');
  console.log('     знак тока батареи (должен быть +, разряд):', s.result.B.I > 0 ? 'ок' : 'ОШИБКА');
  console.log('     диагностика:', diagnose(C, W, s).map(w => `${w.level}:${w.text}`).join(' | ') || 'чисто');
}

console.log('\n── 2. Два резистора по 220 Ом последовательно ────────');
{
  const C = [comp('B', 'bat', { V: 9 }), comp('R1', 'r', { R: 220 }), comp('R2', 'r', { R: 220 })];
  const W = [wire('B', '+', 'R1', '1'), wire('R1', '2', 'R2', '1'), wire('R2', '2', 'B', '−')];
  const s = solve(C, W);
  near(s.result.R1.I * 1000, 9000 / 440.35, 0.05, 'ток, мА');
  near(s.result.R1.branches[0].U, 4.5, 0.05, 'напряжение на R1, В');
}

console.log('\n── 3. Светодиод (Vf 2.0) + резистор 470 Ом ───────────');
{
  const C = [comp('B', 'bat', { V: 9 }), comp('L', 'led', { vf: 2.0 }), comp('R', 'r', { R: 470 })];
  const W = [wire('B', '+', 'L', 'A'), wire('L', 'K', 'R', '1'), wire('R', '2', 'B', '−')];
  const s = solve(C, W);
  const I = s.result.L.I * 1000;
  console.log(`  ✔ ток через светодиод: ${I.toFixed(2)} мА (ожидалось ~14.9 мА)`);
  near(I, 14.9, 1.2, 'ток светодиода, мА');
  near(s.result.L.branches[0].U, 2.0, 0.35, 'падение на светодиоде, В');
  const d = diagnose(C, W, s);
  console.log('     диагностика:', d.map(w => `${w.level}:${w.text}`).join(' | '));
  if (!d.some(x => x.level === 'ok')) { console.log('     ✖ нет подтверждения "светодиод горит"'); fail++; } else pass++;
}

console.log('\n── 4. Короткое замыкание: + напрямую на − ─────────────');
{
  const C = [comp('B', 'bat', { V: 9 })];
  const W = [wire('B', '+', 'B', '−')];
  const s = solve(C, W);
  const I = Math.abs(s.result.B.I);
  console.log(`  ${I > 10 ? '✔' : '✖'} ток КЗ: ${I.toFixed(1)} А (должен быть огромным)`);
  I > 10 ? pass++ : fail++;
  const d = diagnose(C, W, s);
  console.log('     диагностика:', d.map(w => `${w.level}:${w.text}`).join(' | '));
  if (!d.some(x => x.level === 'err' && /Короткое/.test(x.text))) { console.log('     ✖ КЗ не распознано'); fail++; } else pass++;
}

console.log('\n── 5. Разомкнутый выключатель ─────────────────────────');
{
  const C = [comp('B', 'bat', { V: 9 }), comp('S', 'sw', { closed: false }), comp('R', 'r', { R: 220 })];
  const W = [wire('B', '+', 'S', '1'), wire('S', '2', 'R', '1'), wire('R', '2', 'B', '−')];
  const s = solve(C, W);
  console.log(`  ${Math.abs(s.result.R.I) < 1e-6 ? '✔' : '✖'} ток: ${(s.result.R.I * 1e9).toFixed(2)} нА (должен быть ~0)`);
  Math.abs(s.result.R.I) < 1e-6 ? pass++ : fail++;
}

console.log('\n── 6. Тот же выключатель замкнут ──────────────────────');
{
  const C = [comp('B', 'bat', { V: 9 }), comp('S', 'sw', { closed: true }), comp('R', 'r', { R: 220 })];
  const W = [wire('B', '+', 'S', '1'), wire('S', '2', 'R', '1'), wire('R', '2', 'B', '−')];
  const s = solve(C, W);
  near(s.result.R.I * 1000, 9000 / 220.35, 0.1, 'ток после замыкания, мА');
}

console.log('\n── 7. Светодиод БЕЗ резистора (должен сгореть) ────────');
{
  const C = [comp('B', 'bat', { V: 9 }), comp('L', 'led', { vf: 2.0 })];
  const W = [wire('B', '+', 'L', 'A'), wire('L', 'K', 'B', '−')];
  const s = solve(C, W);
  const I = s.result.L.I * 1000;
  console.log(`  ${I > 45 ? '✔' : '✖'} ток: ${I.toFixed(0)} мА (должен превысить 45 мА)`);
  I > 45 ? pass++ : fail++;
  const d = diagnose(C, W, s);
  console.log('     диагностика:', d.map(w => `${w.level}:${w.text}`).join(' | '));
}

console.log('\n── 8. Светодиод в обратной полярности ─────────────────');
{
  const C = [comp('B', 'bat', { V: 9 }), comp('L', 'led', { vf: 2.0 }), comp('R', 'r', { R: 470 })];
  const W = [wire('B', '+', 'L', 'K'), wire('L', 'A', 'R', '1'), wire('R', '2', 'B', '−')];
  const s = solve(C, W);
  const I = s.result.L.I * 1000;
  console.log(`  ${Math.abs(I) < 0.5 ? '✔' : '✖'} ток: ${I.toFixed(3)} мА (должен быть ~0)`);
  Math.abs(I) < 0.5 ? pass++ : fail++;
  const d = diagnose(C, W, s);
  console.log('     диагностика:', d.map(w => `${w.level}:${w.text}`).join(' | '));
}

console.log('\n── 9. Два резистора параллельно (100 Ом каждый) ───────');
{
  const C = [comp('B', 'bat', { V: 9 }), comp('R1', 'r', { R: 100 }), comp('R2', 'r', { R: 100 })];
  const W = [wire('B', '+', 'R1', '1'), wire('B', '+', 'R2', '1'), wire('R1', '2', 'B', '−'), wire('R2', '2', 'B', '−')];
  const s = solve(C, W);
  near(s.result.R1.I * 1000, 9000 / 100.35, 0.5, 'ток в ветви 1, мА');
  near(Math.abs(s.result.B.I) * 1000, 2 * 9000 / 100.35, 1.0, 'суммарный ток батареи, мА');
}

console.log('\n── 10. Амперметр + вольтметр в цепи ──────────────────');
{
  const C = [comp('B', 'bat', { V: 9 }), comp('A', 'amp'), comp('R', 'r', { R: 220 }), comp('V', 'volt')];
  const W = [wire('B', '+', 'A', '+'), wire('A', '−', 'R', '1'), wire('R', '2', 'B', '−'),
             wire('R', '1', 'V', '+'), wire('V', '−', 'B', '−')];
  const s = solve(C, W);
  near(s.result.A.I * 1000, 9000 / 220.35, 0.2, 'показание амперметра, мА');
  near(s.result.V.branches[0].U, 9 * 220 / 220.35, 0.05, 'показание вольтметра, В');
}

console.log('\n── 11. Потенциометр как делитель ─────────────────────');
{
  const C = [comp('B', 'bat', { V: 9 }), comp('P', 'pot', { R: 10000, pos: 0.5 })];
  const W = [wire('B', '+', 'P', '1'), wire('P', '2', 'B', '−')];
  const s = solve(C, W);
  near(Math.abs(s.result.B.I) * 1000, 9000 / 10000.35, 0.05, 'ток делителя 10к, мА');
}

console.log('\n── 12. Неподключённый компонент ──────────────────────');
{
  const C = [comp('B', 'bat', { V: 9 }), comp('R', 'r', { R: 220 })];
  const W = [wire('B', '+', 'R', '1')];   // R2 висит в воздухе
  const s = solve(C, W);
  const d = diagnose(C, W, s);
  console.log('     диагностика:', d.map(w => `${w.level}:${w.text}`).join(' | '));
  if (d.some(x => /не подключён/.test(x.text))) { console.log('  ✔ обрыв распознан'); pass++; }
  else { console.log('  ✖ обрыв не распознан'); fail++; }
}

console.log(`\n═══ ИТОГ: ${pass} прошло, ${fail} упало ═══`);
process.exit(fail ? 1 : 0);
