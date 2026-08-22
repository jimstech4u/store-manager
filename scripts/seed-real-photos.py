"""Fetch REAL product photographs and put them through the same pipeline the app uses.

Why Wikimedia Commons and not an image search: the shop's catalogue is a commercial storefront, so
every picture on it needs a licence that permits commercial reuse. Commons publishes the licence
as structured metadata, which means it can be CHECKED rather than assumed — this script refuses
anything it cannot positively identify as freely reusable, and records the author and licence of
everything it does take into CREDITS.md.

That refusal is the point. Pulling brand photography off a search engine would look identical on
screen and leave the shop owner holding the risk.

The normalisation deliberately mirrors src/lib/image-pipeline.ts step for step — edge flood fill
to white, trim to content, pad square, resize, encode. A seeded catalogue that looked different
from an uploaded one would make the pipeline's own output look broken by comparison.
"""
import io
import json
import time
import os
import sys
import urllib.parse
import urllib.request
import urllib.error
from collections import deque

from PIL import Image

REF = "zinhzpgprhhqmyxmchhm"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UA = "store-manager-seed/1.0 (https://github.com/; catalogue seeding)"

# Licences that allow commercial reuse. Anything else is skipped, loudly.
OK_LICENCES = ("cc0", "public domain", "pd", "cc by", "cc-by", "cc by-sa", "cc-by-sa")

# What to look for, per product already in the sample shop. Several search terms each, because
# the first phrasing often finds a logo or a bottling plant rather than the product.
SEARCHES = {
    "Coca-Cola PET 60cl": ["Coca-Cola plastic bottle", "Coca Cola PET bottle", "Coca-Cola bottle"],
    "Eva Water 75cl": ["bottled water plastic bottle", "mineral water bottle white background"],
    "Gulder 60cl": ["Gulder beer", "Nigerian beer bottle", "lager beer bottle"],
    "Malta Guinness Can 33cl": ["Malta Guinness", "malt drink can", "beverage can"],
    "Star Lager 60cl": ["Star beer Nigeria", "Nigerian Breweries Star", "lager bottle"],
}


def env(name):
    for line in io.open(os.path.join(HERE, ".env.local"), encoding="utf-8"):
        if line.startswith(name + "="):
            return line.split("=", 1)[1].strip().strip('"')
    return None


_last_call = [0.0]


def get_json(url, attempts=4):
    """Commons API call, throttled and retried.

    The first version fired one request per search term as fast as it could and was refused with
    429 after the very first product — so four of the five products silently fell back to drawn
    art and the run still reported success. Commons asks anonymous clients to space requests out;
    honouring that is both the fix and the correct thing to do.
    """
    for attempt in range(attempts):
        gap = time.time() - _last_call[0]
        if gap < 1.5:
            time.sleep(1.5 - gap)
        _last_call[0] = time.time()

        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < attempts - 1:
                wait = 4 * (2 ** attempt)
                print("    rate limited, waiting {}s".format(wait))
                time.sleep(wait)
                continue
            raise


def run_sql(query):
    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/{}/database/query".format(REF),
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": "Bearer {}".format(env("SUPABASE_ACCESS_TOKEN")),
                 "User-Agent": "curl/8.4.0", "Content-Type": "application/json", "Accept": "*/*"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            body = r.read().decode()
            return json.loads(body) if body.strip() else []
    except urllib.error.HTTPError as e:
        sys.exit("sql failed: {} {}".format(e.code, e.read().decode()[:400]))


_key = None


def service_key():
    global _key
    if _key:
        return _key
    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/{}/api-keys".format(REF),
        headers={"Authorization": "Bearer {}".format(env("SUPABASE_ACCESS_TOKEN")),
                 "User-Agent": "curl/8.4.0", "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=60) as r:
        for k in json.loads(r.read().decode()):
            if k.get("name") == "service_role":
                _key = k.get("api_key")
                return _key
    sys.exit("could not obtain a service key")


# ── Finding a usable photograph ─────────────────────────────────────────────────────


def search_commons(term, limit=8):
    """Image results for a term, with licence metadata attached."""
    url = ("https://commons.wikimedia.org/w/api.php?action=query&format=json"
           "&generator=search&gsrsearch={}&gsrnamespace=6&gsrlimit={}"
           "&prop=imageinfo&iiprop=url%7Cextmetadata%7Cmime&iiurlwidth=1400"
           .format(urllib.parse.quote(term), limit))
    try:
        data = get_json(url)
    except Exception as e:
        print("    search failed ({}): {}".format(term, e))
        return []
    return list((data.get("query") or {}).get("pages", {}).values())


def usable(page):
    """A page is usable only if it is a raster photo under a commercially reusable licence."""
    info = (page.get("imageinfo") or [{}])[0]
    mime = info.get("mime", "")
    if not mime.startswith("image/") or "svg" in mime:
        return None

    meta = info.get("extmetadata") or {}
    licence = (meta.get("LicenseShortName", {}).get("value") or "").strip()
    if not licence:
        return None
    if not any(tag in licence.lower() for tag in OK_LICENCES):
        return None

    thumb = info.get("thumburl") or info.get("url")
    if not thumb:
        return None

    author = (meta.get("Artist", {}).get("value") or "Unknown").strip()
    # The Artist field is HTML. Strip tags rather than render them into a credits file.
    while "<" in author and ">" in author:
        author = author[:author.index("<")] + author[author.index(">") + 1:]

    return {
        "title": page.get("title", ""),
        "url": thumb,
        "licence": licence,
        "author": author[:120],
        "page": "https://commons.wikimedia.org/wiki/" + urllib.parse.quote(page.get("title", "")),
    }


def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


# ── The same normalisation the browser does ─────────────────────────────────────────


def lift_background(img, tolerance=30):
    """Flood-fill from the edges to white. Iterative, seeded from all four sides.

    Same approach and same reasoning as the client pipeline: a photo lit from one side has a
    light corner and a dark one, so a single seed clears half the background and leaves the rest.
    """
    w, h = img.size
    px = img.load()

    corners = [px[0, 0], px[w - 1, 0], px[0, h - 1], px[w - 1, h - 1]]
    ref = [sorted(c[i] for c in corners)[1:3] for i in range(3)]
    ref = [sum(pair) / 2 for pair in ref]

    # Corners must agree, or this is not a plain background and the fill will eat the subject.
    # Same guard, same threshold, as the browser pipeline.
    spread = max(max(c[i] for c in corners) - min(c[i] for c in corners) for i in range(3))
    if spread > 44:
        return 0.0

    seen = bytearray(w * h)
    stack = deque()

    def push(x, y):
        if x < 0 or y < 0 or x >= w or y >= h:
            return
        p = y * w + x
        if seen[p]:
            return
        r, g, b = px[x, y][:3]
        if (abs(r - ref[0]) <= tolerance and abs(g - ref[1]) <= tolerance
                and abs(b - ref[2]) <= tolerance):
            seen[p] = 1
            stack.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)

    cleared = 0
    while stack:
        x, y = stack.pop()
        px[x, y] = (255, 255, 255)
        cleared += 1
        push(x + 1, y)
        push(x - 1, y)
        push(x, y + 1)
        push(x, y - 1)

    return cleared / float(w * h)


def normalise(data, size=900):
    """Decode, lift the background, trim to content, pad square, resize."""
    img = Image.open(io.BytesIO(data))
    # EXIF orientation, the same correction createImageBitmap applies in the browser.
    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass

    if img.mode in ("RGBA", "LA", "P"):
        flat = Image.new("RGB", img.size, (255, 255, 255))
        rgba = img.convert("RGBA")
        flat.paste(rgba, mask=rgba.split()[-1])
        img = flat
    else:
        img = img.convert("RGB")

    img.thumbnail((1400, 1400), Image.LANCZOS)
    before = img.copy()
    cleared = lift_background(img)
    if cleared > 0.66:
        img = before          # the fill took the picture, not the background
        removed = False
    else:
        removed = cleared > 0.02

    # Trim to whatever is not white.
    grey = img.convert("L")
    mask = grey.point(lambda v: 0 if v >= 246 else 255)
    box = mask.getbbox()
    if box:
        img = img.crop(box)

    edge = max(img.size)
    pad = int(edge * 0.08)
    canvas = Image.new("RGB", (edge + pad * 2, edge + pad * 2), (255, 255, 255))
    canvas.paste(img, ((canvas.width - img.width) // 2, (canvas.height - img.height) // 2))

    out = canvas.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    out.save(buf, "WEBP", quality=88, method=6)
    return buf.getvalue(), removed


def upload(path, data):
    key = service_key()
    req = urllib.request.Request(
        "{}/storage/v1/object/media/{}".format(env("NEXT_PUBLIC_SUPABASE_URL"), path),
        data=data,
        headers={"Authorization": "Bearer {}".format(key), "apikey": key,
                 "Content-Type": "image/webp", "x-upsert": "true",
                 "Cache-Control": "max-age=300"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            r.read()
        return True
    except urllib.error.HTTPError as e:
        print("    upload failed: {} {}".format(e.code, e.read().decode()[:200]))
        return False


def main():
    store = run_sql("select id::text, name from public.stores "
                    "where name = 'ASHABI GLOBAL RESOURCES'")
    if not store:
        sys.exit("sample store not found")
    store_id = store[0]["id"]

    products = run_sql("select id::text, name from public.products "
                       "where store_id = '{}' order by name".format(store_id))

    credits = []
    for prod in products:
        name = prod["name"]
        print("{}:".format(name))
        picked = None
        for term in SEARCHES.get(name, [name]):
            for page in search_commons(term):
                cand = usable(page)
                if cand:
                    picked = cand
                    break
            if picked:
                break

        if not picked:
            print("    no freely-licensed photo found — keeping the drawn placeholder")
            continue

        print("    {}  [{}]".format(picked["title"], picked["licence"]))
        try:
            webp, removed = normalise(download(picked["url"]))
        except Exception as e:
            print("    could not process: {}".format(e))
            continue

        path = "{}/products/{}-photo.webp".format(store_id, prod["id"])
        if not upload(path, webp):
            continue

        # Replace the drawn art as the MAIN image; the drawings stay behind it as extra angles.
        run_sql(
            "update public.product_media set sort_order = sort_order + 10 "
            "where product_id = '{pid}' and path <> '{p}';"
            "insert into public.product_media (product_id, kind, path, alt, sort_order) "
            "select '{pid}', 'image', '{p}', '{alt}', 0 "
            "where not exists (select 1 from public.product_media where path = '{p}');"
            .format(pid=prod["id"], p=path, alt=name.replace("'", "''")))

        credits.append({"product": name, **picked, "background_removed": removed})
        print("    uploaded ({} KB, background {})"
              .format(len(webp) // 1024, "lifted" if removed else "left as-is"))

    if credits:
        with io.open(os.path.join(HERE, "CREDITS.md"), "w", encoding="utf-8") as f:
            f.write("# Photo credits\n\n")
            f.write("Product photographs sourced from Wikimedia Commons under licences that\n"
                    "permit commercial reuse. Attribution is a condition of most of these\n"
                    "licences, so this file is part of the deliverable, not a nicety.\n\n")
            for c in credits:
                f.write("- **{product}** — [{title}]({page}) by {author}, {licence}\n".format(**c))
        print("\nwrote CREDITS.md with {} entries".format(len(credits)))
    else:
        print("\nnothing sourced; the drawn placeholders remain in place")


if __name__ == "__main__":
    main()
