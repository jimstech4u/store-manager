'use client';

import { useState } from 'react';
import styles from './Thumb.module.css';
import { mediaUrl } from '@/lib/stacks/storefront';

/**
 * A product or shop picture, with a fallback that is not an apology.
 *
 * Most shops will not have photographed everything on day one, and a broken-image glyph or an
 * empty grey box makes a catalogue look abandoned. The fallback here draws the item's initials on
 * a colour derived from its own name — so a shelf of unphotographed products still reads as a
 * deliberate, varied grid rather than a list of failures.
 *
 * The colour comes from a hash of the name, which means it is stable: the same product gets the
 * same tile every time, and a shopper can start to recognise it before there is ever a photo.
 */

const TILES = [
  ['#0b6252', '#c5e4dd'],
  ['#1d4e6b', '#cfe3ef'],
  ['#6b3f1d', '#f0dcc7'],
  ['#4a1d6b', '#e3d0f0'],
  ['#6b1d38', '#f0ced9'],
  ['#3f6b1d', '#dcf0c7'],
] as const;

function initials(name: string): string {
  const words = name.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function tileFor(name: string): readonly [string, string] {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return TILES[hash % TILES.length];
}

export function Thumb({
  path,
  name,
  ratio = '1 / 1',
  rounded = true,
}: {
  path?: string | null;
  /** Used for the alt text and, when there is no picture, the fallback tile. */
  name: string;
  ratio?: string;
  rounded?: boolean;
}) {
  const url = mediaUrl(path);
  // A stored path can outlive the file behind it. Falling back on error means a deleted image
  // degrades to the tile rather than to a broken icon.
  const [failed, setFailed] = useState(false);
  const [bg, fg] = tileFor(name);

  if (!url || failed) {
    return (
      <div
        className={`${styles.thumb} ${rounded ? styles.rounded : ''}`}
        style={{ aspectRatio: ratio, background: bg }}
        role="img"
        aria-label={name}
      >
        <span className={styles.initials} style={{ color: fg }}>
          {initials(name)}
        </span>
      </div>
    );
  }

  return (
    <div
      className={`${styles.thumb} ${rounded ? styles.rounded : ''}`}
      style={{ aspectRatio: ratio }}
    >
      {/* A plain <img>, not next/image, and the lint rule is silenced deliberately rather than
          worked around: these are Supabase Storage URLs on another origin, already sized and
          cached at the edge. Routing every shop thumbnail through Next's optimiser would add a
          hop and a per-image cost for no gain — and next/image would need every future shop's
          storage host allow-listed at build time, which a multi-tenant marketplace cannot know. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name}
        loading="lazy"
        decoding="async"
        className={styles.img}
        onError={() => setFailed(true)}
      />
    </div>
  );
}
