'use client';

import { useMemo } from 'react';
import { BarcodeFormat, EncodeHintType, MultiFormatWriter } from '@zxing/library';

/**
 * A QR code, drawn as an SVG.
 *
 * NO NEW DEPENDENCY. `@zxing/library` is already here for scanning barcodes at the counter, and
 * the same library encodes — so a QR costs nothing but this file. Adding a second library to draw
 * what the first one can already draw is how a bundle grows without anybody deciding to.
 *
 * DRAWN FROM THE BIT MATRIX, not with the library's own DOM writer. `BrowserQRCodeSvgWriter`
 * builds elements and hands them over, which in React means injecting foreign nodes and hoping
 * nothing re-renders underneath them. The matrix is just booleans; turning it into one `<path>` is
 * a few lines and leaves React owning the tree.
 *
 * ONE PATH RATHER THAN A RECT PER MODULE. A 33×33 code is around five hundred dark modules, and
 * five hundred `<rect>` elements is a slow print and a large document for something that is one
 * shape.
 *
 * IT PRINTS. A QR that renders on screen and drops out of the print is worse than none, because
 * the sheet goes on the wall with a white square on it — so the path is plain black fill with no
 * dependence on a theme colour, which is also what a scanner needs against white paper.
 */
export function QrCode({
  value,
  size = 128,
  title,
}: {
  /** What a scanner should end up at. */
  value: string;
  /** Rendered size in px. The code's own module count is whatever the content needs. */
  size?: number;
  /** For anybody who cannot see it — screen readers get this instead of a blank graphic. */
  title: string;
}) {
  const drawn = useMemo(() => {
    if (!value) return null;
    try {
      const hints = new Map<EncodeHintType, unknown>();
      // One module of quiet zone rather than the usual four: the card around it supplies the rest,
      // and four would shrink the pattern to the point a phone struggles at arm's length.
      hints.set(EncodeHintType.MARGIN, 1);
      // Width and height of 0 mean "whatever the content needs" — the matrix is scaled by the
      // viewBox below, so asking for a pixel size here would only resample it.
      const matrix = new MultiFormatWriter().encode(value, BarcodeFormat.QR_CODE, 0, 0, hints);

      const w = matrix.getWidth();
      const h = matrix.getHeight();
      let d = '';
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (matrix.get(x, y)) d += `M${x} ${y}h1v1h-1z`;
        }
      }
      return { d, w, h };
    } catch {
      /*
       * A code that cannot be encoded draws nothing, and the caller shows its link instead.
       * Throwing here would take a whole report down over a decoration.
       */
      return null;
    }
  }, [value]);

  if (!drawn) return null;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${drawn.w} ${drawn.h}`}
      role="img"
      aria-label={title}
      shapeRendering="crispEdges"
    >
      {/* Explicit white behind it: a scanner needs the contrast, and a dark-mode card would
          otherwise show black modules on a dark background and simply not scan. */}
      <rect width={drawn.w} height={drawn.h} fill="#ffffff" />
      <path d={drawn.d} fill="#000000" />
    </svg>
  );
}
