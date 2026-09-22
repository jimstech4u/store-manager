/**
 * The home-screen icons, from the one mark the app already has.
 *
 * `src/app/icon.svg` is the favicon and the header mark (see `LogoMark`), so the icon on somebody's
 * phone is the same three shapes they see in the app — a crate, a division across it, a tally.
 * Generated rather than hand-drawn, so changing the mark changes every size in one step.
 *
 * Three shapes of file, because the platforms ask for different things:
 *
 *   ANY (192, 512)    used as-is. Android may put it on its own white tile.
 *   MASKABLE (512)    Android crops this to whatever shape the launcher uses — circle, squircle,
 *                     rounded square. Anything within the outer 20% can be cut off, so the mark is
 *                     drawn at 72% on a full-bleed teal ground. The same file cropped from an
 *                     "any" icon would lose the crate's corners.
 *   APPLE (180)       iOS ignores the manifest icons and reads `apple-touch-icon`. It applies its
 *                     own rounded corners and refuses transparency, so this is squared and opaque.
 *
 *     node scripts/make-app-icons.mjs
 */

import sharp from 'sharp';
import { readFileSync, mkdirSync } from 'node:fs';

const SRC = 'src/app/icon.svg';
const OUT = 'public/icons';
const TEAL = '#0b6252'; // the brand ground, and the manifest's background_color
const svg = readFileSync(SRC);

mkdirSync(OUT, { recursive: true });

const render = (size) => sharp(svg, { density: 512 }).resize(size, size).png();

/** The mark inset on its own ground, for a launcher that crops. */
async function maskable(size, inset) {
  const inner = Math.round(size * inset);
  const mark = await render(inner).toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: TEAL },
  })
    .composite([{ input: mark, top: Math.round((size - inner) / 2), left: Math.round((size - inner) / 2) }])
    .png();
}

const written = [];
const write = async (pipeline, name) => {
  const info = await pipeline.toFile(`${OUT}/${name}`);
  written.push(`${name} ${info.width}×${info.height}`);
};

await write(render(192), 'icon-192.png');
await write(render(512), 'icon-512.png');
// 72%: the safe zone every launcher shape leaves untouched.
await write(await maskable(512, 0.72), 'icon-maskable-512.png');
// Opaque and square: iOS adds the corners itself, and a transparent one comes out black.
await write(
  sharp(await render(180).flatten({ background: TEAL }).toBuffer()).png(),
  'apple-touch-icon.png',
);

console.log(`wrote ${written.length} icons to ${OUT}/`);
for (const w of written) console.log(`  ${w}`);
