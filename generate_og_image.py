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
ARIAL_BLACK = '/System/Library/Fonts/Supplemental/Arial Black.ttf'

# Palette (matches the live site)
BG_DARK   = (15,  23,  42)
BG_MID    = (30,  41,  59)
BORDER    = (51,  65,  85)
TEXT_PRI  = (241, 245, 249)
TEXT_SEC  = (148, 163, 184)
TEXT_MUT  = (100, 116, 139)
GREEN     = (34,  197, 94)
AMBER     = (245, 158, 11)
INDIGO    = (99,  102, 241)
INDIGO_LT = (129, 140, 248)
BLUE      = (96,  165, 250)   # the "P" in the IBP mark


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
            'record':  f'{wins}-{losses}',
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


def _quad(p0, p1, p2, steps=28):
    """Sample a quadratic bezier into a polyline (for the baseball stitches)."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u*u*p0[0] + 2*u*t*p1[0] + t*t*p2[0]
        y = u*u*p0[1] + 2*u*t*p1[1] + t*t*p2[1]
        pts.append((x, y))
    return pts


def draw_badge(size, alpha=255):
    """Render the IBP circular mark (matches the site nav logo) at `size` px.

    Coordinates follow the site SVG viewBox of 88×88, scaled to `size`.
    Returns an RGBA image; `alpha` (0-255) scales overall opacity for watermarks.
    """
    S  = size
    sc = S / 88.0
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d  = ImageDraw.Draw(im)
    def P(x, y): return (x * sc, y * sc)
    def A(a):    return int(a * alpha / 255)
    lw_ring   = max(1, round(1.8 * sc))
    lw_stitch = max(1, round(1.5 * sc))
    lw_bat    = max(1, round(2.5 * sc))

    # Faint indigo fill + white ring
    d.ellipse([P(12, 12), P(76, 76)], fill=(99, 102, 241, A(26)))
    d.ellipse([P(12, 12), P(76, 76)], outline=(255, 255, 255, A(210)), width=lw_ring)

    # Baseball stitches (two mirrored chained quadratics)
    left  = _quad((18, 26), (26, 34), (19, 44)) + _quad((19, 44), (13, 54), (20, 62))
    right = _quad((70, 26), (62, 34), (69, 44)) + _quad((69, 44), (75, 54), (68, 62))
    d.line([P(*pt) for pt in left],  fill=(255, 255, 255, A(77)), width=lw_stitch, joint='curve')
    d.line([P(*pt) for pt in right], fill=(255, 255, 255, A(77)), width=lw_stitch, joint='curve')

    # IBP monogram (baseline anchored, matching the SVG text y=52)
    try:
        f_mono = ImageFont.truetype(ARIAL_BLACK, round(20 * sc))
        d.text(P(18, 53), 'IB', font=f_mono, fill=(255, 255, 255, A(255)), anchor='ls')
        ib_w = d.textlength('IB', font=f_mono)
        d.text((P(18, 53)[0] + ib_w + 2 * sc, P(18, 53)[1]), 'P',
               font=f_mono, fill=(BLUE[0], BLUE[1], BLUE[2], A(255)), anchor='ls')
    except Exception:
        pass

    # Green bat + ball accent
    d.line([P(56, 60), P(64, 50)], fill=(34, 197, 94, A(255)), width=lw_bat)
    d.ellipse([P(64 - 3.3, 50 - 3.3), P(64 + 3.3, 50 + 3.3)], fill=(34, 197, 94, A(255)))
    return im


def generate(output_path=None):
    if output_path is None:
        output_path = os.path.join(SITE_DIR, 'og-image.png')

    stats = load_stats()
    W, H  = 1200, 630
    img   = Image.new('RGB', (W, H), BG_DARK)
    draw  = ImageDraw.Draw(img)

    # ── Background gradient + top accent bar ─────────────────────────────
    gradient_rect(draw, 0, 0, W, H, BG_DARK, BG_MID)
    gradient_rect(draw, 0, 0, W, 7, INDIGO, GREEN, vertical=False)

    # ── Faint badge watermark (right side) ───────────────────────────────
    wm = draw_badge(360, alpha=30)
    img.paste(wm, (855, 210), wm)

    # ── Fonts ────────────────────────────────────────────────────────────
    try:
        f_word1    = ImageFont.truetype(ARIAL_BOLD,  33)   # "INDEPENDENT BASEBALL"
        f_word2    = ImageFont.truetype(ARIAL_BLACK, 33)   # "PROJECTIONS"
        f_tagline  = ImageFont.truetype(ARIAL,       21)
        f_stat_lbl = ImageFont.truetype(ARIAL_BOLD,  13)
        f_stat_val = ImageFont.truetype(ARIAL_BLACK, 36)
        f_desc     = ImageFont.truetype(ARIAL,       19)
        f_url      = ImageFont.truetype(ARIAL_BOLD,  19)
    except Exception:
        f_word1 = f_word2 = f_tagline = f_stat_lbl = f_stat_val = f_desc = f_url = ImageFont.load_default()

    # ── Logo badge + two-tone wordmark ───────────────────────────────────
    badge = draw_badge(96)
    img.paste(badge, (80, 66), badge)

    wx, wy = 200, 100   # wordmark baseline
    draw.text((wx, wy), 'INDEPENDENT BASEBALL ', font=f_word1, fill=TEXT_SEC, anchor='ls')
    w1 = draw.textlength('INDEPENDENT BASEBALL ', font=f_word1)
    draw.text((wx + w1, wy), 'PROJECTIONS', font=f_word2, fill=TEXT_PRI, anchor='ls')

    draw.text((80, 175), 'Quantitative Win Probability · Dual-Poisson Model',
              font=f_tagline, fill=TEXT_SEC)

    # ── Divider ──────────────────────────────────────────────────────────
    draw.line([(80, 212), (1120, 212)], fill=BORDER, width=1)

    # ── Stat boxes ───────────────────────────────────────────────────────
    boxes = [
        {'label': '2026 RECORD', 'value': stats['record'],  'color': TEXT_PRI},
        {'label': 'P&L UNITS',   'value': stats['pnl'],      'color': GREEN},
        # AVG CLV tile removed (operator decision 2026-07-10): public CLV is
        # suppressed pending close-provenance validation.
        {'label': 'ROI / BET',   'value': stats['roi'],      'color': AMBER},
    ]

    box_w, box_h = 230, 118
    gap          = 20
    start_x      = 80
    box_y        = 240

    for i, box in enumerate(boxes):
        bx = start_x + i * (box_w + gap)
        rounded_rect(draw, bx, box_y, bx + box_w, box_y + box_h,
                     r=14, fill=BG_MID, outline=BORDER, width=1)
        lbl = box['label']
        lw  = draw.textlength(lbl, font=f_stat_lbl)
        draw.text((bx + box_w/2 - lw/2, box_y + 20), lbl, font=f_stat_lbl, fill=TEXT_MUT)
        val = box['value']
        vw  = draw.textlength(val, font=f_stat_val)
        draw.text((bx + box_w/2 - vw/2, box_y + 52), val, font=f_stat_val, fill=box['color'])

    # ── Description ──────────────────────────────────────────────────────
    draw.text((80, 405),
              'Daily MLB model picks · Model vs. no-vig market · Fractional-Kelly sizing · Every result graded',
              font=f_desc, fill=TEXT_SEC)

    # ── URL ──────────────────────────────────────────────────────────────
    draw.text((80, 575), 'independentbaseballprojections.net', font=f_url, fill=INDIGO_LT)

    img.save(output_path, 'PNG', optimize=True)
    print(f'[og-image] Saved {output_path}')
    return output_path


if __name__ == '__main__':
    generate()
