"""Draw the marketplace's own imagery — hero background and section banners.

Shipped as static files in public/ rather than uploaded to the media bucket. These belong to the
product, not to any shop: they must render on the landing page before a single query runs, they
never change per tenant, and serving them from the app's own origin means Vercel's edge cache
handles them and there is no storage round-trip on the first paint anyone ever sees.

Drawn rather than photographed, for the same reason as the product art: stock photography of a
Nigerian market that we have no licence to would be a rights problem shipped to production. These
are abstract enough to be honest and specific enough to feel like this market rather than a
generic SaaS gradient.

Everything is composed dark-to-light bottom-up so that white text placed over the hero clears AAA
contrast without depending on the scrim alone — the scrim is a second line of defence, not the
only one.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pngdraw import Canvas  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "public")

TEAL_DEEP = (5, 46, 39)
TEAL = (11, 98, 82)
TEAL_LIGHT = (24, 138, 116)
GOLD = (214, 149, 62)
CLAY = (166, 86, 48)


def sky(c, w, h):
    """Dusk over the market: teal above, warm at the horizon."""
    horizon = int(h * 0.62)
    c.vgrad(0, 0, w, horizon, TEAL_DEEP, (168, 116, 66))
    # A low sun, sitting just above the roofline so the silhouettes read against it.
    sx, sy = w * 0.72, horizon - h * 0.30
    c.ellipse(sx, sy, h * 0.30, h * 0.30, GOLD, alpha=0.28)
    c.ellipse(sx, sy, h * 0.15, h * 0.15, (240, 198, 122), alpha=0.52)
    c.ellipse(sx, sy, h * 0.06, h * 0.06, (252, 232, 186), alpha=0.85)
    return horizon


def shop_row(c, w, base, colour, alpha=1.0):
    """A row of lock-up shops with awnings — the silhouette of every market street here."""
    x = -40
    i = 0
    while x < w + 40:
        width = 150 + (i * 37) % 110
        height = 90 + (i * 53) % 70
        top = base - height
        c.poly([(x, base), (x, top), (x + width, top), (x + width, base)], colour, alpha)
        # Awning: a slab pitched out over the front, the thing that makes it a shop and not a box.
        c.poly(
            [(x - 14, top + 26), (x + width + 14, top + 26),
             (x + width + 2, top + 8), (x - 2, top + 8)],
            colour, alpha,
        )
        i += 1
        x += width + 16


def crates(c, w, h):
    """Foreground stack — the darkest layer, anchoring the composition."""
    base = h
    dark = (2, 24, 20)
    x = -30
    i = 0
    while x < w + 30:
        cols = 2 + (i % 3)
        for row in range(cols):
            cw, ch = 137, 54
            y = base - (row + 1) * (ch + 5)
            c.rect(x, y, cw, ch, dark)
            for slot in range(4):
                c.ellipse(x + 22 + slot * 30, y + ch / 2, 10, 10, (8, 52, 44))
        i += 1
        x += 137


def hero(w=1400, h=800):
    c = Canvas(w, h, TEAL_DEEP)
    horizon = sky(c, w, h)
    shop_row(c, w, horizon + 40, (9, 74, 62), 0.85)
    # Ground plane BEFORE the near row and the crates. Without it the sky shows through every gap
    # between one crate stack and the next, and the whole foreground reads as floating cut-outs.
    c.rect(0, horizon + 120, w, h - horizon - 120, (5, 44, 37))
    shop_row(c, w, horizon + 120, (7, 62, 52), 1.0)
    crates(c, w, h)
    # On a phone the headline sits low, over the busiest part of the drawing. Darkening the
    # foot on a ramp guarantees the contrast there independently of the CSS scrim.
    c.veil(0, h * 0.62, w, h * 0.38, TEAL_DEEP, start=0.0, end=0.86)
    return c


def band(w=1400, h=260, left=TEAL, right=TEAL_LIGHT, accent=GOLD):
    """A generic section banner: goods on a shelf, abstracted to shape and colour.

    Drawn WIDE AND SHORT — roughly the 9:1 the banner actually renders at — because the first
    version was 1400x420 and `background-size: cover` threw away the top and bottom of it. What
    survived the crop was a band of abstract stripes: the goods were there in the file and never
    once reached a screen. Art has to be drawn for the box it lands in.

    The left third is deliberately kept clear. The section title sits there, and a title over a
    row of drawn bottles is unreadable no matter how heavy the scrim is.

    One drawing reused across sections with different palettes, rather than a bespoke picture per
    section — sections get added and renamed constantly, and art that has to be commissioned per
    section is art that stops being made after the third one.
    """
    c = Canvas(w, h, left)
    c.hgrad(0, 0, w, h, left, right)
    shelf = h - 34
    c.rect(0, shelf, w, 12, tuple(max(0, v - 30) for v in right))

    clear = int(w * 0.34)                       # the title's space
    x = clear
    i = 0
    while x < w - 40:
        kind = i % 4
        col = [accent, (245, 245, 242), CLAY, (255, 255, 255)][kind]
        # Fade in across the first few items so the artwork emerges from the title area rather
        # than starting abruptly at a hard edge.
        ramp = min(1.0, (x - clear) / (w * 0.18))
        alpha = (0.92 if kind % 2 == 0 else 0.78) * ramp
        if kind in (0, 3):                                          # bottle
            bh = 120 + (i * 29) % 48
            c.rect(x + 20, shelf - bh, 40, bh, col, radius=9, alpha=alpha)
            c.rect(x + 32, shelf - bh - 20, 16, 20, col, alpha=alpha)
            c.ellipse(x + 40, shelf - bh - 24, 11, 7, col, alpha=alpha)
        elif kind == 1:                                             # sack of bulk goods
            c.poly([(x + 6, shelf), (x + 18, shelf - 108),
                    (x + 64, shelf - 108), (x + 76, shelf)], col, alpha)
        else:                                                       # carton
            c.rect(x + 8, shelf - 96, 70, 96, col, radius=6, alpha=alpha)
            c.rect(x + 8, shelf - 58, 70, 9,
                   tuple(max(0, v - 40) for v in col), alpha=alpha)
        i += 1
        x += 104
    return c


def main():
    os.makedirs(OUT, exist_ok=True)
    jobs = [
        ("hero.png", hero()),
        ("band-shops.png", band()),
        ("band-products.png", band(left=(23, 62, 92), right=(48, 108, 148), accent=(242, 201, 108))),
        ("band-categories.png", band(left=(92, 48, 23), right=(148, 92, 48), accent=(246, 224, 176))),
    ]
    for name, canvas in jobs:
        data = canvas.to_png()
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(data)
        print("  {}  {:.0f} KB".format(name, len(data) / 1024))


if __name__ == "__main__":
    main()
