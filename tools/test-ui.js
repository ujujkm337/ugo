const { chromium } = require('/tmp/node_modules/playwright-core');
const BASE = 'http://127.0.0.1:8099/index.html';

const R = [];
const ok  = (n, c, extra) => R.push([c ? 'PASS' : 'FAIL', n, extra || '']);

async function overflow(page) {
  return await page.evaluate(() => {
    const bad = [];
    const de = document.documentElement;
    if (de.scrollWidth > de.clientWidth + 1) bad.push(`DOC scrollWidth ${de.scrollWidth} > ${de.clientWidth}`);
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (el.offsetParent === null && cs.position !== 'fixed') return;
      let p = el.parentElement, skip = false;
      while (p) {
        const pcs = getComputedStyle(p);
        if (['auto', 'scroll', 'hidden'].includes(pcs.overflowX)) { skip = true; break; }
        p = p.parentElement;
      }
      if (skip) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      if (r.right > window.innerWidth + 1.5 || r.left < -1.5)
        bad.push(`${el.tagName}.${String(el.className).slice(0, 40)} L${r.left.toFixed(0)} R${r.right.toFixed(0)}`);
    });
    return bad;
  });
}

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 });

  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForSelector('#units .unit', { timeout: 8000 });

  /* ── 1. Обучение: витрина ─────────────────────────────── */
  const units = await page.$$('#units .unit');
  ok('витрина: 6 разделов', units.length === 6, `найдено ${units.length}`);
  const goalTxt = await page.textContent('#goaltxt');
  ok('цель дня 0/20', goalTxt === '0/20', goalTxt);
  const hp = await page.textContent('#s-hp');
  ok('жизней 5', hp === '5', hp);

  /* ── 2. Урок ──────────────────────────────────────────── */
  await units[1].click();                       // раздел «Полупроводники»
  await page.waitForSelector('#qwrap .opt', { timeout: 5000 });
  ok('урок открылся', await page.isVisible('#learn-run'));

  /* Вычисляем верный вариант по данным стандарта, а не тыкаем наугад:
     так проверяется и сам ключ ответов тренажёра. */
  const rightIdx = () => page.evaluate(() => {
    /* Браузер сериализует <line/> как <line></line>, поэтому сравниваем
       не строками, а пересобранным DOM. */
    const norm = html => {
      const d = new DOMParser().parseFromString(String(html), 'image/svg+xml');
      return d.documentElement && d.documentElement.nodeName === 'svg'
        ? d.documentElement.outerHTML.replace(/\s+/g, ' ').trim()
        : String(html).replace(/\s+/g, ' ').trim();
    };
    const all = GROUPS.flatMap(g => g.items);
    const opts = [...document.querySelectorAll('#qwrap .opt')];
    const shown = document.querySelector('#qwrap .qprompt .bigsym');
    if (shown) {                       // «что это за элемент?» — в подсказке символ
      const want = norm(shown.innerHTML);
      const sym = all.find(s => norm(svgOf(s)) === want);
      return sym ? opts.findIndex(o => o.querySelector('.v').textContent.trim() === sym.name) : -1;
    }
    const big = document.querySelector('#qwrap .qprompt .big, #qwrap .qprompt .desc');
    if (!big) return -1;
    const txt = big.textContent.trim();
    const sym = all.find(s => s.name === txt) || all.find(s => s.desc === txt)
             || all.find(s => s.si === txt);
    if (!sym) return -1;
    const want = norm(svgOf(sym));
    return opts.findIndex(o => norm(o.querySelector('.v').innerHTML) === want);
  });

  let steps = 0, answered = 0, wrong = 0, unresolved = 0;
  while (steps++ < 45) {
    if (await page.isVisible('#learn-done')) break;
    const idx = await rightIdx();
    if (idx < 0) { unresolved++; }
    const opt = await page.$(`#qwrap .opt[data-i="${idx < 0 ? 0 : idx}"]`);
    if (!opt) break;
    await opt.click();
    await page.waitForTimeout(60);
    answered++;
    const fbVisible = await page.isVisible('#fb');
    if (!fbVisible) { ok('обратная связь появляется', false, 'шаг ' + steps); break; }
    if (await page.$('#qwrap .opt.wrong')) wrong++;
    const nb = await page.$('#btn-next');
    if (!nb) break;
    await nb.click();
    await page.waitForTimeout(60);
  }
  ok('верный вариант определяется для каждого вопроса', unresolved === 0, `не опознано: ${unresolved}`);
  ok('тренажёр принимает верные ответы', wrong === 0, `отклонено верных: ${wrong}`);
  ok('урок доведён до итога', await page.isVisible('#learn-done'), `вопросов отвечено: ${answered}`);

  const xpAfter = parseInt(await page.textContent('#s-xp'), 10);
  ok('опыт начислен', xpAfter > 0, 'xp=' + xpAfter);
  const doneStats = await page.$$('.donestats div');
  ok('карточка итога с 3 метриками', doneStats.length === 3, `${doneStats.length}`);

  await page.click('#btn-home');
  await page.waitForTimeout(150);
  ok('возврат к разделам', await page.isVisible('#learn-home'));

  /* ── 3. Сборка: демонстрационная схема ────────────────── */
  await page.click('#tabbar button[data-tab="build"]');
  await page.waitForTimeout(300);

  const parts = await page.$$('#layer-part g.part');
  ok('демо-схема: 3 детали', parts.length === 3, `${parts.length}`);
  const wires = await page.$$('#layer-wire path.wire');
  ok('демо-схема: 3 провода', wires.length === 3, `${wires.length}`);
  const pins = await page.$$('#layer-pin circle');
  ok('выводы отрисованы', pins.length === 6, `${pins.length}`);

  const badges = await page.$$eval('#layer-part text.badge.hi', els => els.map(e => e.textContent));
  ok('токи посчитаны и показаны', badges.length === 3 && badges.every(b => /мА|А|мкА/.test(b)), JSON.stringify(badges));
  const ledI = badges[2] || '';
  ok('ток светодиода ≈14.9 мА', /14\.[6-9]|15\.0/.test(ledI), ledI);

  // сверяем подписи с реальным центром детали — центром между её выводами
  const badgePos = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#layer-part g.part')).map(g => {
      const id = g.dataset.part;
      const pins = Array.from(document.querySelectorAll(`#layer-pin circle[data-c="${id}"]`))
        .map(c => c.getBoundingClientRect());
      if (!pins.length) return null;
      const cx = pins.reduce((s, p) => s + p.left + p.width / 2, 0) / pins.length;
      const cy = pins.reduce((s, p) => s + p.top + p.height / 2, 0) / pins.length;
      const bs = g.querySelectorAll('text.badge');
      const lbl = bs[0] && bs[0].getBoundingClientRect();
      const val = bs[1] && bs[1].getBoundingClientRect();
      return {
        dx: val ? +(val.left + val.width / 2 - cx).toFixed(1) : null,
        gap: (lbl && val) ? +(val.top - lbl.bottom).toFixed(1) : null,
        drop: val ? +(val.top - cy).toFixed(1) : null
      };
    }).filter(Boolean));
  ok('подписи значений ровно под деталями',
    badgePos.length === 3 && badgePos.every(p => Math.abs(p.dx) < 5 && p.gap > 0 && p.gap < 14 && p.drop > 2),
    JSON.stringify(badgePos));

  const flowing = await page.$$('#layer-wire path.wire.flow');
  ok('провода анимированы (есть ток)', flowing.length >= 3, `${flowing.length}`);

  const glows = await page.$$('#layer-glow circle.glow');
  ok('светодиод светится мягким свечением', glows.length === 1, `${glows.length}`);

  const diag = await page.textContent('#diag');
  ok('диагностика: светодиод горит', /горит/i.test(diag), diag.trim().slice(0, 90));

  /* ── 4. Сборка: взаимодействие ────────────────────────── */
  const before = (await page.$$('#layer-part g.part')).length;
  await page.click('#pal-row .pchip[data-t="sw"]');
  await page.waitForTimeout(200);
  const after = (await page.$$('#layer-part g.part')).length;
  ok('деталь добавляется из палитры', after === before + 1, `${before} → ${after}`);

  ok('панель свойств открылась', await page.isVisible('#props'));
  const swBtn = await page.$('#props [data-tog="sw"]');
  if (swBtn) {
    const before_lbl = (await swBtn.textContent()).trim();
    await swBtn.click(); await page.waitForTimeout(200);
    const after_lbl = (await page.textContent('#props [data-tog="sw"]')).trim();
    const state = await page.textContent('#props .fld label b');
    ok('переключатель переключается',
      before_lbl !== after_lbl && /замкнут|разомкнут/.test(state),
      `${before_lbl} → ${after_lbl}, состояние «${state}»`);
  } else ok('переключатель переключается', false, 'кнопка не найдена');

  // тап по выводу → подсветка, второй тап по другому выводу → провод
  const nWires0 = (await page.$$('#layer-wire path.wire')).length;
  const pinList = await page.$$('#layer-pin circle');
  await pinList[pinList.length - 2].click();
  await page.waitForTimeout(120);
  const hl = await page.$$('#layer-pin circle[fill="#6f93b0"]');
  ok('вывод подсвечивается при нажатии', hl.length === 1, `${hl.length}`);
  const pinList2 = await page.$$('#layer-pin circle');
  await pinList2[0].click();
  await page.waitForTimeout(150);
  const nWires1 = (await page.$$('#layer-wire path.wire')).length;
  ok('провод создаётся между выводами', nWires1 === nWires0 + 1, `${nWires0} → ${nWires1}`);

  await page.click('#t-check');
  await page.waitForTimeout(250);
  ok('кнопка «Проверить» не ломает приложение', errs.length === 0, errs[0] || '');

  // КЗ — должен ловиться
  await page.click('#t-clear');
  page.once('dialog', d => d.accept());
  await page.click('#t-clear');
  await page.waitForTimeout(200);
  await page.click('#t-demo');
  await page.waitForTimeout(250);
  const demos = await page.$$('#sheet-host [data-demo]');
  ok('меню примеров: 5 схем', demos.length === 5, `${demos.length}`);
  await page.click('#sheet-host [data-demo="Короткое замыкание"]');
  await page.waitForTimeout(400);
  const d2 = await page.textContent('#diag');
  ok('короткое замыкание распознаётся', /короткое замыкание/i.test(d2), d2.trim().slice(0, 100));

  await page.click('#sheet-host .sheet', { position: { x: 5, y: 5 } }).catch(() => {});
  await page.waitForTimeout(150);

  // светодиод без резистора
  await page.click('#t-demo');
  await page.waitForTimeout(200);
  await page.click('#sheet-host [data-demo="Светодиод без резистора"]');
  await page.waitForTimeout(400);
  const d3 = await page.textContent('#diag');
  ok('светодиод без резистора — сгорит', /сгорит/i.test(d3), d3.trim().slice(0, 110));

  /* ── 5. Справочник ────────────────────────────────────── */
  await page.click('#tabbar button[data-tab="ref"]');
  await page.waitForTimeout(200);
  const all = await page.$$('#reflist .gitem');
  ok('справочник: все символы', all.length === 52, `${all.length}`);

  await page.fill('#q', 'тиристор');
  await page.waitForTimeout(250);
  const hits = await page.$$eval('#reflist .gitem b', e => e.map(x => x.textContent));
  ok('поиск «тиристор»', hits.some(h => /Тиристор/.test(h)), JSON.stringify(hits));

  await page.fill('#q', 'VD');
  await page.waitForTimeout(250);
  const hits2 = await page.$$('#reflist .gitem');
  ok('поиск по буквенному коду VD', hits2.length >= 3, `${hits2.length}`);

  // переключатель стандартов
  await page.fill('#q', '');
  await page.click('#seg-ref button[data-std="plan"]');
  await page.waitForTimeout(300);
  const planCount = (await page.$$('#reflist .gitem')).length;
  ok('ГОСТ 21.210: символы загрузились', planCount > 100, `${planCount}`);
  const planImgs = await page.$$('#reflist .gitem img.symimg');
  ok('символы планов — вырезки из скана', planImgs.length === planCount, `${planImgs.length}/${planCount}`);
  // картинки ленивые: прокручиваем список, чтобы все подтянулись
  await page.evaluate(async () => {
    const sc = document.getElementById('t-ref');
    for (let y = 0; y < sc.scrollHeight; y += 400) { sc.scrollTop = y; await new Promise(r => setTimeout(r, 50)); }
    sc.scrollTop = 0;
  });
  await page.waitForTimeout(1200);
  const broken = await page.$$eval('#reflist img.symimg',
    els => els.filter(e => !e.complete || e.naturalWidth === 0).length);
  ok('все 149 вырезок целые', broken === 0 && planImgs.length === 149, `битых: ${broken}`);
  await page.fill('#q', 'розетка');
  await page.waitForTimeout(250);
  const sock = await page.$$eval('#reflist .gitem b', e => e.map(x => x.textContent));
  ok('поиск по планам: «розетка»', sock.some(t => /озетк/i.test(t)), JSON.stringify(sock.slice(0, 3)));
  await page.fill('#q', '');
  await page.click('#seg-ref button[data-std="escd"]');
  await page.waitForTimeout(250);
  ok('возврат на ЕСКД', (await page.$$('#reflist .gitem')).length === 52,
     `${(await page.$$('#reflist .gitem')).length}`);

  await page.fill('#q', 'zzzz');
  await page.waitForTimeout(200);
  ok('пустой результат', await page.isVisible('.gempty'));
  await page.fill('#q', '');
  await page.waitForTimeout(200);

  await page.click('#reflist .gitem');
  await page.waitForTimeout(300);
  ok('карточка символа открывается', await page.isVisible('#sheet-host .sheet'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok('карточка закрывается по Escape', !(await page.isVisible('#sheet-host .sheet').catch(() => false)));

  /* ── 5б. Оригинал ГОСТ ─────────────────────────────────── */
  await page.click('#tabbar button[data-tab="orig"]');
  await page.waitForTimeout(400);
  ok('вкладка оригинала открылась', await page.isVisible('#t-orig'));
  ok('счётчик страниц 1 / 18', (await page.textContent('#pv-num')).trim() === '1 / 18',
     await page.textContent('#pv-num'));
  const p1 = await page.getAttribute('#pv img', 'src');
  ok('страница 1 загрузилась', p1 === 'gost/p01.jpg', p1);
  const loaded = await page.$eval('#pv img', e => e.complete && e.naturalWidth > 0);
  ok('страница ГОСТ отрисовалась', loaded);
  await page.click('#pv-next'); await page.waitForTimeout(300);
  ok('перелистывание вперёд', (await page.textContent('#pv-num')).trim() === '2 / 18',
     await page.textContent('#pv-num'));
  await page.click('#pv-prev'); await page.click('#pv-prev'); await page.waitForTimeout(300);
  ok('упор на первой странице', (await page.textContent('#pv-num')).trim() === '1 / 18',
     await page.textContent('#pv-num'));

  /* ── 6. Перенос между вкладками ───────────────────────── */
  await page.click('#tabbar button[data-tab="learn"]');
  await page.waitForTimeout(150);
  ok('возврат на «Учить»', await page.isVisible('#t-learn') && !(await page.isVisible('#t-build')));

  /* ── 7. Переполнение по ширинам ───────────────────────── */
  for (const w of [320, 360, 390, 412, 430, 768]) {
    await page.setViewportSize({ width: w, height: 780 });
    for (const tab of ['learn', 'build', 'ref', 'orig']) {
      await page.click(`#tabbar button[data-tab="${tab}"]`);
      await page.waitForTimeout(220);
      const bad = await overflow(page);
      ok(`нет переполнения ${w}px / ${tab}`, bad.length === 0, bad.slice(0, 3).join(' | '));
    }
  }

  /* ── 8. Ошибки консоли ───────────────────────────────── */
  ok('ноль ошибок в консоли', errs.length === 0, errs.slice(0, 4).join(' || '));

  await browser.close();

  const pass = R.filter(r => r[0] === 'PASS').length;
  console.log('\n' + '─'.repeat(64));
  for (const [s, n, e] of R) console.log(`  ${s === 'PASS' ? '✔' : '✖'} ${n}${e ? '  — ' + e : ''}`);
  console.log('─'.repeat(64));
  console.log(`  ИТОГ: ${pass} прошло, ${R.length - pass} упало`);
  process.exit(R.length - pass ? 1 : 0);
})().catch(e => { console.error('АВАРИЯ:', e); process.exit(2); });
