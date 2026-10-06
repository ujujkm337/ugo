#!/usr/bin/env python3
"""Вырезание подлинных символов ГОСТ 21.210-2014 из скана (итоговая версия).

Ключевые решения:
  • окно по Y — середина между соседними строками таблицы: символ всегда
    попадает целиком и не задевает соседний;
  • рамка таблицы срезается ПОСЛЕ обрезки по содержимому (порядок важен:
    до обрезки линия сетки может оказаться не на самом краю);
  • родительский пункт переносится через страницы — иначе у подпунктов на
    новой странице теряется название.
"""
import json, re, os, sys
from pypdf import PdfReader
import pypdfium2 as pdfium
from PIL import Image

SRC = "/home/user/uploads/02 ГОСТ Условные обозначения электромонтажа.pdf"
OUT = "/home/user/gost/symbols_raw"
SCALE = 4.0
PAGES = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]
# окно колонки «Изображение» своё для каждой таблицы: в таблице 3
# (линии проводок) рисунки стоят левее и шире, чем в остальных
COL = {
    7: (356.0, 418.0), 8: (356.0, 418.0),
}
COL_X0, COL_X1 = 386.0, 468.0

os.makedirs(OUT, exist_ok=True)
for f in os.listdir(OUT):
    if f.endswith('.png'):
        os.remove(os.path.join(OUT, f))

reader = PdfReader(SRC)
pdf = pdfium.PdfDocument(SRC)

NUM    = re.compile(r'^\s*(\d+)\s+[А-ЯЁ]')
SUB    = re.compile(r'^\s*([а-я])\)\s*(\S.*)$')
SUBNUM = re.compile(r'^\s*\d+\.\d+\s+(\S.*)$')
JUNK   = re.compile(r'(Условные графические изображения|^Продолжение|^Окончание'
                    r'|^Примечание|^ГОСТ|^п\.\s|^\d+\.\d+\s+Контуры)')


def rows_of(pi, tol=12.0):
    """Склеивает текстовые блоки, лежащие на одной строке (в ГОСТе номер
    пункта и его название — отдельные блоки), и продолжающиеся строки."""
    items = []
    def visitor(text, cm, tm, font, size):
        t = text.strip()
        if t:
            items.append((float(tm[5]), float(tm[4]), t))
    reader.pages[pi].extract_text(visitor_text=visitor)
    items.sort(key=lambda r: (-r[0], r[1]))
    clusters = []
    for y, x, t in items:
        if clusters and abs(clusters[-1]['y0'] - y) <= tol:
            clusters[-1]['ys'].append(y)
            clusters[-1]['parts'].append((x, t))
            clusters[-1]['y0'] = min(clusters[-1]['y0'], y)
        else:
            clusters.append({'y0': y, 'ys': [y], 'parts': [(x, t)]})
    out = []
    for c in clusters:
        c['parts'].sort()
        ymid = (min(c['ys']) + max(c['ys'])) / 2.0
        out.append((ymid, c['parts'][0][0], ' '.join(p[1] for p in c['parts'])))
    return out


def remove_rules(gray, x0, x1, y0, y1, frac=0.85):
    """Стирает сквозные линии сетки таблицы: вертикальные и горизонтальные.
    Делается на уровне целой страницы и ДО нарезки — иначе линия попадает
    в каждую вырезку и портит её."""
    px = gray.load()
    for x in range(x0, x1):
        if sum(1 for y in range(y0, y1) if px[x, y] > 40) / (y1 - y0) > frac:
            for y in range(y0, y1):
                px[x, y] = 0
    for y in range(y0, y1):
        if sum(1 for x in range(x0, x1) if px[x, y] > 40) / (x1 - x0) > frac:
            for x in range(x0, x1):
                px[x, y] = 0
    return gray


def binarize(pil):
    g = pil.convert('L')
    hist = g.histogram()
    total = sum(hist) or 1
    acc, thr = 0, 140
    for i, c in enumerate(hist):
        acc += c
        if acc > total * 0.90:
            thr = i
            break
    thr = max(95, min(205, thr + 45))
    return g.point(lambda v: 255 if v < thr else 0)


def strip_frame(mask, frac=0.80, limit=0.35):
    """Убирает сплошные линии сетки, примыкающие к краям вырезки."""
    m = mask.copy()
    W, H = m.size
    px = m.load()
    row_ink = lambda y: sum(1 for x in range(W) if px[x, y] > 40) / W
    col_ink = lambda x: sum(1 for y in range(H) if px[x, y] > 40) / H

    top, bot, left, right = 0, H - 1, 0, W - 1
    while top < H * limit and row_ink(top) > frac:
        top += 1
    while bot > H * (1 - limit) and row_ink(bot) > frac:
        bot -= 1
    while left < W * limit and col_ink(left) > frac:
        left += 1
    while right > W * (1 - limit) and col_ink(right) > frac:
        right -= 1
    if left >= right or top >= bot:
        return mask
    return m.crop((left, top, right + 1, bot + 1))


def to_rgba(mask):
    rgb = Image.new('RGB', mask.size, (223, 227, 232))
    out = Image.merge('RGBA', (*rgb.split(), mask))
    bb = out.getbbox()
    return out.crop(bb) if bb else out


def ink_ratio(img):
    px = list(img.split()[-1].getdata())
    return sum(1 for v in px if v > 40) / len(px)


def tidy(mask):
    """Обрезка по содержимому → срезание рамки → снова обрезка."""
    bb = mask.getbbox()
    m = mask.crop(bb) if bb else mask
    m = strip_frame(m)
    bb = m.getbbox()
    return m.crop(bb) if bb else m


results = []
parent = None                                  # переносится через страницы

for pno in PAGES:
    pi = pno - 1
    page = pdf[pi]
    mb = page.get_mediabox()
    PW, PH = float(mb[2] - mb[0]), float(mb[3] - mb[1])
    full = page.render(scale=SCALE).to_pil().convert('L')
    IW, IH = full.size
    sx, sy = IW / PW, IH / PH
    # область таблицы в пикселях — заведомо шире любой ячейки
    tx0, tx1 = int((58 - mb[0]) * sx), int((524 - mb[0]) * sx)
    ty0, ty1 = int((PH - 735) * sy), int((PH - 78) * sy)
    tx0, tx1 = max(0, tx0), min(IW, tx1)
    ty0, ty1 = max(0, ty0), min(IH, ty1)
    binpage = binarize(full)
    binpage = remove_rules(binpage, tx0, tx1, ty0, ty1)

    all_rows = rows_of(pi)
    hdr = [y for y, x, t in all_rows if 'Наименование' in t]
    if not hdr:
        print(f"стр.{pno}: нет шапки таблицы — пропуск", file=sys.stderr)
        continue
    hdr_y = max(hdr)
    cand = sorted([(y, x, t) for y, x, t in all_rows
                   if x < 350.0 and y < hdr_y - 2], key=lambda r: -r[0])

    cx0, cx1 = COL.get(pno, (COL_X0, COL_X1))
    plan = []
    for i, (y, x, t) in enumerate(cand):
        m, s = NUM.match(t), SUB.match(t)
        sn = SUBNUM.match(t)
        if not (m or s or sn):
            continue
        if JUNK.search(t):
            continue
        nxt = cand[i + 1][2] if i + 1 < len(cand) else ''
        if m:
            if SUB.match(nxt) or (SUBNUM.match(nxt) and nxt.split()[0].split('.')[0] == m.group(1)):
                parent = re.sub(r'\s+', ' ', t).strip().rstrip(':')
                continue
            plan.append((y, re.sub(r'\s+', ' ', t).strip()))
            parent = None
        elif s:
            plan.append((y, (parent or '') + ' — ' + re.sub(r'\s+', ' ', s.group(2)).strip()))
        else:
            plan.append((y, (parent or '') + ' — ' + re.sub(r'\s+', ' ', sn.group(1)).strip()))

    # Окно фиксированной высоты оказалось надёжнее середины между строками:
    # при разной вёрстке таблиц середина срезала часть рисунка.
    for i, (y, label) in enumerate(plan):
        ytop_pdf = y + 30.0
        ybot_pdf = y - 14.0

        x0 = max(0, int((cx0 - mb[0]) * sx))
        x1 = min(IW, int((cx1 - mb[0]) * sx))
        ya = max(0, int((PH - ytop_pdf) * sy))
        yb = min(IH, int((PH - ybot_pdf) * sy))
        if x1 - x0 < 4 or yb - ya < 4:
            continue

        sym = to_rgba(tidy(binpage.crop((x0, ya, x1, yb))))
        if sym.size[0] < 4 or sym.size[1] < 4:
            continue
        r = ink_ratio(sym)
        if r < 0.01 or r > 0.80:
            continue
        fn = f"p{pno:02d}_{len(results):03d}.png"
        sym.save(f"{OUT}/{fn}")
        results.append({"page": pno, "file": fn, "label": label,
                        "w": sym.size[0], "h": sym.size[1], "ink": round(r, 4)})
    print(f"стр.{pno}: накоплено {len(results)}", file=sys.stderr)

json.dump(results, open(f"{OUT}/index.json", "w"), ensure_ascii=False, indent=1)
print(f"\nИТОГО: {len(results)}")
