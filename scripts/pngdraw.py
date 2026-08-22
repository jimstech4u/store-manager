"""A tiny PNG writer — enough to draw product art, with no dependencies.

Written rather than reached for because the alternative was worse. The first attempt uploaded
SVG, which the media bucket refuses: SVG can carry script, and a PUBLIC bucket serving
user-uploaded SVG is a cross-site-scripting vector aimed at every shopper who opens the page.
Widening the allowed MIME types would have made the seed work by removing a real defence — so the
seed changed instead of the security.

zlib and struct are standard library, so this needs nothing installed.
"""
import struct
import zlib


class Canvas:
    def __init__(self, width, height, background=(255, 255, 255)):
        self.w = width
        self.h = height
        self.px = bytearray()
        for _ in range(width * height):
            self.px += bytes(background)

    def _set(self, x, y, rgb):
        if 0 <= x < self.w and 0 <= y < self.h:
            i = (y * self.w + x) * 3
            self.px[i:i + 3] = bytes(rgb)

    def _blend(self, x, y, rgb, alpha):
        """Alpha compositing, used only for soft accents.

        Anti-aliasing edges this way is what keeps the shapes from looking like 1998 clip art at
        the size a phone actually shows them.
        """
        if not (0 <= x < self.w and 0 <= y < self.h):
            return
        i = (y * self.w + x) * 3
        for c in range(3):
            old = self.px[i + c]
            self.px[i + c] = int(old + (rgb[c] - old) * alpha)

    def rect(self, x, y, w, h, rgb, radius=0, alpha=1.0):
        for yy in range(int(y), int(y + h)):
            for xx in range(int(x), int(x + w)):
                if radius:
                    # Only the corners need testing; the middle is always inside.
                    dx = min(xx - x, x + w - 1 - xx)
                    dy = min(yy - y, y + h - 1 - yy)
                    if dx < radius and dy < radius:
                        ox, oy = radius - dx, radius - dy
                        if ox * ox + oy * oy > radius * radius:
                            continue
                if alpha >= 1.0:
                    self._set(xx, yy, rgb)
                else:
                    self._blend(xx, yy, rgb, alpha)

    def ellipse(self, cx, cy, rx, ry, rgb, alpha=1.0):
        for yy in range(int(cy - ry), int(cy + ry) + 1):
            for xx in range(int(cx - rx), int(cx + rx) + 1):
                nx = (xx - cx) / max(rx, 0.0001)
                ny = (yy - cy) / max(ry, 0.0001)
                d = nx * nx + ny * ny
                if d <= 1.0:
                    # Feather the last few percent so the curve does not stair-step.
                    edge = 1.0 if d < 0.92 else (1.0 - d) / 0.08
                    self._blend(xx, yy, rgb, alpha * max(0.0, min(1.0, edge)))

    def vgrad(self, x, y, w, h, top, bottom):
        for yy in range(int(y), int(y + h)):
            t = (yy - y) / max(h - 1, 1)
            rgb = tuple(int(top[c] + (bottom[c] - top[c]) * t) for c in range(3))
            for xx in range(int(x), int(x + w)):
                self._set(xx, yy, rgb)

    def hgrad(self, x, y, w, h, left, right):
        for xx in range(int(x), int(x + w)):
            t = (xx - x) / max(w - 1, 1)
            rgb = tuple(int(left[c] + (right[c] - left[c]) * t) for c in range(3))
            for yy in range(int(y), int(y + h)):
                self._set(xx, yy, rgb)

    def poly(self, points, rgb, alpha=1.0):
        """Scanline-fill an arbitrary polygon.

        Needed for rooflines and awnings, which rectangles and ellipses cannot express. Handles
        concave shapes correctly by sorting every edge crossing on each scanline and filling
        between alternate pairs, rather than assuming a single span.
        """
        if len(points) < 3:
            return
        ys = [p[1] for p in points]
        for yy in range(int(min(ys)), int(max(ys)) + 1):
            crossings = []
            for i in range(len(points)):
                x1, y1 = points[i]
                x2, y2 = points[(i + 1) % len(points)]
                if y1 == y2:
                    continue
                if min(y1, y2) <= yy < max(y1, y2):
                    crossings.append(x1 + (yy - y1) * (x2 - x1) / (y2 - y1))
            crossings.sort()
            for i in range(0, len(crossings) - 1, 2):
                for xx in range(int(crossings[i]), int(crossings[i + 1]) + 1):
                    self._blend(xx, yy, rgb, alpha)

    def veil(self, x, y, w, h, rgb, start=0.0, end=1.0):
        """Fade a colour in over a band — a gradient in alpha rather than in hue.

        Used to darken the foot of an image so overlaid text keeps its contrast without flattening
        the picture the way a full-surface scrim does.
        """
        for i in range(int(h)):
            a = start + (end - start) * (i / max(h - 1, 1))
            for xx in range(int(x), int(x + w)):
                self._blend(xx, int(y) + i, rgb, a)

    def shadow(self, cx, cy, rx, ry, rgb=(0, 0, 0), alpha=0.18, steps=7):
        """A soft contact shadow, faked by stacking fading ellipses.

        A product floating with a hard edge underneath looks pasted on; this is the cheapest thing
        that makes it sit on a surface.
        """
        for i in range(steps, 0, -1):
            k = i / steps
            self.ellipse(cx, cy, rx * k, ry * k, rgb, alpha=alpha / steps)

    def to_png(self):
        raw = bytearray()
        stride = self.w * 3
        for y in range(self.h):
            raw.append(0)                                   # filter type 0 (None)
            raw += self.px[y * stride:(y + 1) * stride]

        def chunk(tag, data):
            out = struct.pack(">I", len(data)) + tag + data
            return out + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        header = struct.pack(">IIBBBBB", self.w, self.h, 8, 2, 0, 0, 0)  # 8-bit RGB
        return (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b"")
        )
