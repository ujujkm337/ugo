#!/usr/bin/env python3
"""Приводит вырезки к единому виду и собирает plan-symbols.js.

Отсеивает явный мусор (сплошные заливки, обрывки линий сетки), чистит
подписи от OCR-мусора, масштабирует в единый бокс и раскладывает по
разделам согласно оглавлению ГОСТ 21.210-2014.
"""
import json, os, re, shutil
from PIL import Image

SRC = "/home/user/gost/symbols_raw"
DST = "/home/user/gost/app/plan"
os.makedirs(DST, exist_ok=True)
for f in os.listdir(DST):
    if f.endswith('.png'):
        os.remove(os.path.join(DST, f))

GROUPS = [
    (5,  'oru',   'Открытые распределительные устройства', '#b08f7f'),
    (6,  'dev',   'Электротехнические устройства',          '#7f95b3'),
    (7,  'line',  'Линии проводок и токопроводов',          '#7fa8b0'),
    (9,  'box',   'Коробки, щитки, шкафы',                  '#a894b0'),
    (11, 'sw',    'Выключатели, переключатели, розетки',    '#8fa88b'),
    (13, 'light', 'Светильники и прожекторы',               '#b0a97f'),
    (16, 'ctrl',  'Аппараты контроля и управления',         '#8f9bb0'),
]
def group_of(page):
    g = GROUPS[0]
    for p, gid, name, col in GROUPS:
        if page >= p:
            g = (p, gid, name, col)
    return g[1], g[2], g[3]

# мусор, которым OCR забивает подписи
JUNK_TAIL = re.compile(r'\s*[»\'"\u201c\u201d].*$')
# обрезка по первому «мусорному прогону»: 2+ символа вне кириллицы/цифр/знаков
JUNK_RUN  = re.compile(r'[^\u0400-\u04FF0-9\s.,():;\u2014\u2013\-/\u2116%\u00B0+*]{2,}')
OK_CHARS  = re.compile(r'[^\u0400-\u04FF0-9\s.,():;\u2014\u2013\-/\u2116%\u00B0+*]')

def clean_label(s):
    s = JUNK_TAIL.sub('', s)
    m = JUNK_RUN.search(s)
    if m:
        s = s[:m.start()]
    s = re.sub(r'\s+', ' ', s).strip(' .,-\u2014\u2013:')
    # убираем висячие одиночные символы на конце («в», «4», «-»)
    s = re.sub(r'\s+[\u0400-\u04FF0-9]$', '', s)
    s = re.sub(r'\s+[-.,;:]$', '', s)
    return s.strip()

raw = json.load(open(f"{SRC}/index.json"))
out, dropped = [], []

for s in raw:
    label = clean_label(s['label'])
    if len(label) < 3:
        dropped.append((s['file'], 'подпись слишком короткая'))
        continue
    if s['ink'] > 0.72:
        dropped.append((s['file'], f"сплошная заливка ink={s['ink']}"))
        continue

    im = Image.open(f"{SRC}/{s['file']}").convert('RGBA')
    w, h = im.size
    if w < 6 or h < 6:
        dropped.append((s['file'], f'крошечный {w}x{h}'))
        continue
    if h < 4 and w > 100:                       # обрывок линии сетки
        dropped.append((s['file'], f'обрывок линии {w}x{h}'))
        continue

    # масштабируем в бокс 220×110 с сохранением пропорций
    box_w, box_h = 220, 110
    k = min(box_w / w, box_h / h, 2.0)
    nw, nh = max(2, int(round(w * k))), max(2, int(round(h * k)))
    im = im.resize((nw, nh), Image.LANCZOS)

    gid, gname, gcol = group_of(s['page'])
    idx = len(out)
    fn = f"{gid}_{idx:03d}.png"
    im.save(f"{DST}/{fn}", optimize=True)
    out.append({
        "id": f"plan_{gid}_{idx:03d}",
        "name": label,
        "group": gname,
        "gid": gid,
        "desc": f"{gname}. Страница {s['page']} оригинала ГОСТ 21.210-2014.",
        "si": "",
        "unit": "", 
        "color": gcol,
        "img": "plan/" + fn,
        "w": nw, "h": nh,
        "page": s['page'],
    })

json.dump({"dropped": dropped, "symbols": out},
          open("/home/user/gost/plan_build.json", "w"), ensure_ascii=False, indent=1)

js = ["/* ГОСТ 21.210-2014 — условные графические изображения на планах.",
      "   Изображения вырезаны напрямую из оригинала стандарта (скан),",
      "   поэтому соответствуют первоисточнику, а не перерисовке. */",
      "'use strict';", "",
      "const PLAN_GROUPS = " + json.dumps(
          [{"id": g[1], "name": g[2], "color": g[3],
            "items": [s for s in out if s["gid"] == g[1]]}
           for g in GROUPS], ensure_ascii=False, indent=1) + ";",
      "",
      "const PLAN_SYMBOLS = PLAN_GROUPS.flatMap(g => g.items.map(s => ({ ...s, gname: g.name })));",
      "",
      "if (typeof module !== 'undefined') module.exports = { PLAN_GROUPS, PLAN_SYMBOLS };",
      ""]
open("/home/user/gost/app/plan-symbols.js", "w", encoding='utf-8').write("\n".join(js))

print(f"символов: {len(out)}   отсеяно: {len(dropped)}")
by = {}
for s in out:
    by[s['group']] = by.get(s['group'], 0) + 1
for k, v in by.items():
    print(f"   {k}: {v}")
print("\nотсеянное (первые 12):")
for f, why in dropped[:12]:
    print(f"   {f}: {why}")
