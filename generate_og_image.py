#!/usr/bin/env python3
"""
generate_og_image.py
Generates og-image.png (1200×630) for Independent Baseball Projections social sharing.
Reads live stats from data/history.json so the card stays current.
Called by export_site_data.py on every export.
"""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

SITE_DIR = os.path.dirname(os.path.abspath(__file__))

ARIAL       = '/System/Library/Fonts/Supplemental/Arial.ttf'
ARIAL_BOLD  = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
GEORGIA     = '/System/Library/Fonts/Supplemental/Georgia.ttf'

# Palette
BG_DARK   = (15,  23,  42)
BG_MID    = (30,  41,  59)
BORDER    = (51,  65,  85)
TEXT_PRI  = (241, 245, 249)
TEXT_SEC  = (148, 163, 184)
TEXT_MUT  = (100, 116, 139)
GREEN     = (34,  197, 94)
AMBER     = (245, 158, 11)
INDIGO    = (99,  102, 241)


def load_stats():
    try:
        with open(os.path.join(SITE_DIR, 'data', 'history.json')) as f:
            h = json.load(f)
        rows   = h.get('rows', [])
        settled = [r for r in rows if r.get('result') in ('W', 'L')]
        wins   = sum(1 for r in settled if r['result'] == 'W')
        losses = len(settled) - wins
        pnl    = sum(r.get('pnl_u', 0) or 0 for r in settled)
        clv_r  = [r for r in rows if r.get('clv') is not None]
        avg_clv = sum(r['clv'] for r in clv_r) / len(clv_r) if clv_r else 0
        roi    = pnl / len(settled) if settled else 0
        return {
            'record':  f'{wins}W–{losses}L',
            'pnl':     f'+{pnl:.1f}u'    if pnl    >= 0 else f'{pnl:.1f}u',
            'avg_clv': f'+{avg_clv*100:.2f}%' if avg_clv >= 0 else f'{avg_clv*100:.2f}%',
            'roi':     f'+{roi*100:.1f}%' if roi    >= 0 else f'{roi*100:.1f}%',
        }
    except Exception as e:
        print(f'[og-image] Warning: {e}', file=sys.stderr)
        return {'record': '—', 'pnl': '—', 'avg_clv': '—', 'roi': '—'}


def gradient_rect(draw, x0, y0, x1, y1, c1, c2, vertical=True):
    """Draw a two-colour gradient rectangle."""
    steps = (y1 - y0) if vertical else (x1 - x0)
    for i in range(steps):
        t = i / max(steps - 1, 1)
        r = int(c1[0] + (c2[0] - c1[0]) * t)
        g = int(c1[1] + (c2[1] - c1[1]) * t)
        b = int(c1[2] + (c2[2] - c1[2]) * t)
        if vertical:
            draw.line([(x0, y0 + i), (x1, y0 + i)], fill=(r, g, b))
        else:
            draw.line([(x0 + i, y0), (x0 + i, y1)], fill=(r, g, b))


def rounded_rect(draw, x0, y0, x1, y1, r=12, fill=None, outline=None, width=1):
    """Draw a rounded rectangle."""
    if fill:
        draw.rectangle([x0 + r, y0, x1 - r, y1], fill=fill)
        draw.rectangle([x0, y0 + r, x1, y1 - r], fill=fill)
        draw.ellipse([x0, y0, x0 + 2*r, y0 + 2*r], fill=fill)
        draw.ellipse([x1 - 2*r, y0, x1, y0 + 2*r], fill=fill)
        draw.ellipse([x0, y1 - 2*r, x0 + 2*r, y1], fill=fill)
        draw.ellipse([x1 - 2*r, y1 - 2*r, x1, y1], fill=fill)
    if outline:
        draw.arc([x0, y0, x0 + 2*r, y0 + 2*r], 180, 270, fill=outline, width=width)
        draw.arc([x1 - 2*r, y0, x1, y0 + 2*r], 270, 360, fill=outline, width=width)
        draw.arc([x0, y1 - 2*r, x0 + 2*r, y1], 90, 180, fill=outline, width=width)
        draw.arc([x1 - 2*r, y1 - 2*r, x1, y1], 0, 90, fill=outline, width=width)
        draw.line([(x0 + r, y0), (x1 - r, y0)], fill=outline, width=width)
        draw.line([(x0 + r, y1), (x1 - r, y1)], fill=outline, width=width)
        draw.line([(x0, y0 + r), (x0, y1 - r)], fill=outline, width=width)
        draw.line([(x1, y0 + r), (x1, y1 - r)], fill=outline, width=width)


def generate(output_path=None):
    if output_path is None:
        output_path = os.path.join(SITE_DIR, 'og-image.png')

    stats = load_stats()
    W, H  = 1200, 630
    img   = Image.new('RGB', (W, H), BG_DARK)
    draw  = ImageDraw.Draw(img)

    # ── Background gradient ──────────────────────────────────────────────
    gradient_rect(draw, 0, 0, W, H, BG_DARK, BG_MID)

    # ── Accent bar (indigo → green) ──────────────────────────────────────
    gradient_rect(draw, 0, 0, W, 7, INDIGO, GREEN, vertical=False)

    # ── Fonts ────────────────────────────────────────────────────────────
    try:
        f_title    = ImageFont.truetype(ARIAL_BOLD,  52)
        f_tagline  = ImageFont.truetype(ARIAL,       21)
        f_stat_lbl = ImageFont.truetype(ARIAL_BOLD,  12)
        f_stat_val = ImageFont.truetype(GEORGIA,     38)
        f_desc     = ImageFont.truetype(ARIAL,       19)
        f_url      = ImageFont.truetype(ARIAL_BOLD,  18)
    except Exception:
        f_title = f_tagline = f_stat_lbl = f_stat_val = f_desc = f_url = ImageFont.load_default()

    # ── Title ────────────────────────────────────────────────────────────
    draw.text((80, 90),  '⚾ INDEPENDENT BASEBALL PROJECTIONS', font=f_title,   fill=TEXT_PRI)
    draw.text((80, 155), 'Quantitative Win Probability · Dual-Poisson Model',
              font=f_tagline, fill=TEXT_SEC)

    # ── Divider ──────────────────────────────────────────────────────────
    draw.line([(80, 198), (1120, 198)], fill=BORDER, width=1)

    # ── Stat boxes ───────────────────────────────────────────────────────
    boxes = [
        {'label': '2026 SEASON',  'value': stats['record'],  'color': TEXT_PRI},
        {'label': 'P&L UNITS',    'value': stats['pnl'],      'color': GREEN},
        {'label': 'AVG CLV',      'value': stats['avg_clv'],  'color': GREEN},
        {'label': 'SEASON ROI',   'value': stats['roi'],      'color': AMBER},
    ]

    box_w, box_h = 230, 115
    gap          = 20
    total_w      = len(boxes) * box_w + (len(boxes) - 1) * gap
    start_x      = 80
    box_y        = 220

    for i, box in enumerate(boxes):
        bx = start_x + i * (box_w + gap)
        # Background card
        rounded_rect(draw, bx, box_y, bx + box_w, box_y + box_h,
                     r=12, fill=BG_MID, outline=BORDER, width=1)
        # Label (centred)
        lbl = box['label']
        try:
            lw = draw.textlength(lbl, font=f_stat_lbl)
        except Exception:
            lw = len(lbl) * 7
        draw.text((bx + box_w/2 - lw/2, box_y + 16), lbl,
                  font=f_stat_lbl, fill=TEXT_MUT)
        # Value (centred)
        val = box['value']
        try:
            vw = draw.textlength(val, font=f_stat_val)
        except Exception:
            vw = len(val) * 22
        draw.text((bx + box_w/2 - vw/2, box_y + 54), val,
                  font=f_stat_val, fill=box['color'])

    # ── Description ──────────────────────────────────────────────────────
    draw.text((80, 372),
              'Daily MLB value bets · Edge vs. no-vig Pinnacle · Half-Kelly sizing · CLV tracked',
              font=f_desc, fill=TEXT_SEC)

    # ── URL ──────────────────────────────────────────────────────────────
    draw.text((80, 575),
              'bartelbradley-coder.github.io/fairline-mlb',
              font=f_url, fill=INDIGO)

    # ── Baseball decoration (right side) ─────────────────────────────────
    cx, cy, cr = 1100, 400, 110
    draw.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], outline=BORDER, width=2)
    draw.ellipse([cx - 80, cy - 80, cx + 80, cy + 80], outline=(30, 58, 95), width=1)
    try:
        f_ball = ImageFont.truetype(ARIAL, 90)
        draw.text((cx - 45, cy - 50), '⚾', font=f_ball, fill=(30, 41, 59))
    except Exception:
        pass

    img.save(output_path, 'PNG', optimize=True)
    print(f'[og-image] Saved {output_path}')
    return output_path


if __name__ == '__main__':
    generate()
