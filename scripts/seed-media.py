"""Generate and upload product/shop imagery for the sample shop.

These are drawn, not photographed: a real shop supplies its own photos, and shipping stock
photography of branded goods we have no rights to would be the wrong kind of shortcut. What this
produces is honest placeholder art — a recognisable silhouette per product type, on the same
white ground that the upload pipeline normalises real photographs to, so a half-photographed
catalogue still looks like one catalogue.

PNG, not SVG. The first version of this uploaded SVG and the bucket refused it, because SVG can
carry script and a PUBLIC bucket serving user-uploaded SVG is a cross-site-scripting vector
pointed at every shopper. Widening the allowed MIME types would have made the seed work by
removing a real defence, so the seed changed instead. pngdraw.py writes the PNGs with nothing but
the standard library.
"""
import io
import json
import os
import sys
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pngdraw import Canvas  # noqa: E402

REF = "zinhzpgprhhqmyxmchhm"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def env(name):
    for line in io.open(os.path.join(HERE, ".env.local"), encoding="utf-8"):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


def run_sql(query):
    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/{}/database/query".format(REF),
        data=json.dumps({"query": query}).encode(),
        headers={
            "Authorization": "Bearer {}".format(env("SUPABASE_ACCESS_TOKEN")),
            "User-Agent": "curl/8.4.0",
            "Content-Type": "application/json",
            "Accept": "*/*",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = r.read().decode()
            return json.loads(body) if body.strip() else []
    except urllib.error.HTTPError as e:
        sys.exit("sql failed: {} {}".format(e.code, e.read().decode()[:500]))


_service_key = None


def service_key():
    """Fetch the service key from the Management API, in memory only.

    A seed writes on behalf of the operator, not a signed-in shop, so it needs a key that is not
    subject to the storage RLS policies — the anon key is correctly refused, because anon is not
    a member of any store.

    Deliberately NOT read from .env.local and never written there. The service key bypasses RLS
    entirely; the fewer places it is at rest, the better. The management token is already present
    and already carries more authority than this, so nothing is widened by asking it.
    """
    global _service_key
    if _service_key:
        return _service_key

    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/{}/api-keys".format(REF),
        headers={"Authorization": "Bearer {}".format(env("SUPABASE_ACCESS_TOKEN")),
                 "User-Agent": "curl/8.4.0", "Accept": "*/*"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        for k in json.loads(r.read().decode()):
            if k.get("name") == "service_role":
                _service_key = k.get("api_key")
                return _service_key
    sys.exit("could not obtain a service key")


def upload(path, data):
    """Upload a PNG to the media bucket."""
    key = service_key()
    req = urllib.request.Request(
        "{}/storage/v1/object/media/{}".format(env("NEXT_PUBLIC_SUPABASE_URL"), path),
        data=data,
        headers={
            "Authorization": "Bearer {}".format(key),
            "apikey": key,
            "Content-Type": "image/png",
            "x-upsert": "true",
            # Five minutes, not the default hour. These files are re-uploaded to the SAME path
            # every time the drawings are tweaked, so a long TTL means the CDN keeps serving the
            # previous version and the change appears not to have worked. Real uploads from the
            # app get a year, because they are written to a fresh path each time and can never
            # go stale.
            "Cache-Control": "max-age=300",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            r.read()
        return True
    except urllib.error.HTTPError as e:
        print("  upload failed {}: {} {}".format(path, e.code, e.read().decode()[:200]))
        return False


# ── Drawings ────────────────────────────────────────────────────────────────────────
#
# WHITE backgrounds, always. Catalogue photography is shot on white for a reason that has nothing
# to do with taste: a grid of items on assorted backgrounds reads as a grid of assorted PICTURES,
# and the eye stops comparing the goods and starts comparing the photos. White removes the
# variable. It also means these placeholders sit correctly beside a real photo that has been
# through the upload pipeline, which normalises to white too — so a shop that photographs half its
# catalogue does not end up with two visibly different catalogues.
#
# Geometry only, no lettering. Drawing type without a font engine looks worse than not drawing it,
# and at the size a phone grid actually shows these, a clean silhouette in the right colour reads
# faster than a tiny word would.

W, H = 600, 600          # square, matching what the upload pipeline emits


def _base():
    """A white field with a soft contact shadow where the item will stand."""
    c = Canvas(W, H, (255, 255, 255))
    c.shadow(W // 2, 500, 150, 24, alpha=0.20)
    return c


def _shade(rgb, amount):
    return tuple(max(0, min(255, v + amount)) for v in rgb)


def bottle(body, cap, tall=True):
    c = _base()
    height = 280 if tall else 235
    top = 480 - height
    c.rect(284, top - 52, 32, 28, cap)                        # neck
    c.rect(268, top - 36, 64, 32, cap, radius=9)              # cap
    # Lit from the left, so the cylinder reads as round rather than as a flat bar.
    c.hgrad(241, top, 118, height, _shade(body, 46), _shade(body, -42))
    # The label overhangs the body slightly, the way a wrapped paper label actually does. Inset it
    # instead and the bottle reads as a coloured stick with a stripe on it.
    c.rect(235, top + height * 0.30, 130, 100, (252, 252, 250), radius=8)
    c.rect(235, top + height * 0.30 + 42, 130, 14, body)
    return c


def can(body):
    c = _base()
    c.hgrad(246, 180, 108, 270, _shade(body, 40), _shade(body, -38))
    c.ellipse(300, 180, 54, 16, (206, 212, 212))
    c.ellipse(300, 450, 54, 14, _shade(body, -55))
    c.rect(246, 270, 108, 72, (252, 252, 250))
    c.rect(246, 300, 108, 14, body)
    return c


def crate(bottle_rgb):
    c = _base()
    c.rect(110, 230, 380, 220, (178, 59, 59), radius=16)
    c.rect(110, 230, 380, 38, (143, 44, 44), radius=16)
    for row in range(2):
        for col in range(4):
            c.ellipse(168 + col * 92, 320 + row * 72, 28, 28, bottle_rgb)
            c.ellipse(168 + col * 92, 313 + row * 72, 14, 14, _shade(bottle_rgb, 52))
    return c


def sachet(body):
    """A sealed water sachet — crimped top and bottom, which is what makes it recognisable."""
    c = _base()
    c.poly([(200, 200), (400, 200), (386, 470), (214, 470)], _shade(body, 24))
    c.rect(196, 186, 208, 22, _shade(body, -30), radius=6)
    c.rect(210, 462, 180, 20, _shade(body, -30), radius=6)
    c.rect(232, 290, 136, 76, (252, 252, 250), radius=6)
    return c


def carton(body):
    """A box of goods — the shape almost anything non-liquid ships in."""
    c = _base()
    c.rect(150, 220, 300, 250, _shade(body, 12), radius=8)
    # A pale top face, so it reads as a three-dimensional box rather than a coloured rectangle.
    c.poly([(150, 220), (210, 168), (510, 168), (450, 220)], _shade(body, 58))
    c.poly([(450, 220), (510, 168), (510, 418), (450, 470)], _shade(body, -34))
    c.rect(150, 320, 300, 26, (252, 252, 250))
    return c


def garment(body):
    """A folded shirt. This is a general point-of-sale tool, not a drinks ledger — a catalogue
    that can only draw bottles quietly tells every clothing shop the product is not for them."""
    c = _base()
    c.poly([(190, 250), (245, 205), (355, 205), (410, 250),
            (410, 300), (368, 300), (368, 460), (232, 460), (232, 300), (190, 300)],
           _shade(body, 18))
    c.poly([(268, 205), (332, 205), (300, 250)], (252, 252, 250))   # collar
    c.rect(232, 380, 136, 12, _shade(body, -40))
    return c


def bag(body):
    """A sack of bulk goods — rice, garri, cement: sold by weight, not by the piece."""
    c = _base()
    c.poly([(180, 470), (206, 230), (394, 230), (420, 470)], _shade(body, 14))
    c.rect(196, 206, 208, 34, _shade(body, -26), radius=10)
    c.ellipse(300, 350, 78, 52, (252, 252, 250), alpha=0.95)
    return c


def art_for(name):
    """Return the drawings for a product, chosen by what it plainly is.

    Ordered most-specific first: "sachet water" must not be caught by the "water" rule, and
    "malta guinness" must not be caught by "guinness"/bottle before the can rule sees it.
    """
    lowered = name.lower()
    rules = [
        (("sachet", "pure water"), lambda: [sachet((150, 196, 222)), sachet((176, 212, 232))]),
        (("coca", "cola", "coke"), lambda: [bottle((200, 52, 44), (143, 36, 32)),
                                            crate((200, 52, 44))]),
        (("malta", "can", "tin"), lambda: [can((107, 63, 29)), can((138, 84, 38))]),
        (("water", "eva", "table"), lambda: [bottle((127, 183, 216), (77, 144, 184)),
                                             carton((168, 208, 230))]),
        (("star", "gulder", "trophy", "stout", "beer"),
         lambda: [crate((47, 125, 58)), bottle((47, 125, 58), (31, 88, 39), tall=False)]),
        (("shirt", "cloth", "wear", "dress", "trouser", "fabric"),
         lambda: [garment((36, 84, 132)), garment((132, 46, 72))]),
        (("rice", "garri", "beans", "flour", "sugar", "cement", "bag", "kg"),
         lambda: [bag((214, 196, 154)), bag((196, 172, 128))]),
        (("carton", "box", "pack"), lambda: [carton((196, 148, 84))]),
    ]
    for words, make in rules:
        if any(w in lowered for w in words):
            return make()
    # Nothing matched: a plain carton in the brand colour. Every shop sells something we have no
    # silhouette for, and that case has to look deliberate rather than broken.
    return [carton((11, 98, 82))]


def shopfront():
    """The shop's own cover — NOT on white. This one is a scene, not a product.

    Redrawn once because the first version was a teal field with pale rectangles scattered over
    it, which was meant to read as a lit shopfront and read instead as a loading error. A cover
    photo is the first thing a shopper sees of a shop, and "looks broken" is the one thing it
    cannot afford to be. This is literal instead: wall, striped awning, open shutter, a sign, and
    goods stacked out front.
    """
    W2, H2 = 960, 540
    c = Canvas(W2, H2, (222, 232, 229))

    c.vgrad(0, 0, W2, 300, (196, 218, 226), (232, 238, 232))       # sky
    c.rect(0, 300, W2, H2 - 300, (214, 208, 196))                  # street

    wall_top = 90
    c.rect(80, wall_top, 800, 330, (238, 236, 228))                # facade
    c.rect(80, wall_top, 800, 8, (206, 202, 190))

    # Sign board.
    c.rect(140, wall_top + 26, 680, 74, (11, 98, 82), radius=8)
    c.rect(176, wall_top + 52, 420, 22, (206, 232, 224), radius=6)   # the shop's name, abstracted
    c.rect(176, wall_top + 82, 250, 10, (143, 203, 190), radius=5)

    # Striped awning, pitched out over the front.
    awn_top = wall_top + 112
    stripe_w = 62
    for i in range(13):
        x0 = 116 + i * stripe_w
        colour = (196, 62, 54) if i % 2 == 0 else (246, 244, 238)
        c.poly([(x0 + 12, awn_top), (x0 + stripe_w + 12, awn_top),
                (x0 + stripe_w, awn_top + 62), (x0, awn_top + 62)], colour)
    c.rect(110, awn_top + 58, 756, 10, (150, 44, 38), radius=5)

    # Open shutter: the dark interior with lit shelves, which is what says "open for business".
    shop_top = awn_top + 84
    c.rect(180, shop_top, 600, 208, (38, 46, 46), radius=6)
    c.rect(180, shop_top, 600, 16, (94, 100, 98), radius=6)          # rolled-up shutter
    for row in range(3):
        y = shop_top + 48 + row * 54
        c.rect(206, y + 30, 548, 8, (86, 92, 90))                    # shelf
        for col in range(9):
            x = 216 + col * 60
            if (row + col) % 3 == 0:
                c.rect(x, y, 34, 30, (214, 158, 70), radius=4)
            elif (row + col) % 3 == 1:
                c.rect(x, y + 6, 30, 24, (206, 230, 224), radius=4)
            else:
                c.rect(x, y + 2, 32, 28, (178, 72, 62), radius=4)

    # Goods stacked outside, either side of the door.
    for side, base_x in ((0, 92), (1, 792)):
        for row in range(3 if side == 0 else 2):
            y = 400 - row * 44
            c.rect(base_x, y, 78, 40, (178, 59, 59), radius=6)
            for slot in range(3):
                c.ellipse(base_x + 16 + slot * 23, y + 20, 8, 8, (47, 125, 58))

    c.shadow(W2 // 2, 424, 330, 18, alpha=0.16)
    return c


def main():
    store = run_sql(
        "select id::text, name from public.stores where name = 'ASHABI GLOBAL RESOURCES'"
    )
    if not store:
        sys.exit("sample store not found — run seed-sample-store.py first")

    store_id = store[0]["id"]

    print("shop cover:")
    cover = "{}/store/cover.png".format(store_id)
    if upload(cover, shopfront().to_png()):
        run_sql(
            "insert into public.store_media (store_id, kind, path, alt, sort_order) "
            "select '{sid}', 'image', '{p}', 'Shopfront', 0 "
            "where not exists (select 1 from public.store_media where path = '{p}')".format(
                sid=store_id, p=cover
            )
        )
        print("  uploaded")

    products = run_sql(
        "select id::text, name from public.products where store_id = '{}' order by name".format(
            store_id
        )
    )

    print("product images:")
    for prod in products:
        drawings = art_for(prod["name"])
        ok = 0
        for i, art in enumerate(drawings):
            path = "{}/products/{}-{}.png".format(store_id, prod["id"], i)
            if not upload(path, art.to_png()):
                continue
            ok += 1
            run_sql(
                "insert into public.product_media (product_id, kind, path, alt, sort_order) "
                "select '{pid}', 'image', '{p}', '{alt}', {i} "
                "where not exists (select 1 from public.product_media where path = '{p}')".format(
                    pid=prod["id"], p=path,
                    alt=prod["name"].replace("'", "''"), i=i,
                )
            )
        print("  {} ({} images)".format(prod["name"], ok))

    total = run_sql(
        "select (select count(*) from public.product_media) as products, "
        "(select count(*) from public.store_media) as stores"
    )
    print("\nmedia rows: {} product, {} shop".format(total[0]["products"], total[0]["stores"]))


if __name__ == "__main__":
    main()
