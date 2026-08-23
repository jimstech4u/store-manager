'use client';

/**
 * Deterministic image normalisation, in the browser, before upload.
 *
 * A shop photographs a bottle on a counter in bad light and uploads it. Left alone, a catalogue
 * becomes a jumble of orientations, sizes and backgrounds — which is what makes an otherwise
 * decent marketplace look untrustworthy. This puts every picture through the same steps, so the
 * grid looks composed rather than collected:
 *
 *   1. decode and correct orientation
 *   2. lift the background to white where it is plainly background
 *   3. trim the resulting margin so the product fills the frame consistently
 *   4. pad back to a square with a white margin
 *   5. resize to a fixed edge and encode as WebP
 *
 * DETERMINISTIC on purpose: no model, no service, no network. The same input always gives the
 * same output, it works offline, it costs nothing per image, and there is nothing to be down.
 *
 * The background lift is a flood fill from the edges, not a subject-detection model. It is
 * honest about what it can do: it cleans up an item shot against a plain surface, which is the
 * common case, and leaves a busy background alone rather than cutting a hole in the product.
 * Over-removing is far worse than under-removing — a bottle with its neck erased is unusable,
 * while a slightly grey background is merely imperfect.
 */

export interface NormaliseOptions {
  /** Output edge in pixels. Square. */
  size?: number;
  /** How close to the corner colour counts as background, 0–255 per channel. */
  tolerance?: number;
  /** Skip the background lift — for photos where the setting is part of the picture. */
  keepBackground?: boolean;
  quality?: number;
}

export interface NormaliseResult {
  blob: Blob;
  width: number;
  height: number;
  /** True when the background lift actually changed a meaningful number of pixels. */
  backgroundRemoved: boolean;
}

/** Decode a file, honouring EXIF orientation, which phones set constantly. */
async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* fall through to the <img> path */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not read that image'));
      img.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Flood-fill from the edges, marking anything close to the border colour as background.
 *
 * Seeded from all four edges rather than one corner: a photo lit from the side has a lighter
 * corner and a darker one, and a single seed would clear half the background and leave the rest.
 *
 * Iterative, not recursive — a recursive fill blows the stack on a 2000px photo, and it does so
 * only on large images, which is exactly the case that reaches production and not the one anyone
 * tests with.
 */
function liftBackground(data: Uint8ClampedArray, w: number, h: number, tolerance: number): number {
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];

  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]] as const;
  };

  // Reference colour: the median-ish of the four corners, so one dark corner cannot define it.
  const corners = [sample(0, 0), sample(w - 1, 0), sample(0, h - 1), sample(w - 1, h - 1)];
  const ref = [0, 1, 2].map((c) => {
    const vals = corners.map((p) => p[c]).sort((a, b) => a - b);
    return (vals[1] + vals[2]) / 2;
  });

  /*
   * Refuse to start if the four corners do not agree.
   *
   * The fill assumes the border is one flat colour. When it is not — a bottle photographed on a
   * table in a room, a product held up outdoors — the seeds disagree, the fill wanders in from
   * whichever corner happens to match the subject, and it eats holes out of the product. Tested
   * against real photographs this produced a water bottle with grey bites taken out of it, which
   * is far worse than the untouched original.
   *
   * Corner spread is a cheap, deterministic proxy for "is this a plain background at all", and
   * declining early is the honest answer when it is not.
   */
  const spread = Math.max(
    ...[0, 1, 2].map((c) => {
      const vals = corners.map((p) => p[c]);
      return Math.max(...vals) - Math.min(...vals);
    }),
  );
  if (spread > 44) return 0;

  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const p = y * w + x;
    if (seen[p]) return;
    const i = p * 4;
    if (
      Math.abs(data[i] - ref[0]) <= tolerance &&
      Math.abs(data[i + 1] - ref[1]) <= tolerance &&
      Math.abs(data[i + 2] - ref[2]) <= tolerance
    ) {
      seen[p] = 1;
      stack.push(p);
    }
  };

  for (let x = 0; x < w; x += 1) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y += 1) {
    push(0, y);
    push(w - 1, y);
  }

  let cleared = 0;
  while (stack.length) {
    const p = stack.pop() as number;
    const x = p % w;
    const y = (p / w) | 0;
    const i = p * 4;
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    cleared += 1;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  return cleared / (w * h);
}

/** Bounding box of everything that is not white, so the product can fill the frame. */
function contentBounds(data: Uint8ClampedArray, w: number, h: number) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (data[i] < 246 || data[i + 1] < 246 || data[i + 2] < 246) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;      // an entirely white image: nothing to trim to
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export async function normaliseProductImage(
  file: File,
  { size = 900, tolerance = 26, keepBackground = false, quality = 0.86 }: NormaliseOptions = {},
): Promise<NormaliseResult> {
  const source = await decode(file);
  const sw = 'width' in source ? source.width : 0;
  const sh = 'height' in source ? source.height : 0;
  if (!sw || !sh) throw new Error('Could not read that image');

  // Work at a bounded size: a 12-megapixel phone photo would make the flood fill crawl, and no
  // detail beyond this survives the final resize anyway.
  const workEdge = Math.min(1400, Math.max(sw, sh));
  const scale = workEdge / Math.max(sw, sh);
  const ww = Math.max(1, Math.round(sw * scale));
  const wh = Math.max(1, Math.round(sh * scale));

  const work = document.createElement('canvas');
  work.width = ww;
  work.height = wh;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  if (!wctx) throw new Error('Images cannot be processed in this browser');

  // White underneath: a transparent PNG would otherwise composite onto black.
  wctx.fillStyle = '#ffffff';
  wctx.fillRect(0, 0, ww, wh);
  wctx.drawImage(source, 0, 0, ww, wh);

  const image = wctx.getImageData(0, 0, ww, wh);
  let backgroundRemoved = false;
  if (!keepBackground) {
    // Keep the untouched pixels so an over-eager fill can be undone. One buffer copy at this size
    // is cheap; shipping a product with a hole in it is not.
    const original = new Uint8ClampedArray(image.data);
    const cleared = liftBackground(image.data, ww, wh, tolerance);

    // Above about two thirds, the fill has stopped being "the background" and started being the
    // picture. That happens on a photo of a pale item against a pale wall, where the subject and
    // its surroundings are within tolerance of each other.
    if (cleared > 0.66) {
      image.data.set(original);
    } else {
      backgroundRemoved = cleared > 0.02;
    }
    wctx.putImageData(image, 0, 0);
  }

  const bounds = contentBounds(image.data, ww, wh) ?? { x: 0, y: 0, w: ww, h: wh };

  // 8% breathing room. A product cropped hard to its own edge looks cramped next to one that was
  // not, and the whole point here is that the grid looks consistent.
  const pad = Math.round(Math.max(bounds.w, bounds.h) * 0.08);
  const edge = Math.max(bounds.w, bounds.h) + pad * 2;

  const out = document.createElement('canvas');
  out.width = size;
  out.height = size;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('Images cannot be processed in this browser');

  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, size, size);
  octx.imageSmoothingQuality = 'high';

  const k = size / edge;
  octx.drawImage(
    work,
    bounds.x, bounds.y, bounds.w, bounds.h,
    (size - bounds.w * k) / 2, (size - bounds.h * k) / 2,
    bounds.w * k, bounds.h * k,
  );

  const blob = await new Promise<Blob | null>((resolve) => {
    // WebP where available — roughly a third the bytes of JPEG at the same quality, which matters
    // on the connections this is browsed over.
    out.toBlob((b) => resolve(b), 'image/webp', quality);
  });

  if (!blob) throw new Error('Could not prepare that image');
  return { blob, width: size, height: size, backgroundRemoved };
}

/**
 * Prepare a logo for a thermal receipt.
 *
 * A different job from a product photo, so a different function rather than a flag. A receipt
 * printer is one bit per dot — it can print a dot or not print it, with no greys at all — and it
 * is 40mm or 80mm wide, which is 288 or 576 dots. A logo that has not been reckoned with those
 * two facts prints as a grey smear or as a band of solid black.
 *
 * So: trim to the mark, scale to the paper, then threshold to pure black and white. Thresholding
 * here rather than leaving it to the driver means what the shop previews is what the paper shows —
 * every driver dithers differently, and a shop that approved a preview should not be surprised.
 */
export async function normaliseReceiptLogo(
  file: File,
  { widthPx = 576, threshold = 0.62 }: { widthPx?: number; threshold?: number } = {},
): Promise<{ blob: Blob; width: number; height: number }> {
  const source = await decode(file);
  const sw = 'width' in source ? source.width : 0;
  const sh = 'height' in source ? source.height : 0;
  if (!sw || !sh) throw new Error('Could not read that image');

  const work = document.createElement('canvas');
  work.width = sw;
  work.height = sh;
  const wctx = work.getContext('2d', { willReadFrequently: true });
  if (!wctx) throw new Error('Images cannot be processed in this browser');

  // White underneath: a transparent PNG logo — which is what most shops have — would otherwise
  // composite onto black and print as a solid rectangle.
  wctx.fillStyle = '#ffffff';
  wctx.fillRect(0, 0, sw, sh);
  wctx.drawImage(source, 0, 0, sw, sh);

  // Trim the surrounding white so the mark itself fills the width it is given.
  const image = wctx.getImageData(0, 0, sw, sh);
  const box = contentBounds(image.data, sw, sh) ?? { x: 0, y: 0, w: sw, h: sh };

  const scale = widthPx / box.w;
  const outW = Math.max(1, Math.round(box.w * scale));
  const outH = Math.max(1, Math.round(box.h * scale));

  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d', { willReadFrequently: true });
  if (!octx) throw new Error('Images cannot be processed in this browser');

  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, outW, outH);
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(work, box.x, box.y, box.w, box.h, 0, 0, outW, outH);

  // One bit per dot. Luminance weighted for perception, not a flat average: a flat average turns
  // saturated reds and blues to mid-grey and they land on the wrong side of the threshold.
  const px = octx.getImageData(0, 0, outW, outH);
  const cut = threshold * 255;
  for (let i = 0; i < px.data.length; i += 4) {
    const lum = 0.2126 * px.data[i] + 0.7152 * px.data[i + 1] + 0.0722 * px.data[i + 2];
    const v = lum < cut ? 0 : 255;
    px.data[i] = v;
    px.data[i + 1] = v;
    px.data[i + 2] = v;
    px.data[i + 3] = 255;
  }
  octx.putImageData(px, 0, 0);

  // PNG, not WebP: this is two-tone line art, where PNG is both smaller and exact. WebP's lossy
  // mode would reintroduce the greys that were just removed.
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Could not prepare that logo');
  return { blob, width: outW, height: outH };
}
