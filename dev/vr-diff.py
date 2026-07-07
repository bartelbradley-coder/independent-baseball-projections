#!/usr/bin/env python3
"""Visual-regression diff: compares two capture labels pixel-wise.
Usage: python3 dev/vr-diff.py baseline after-fonts
Prints per-screenshot diff percentage and writes red-highlighted diff images
for anything above threshold into dev/vr-out/diff_<a>_vs_<b>/."""
import sys, os
from PIL import Image, ImageChops

a_label, b_label = sys.argv[1], sys.argv[2]
root = os.path.join(os.path.dirname(__file__), 'vr-out')
a_dir, b_dir = os.path.join(root, a_label), os.path.join(root, b_label)
out_dir = os.path.join(root, f'diff_{a_label}_vs_{b_label}')
os.makedirs(out_dir, exist_ok=True)

THRESH = 0.10  # % changed pixels above which we write a diff image
rows = []
for name in sorted(os.listdir(a_dir)):
    if not name.endswith('.png'):
        continue
    pa, pb = os.path.join(a_dir, name), os.path.join(b_dir, name)
    if not os.path.exists(pb):
        rows.append((name, None, 'MISSING in ' + b_label)); continue
    ia, ib = Image.open(pa).convert('RGB'), Image.open(pb).convert('RGB')
    if ia.size != ib.size:
        # pad shorter image so layout-height changes still diff sensibly
        w = max(ia.width, ib.width); h = max(ia.height, ib.height)
        for im_name in ('ia', 'ib'):
            im = locals()[im_name]
            if im.size != (w, h):
                canvas = Image.new('RGB', (w, h), (11, 15, 26))
                canvas.paste(im, (0, 0)); locals()[im_name] = canvas
        ia = locals()['ia']; ib = locals()['ib']
    diff = ImageChops.difference(ia, ib).convert('L')
    # count pixels with meaningful change (>8/255 — ignores AA jitter)
    hist = diff.point(lambda p: 255 if p > 8 else 0)
    changed = sum(1 for p in hist.getdata() if p)
    pctv = changed / (ia.width * ia.height) * 100
    note = ''
    if pctv > THRESH:
        overlay = ib.copy()
        red = Image.new('RGB', ia.size, (255, 40, 40))
        overlay = Image.composite(red, overlay, hist.point(lambda p: 120 if p else 0))
        overlay.save(os.path.join(out_dir, name))
        note = '→ diff image written'
    rows.append((name, pctv, note))

print(f'{"screenshot":28} {"diff%":>8}')
for name, pctv, note in rows:
    print(f'{name:28} {pctv if pctv is None else round(pctv, 3)!s:>8}  {note}')
