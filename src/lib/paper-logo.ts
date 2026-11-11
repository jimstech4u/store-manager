import type { PaperLogo } from '@/lib/share';

/**
 * THE SHOP'S LOGO, as the paper takes it — from the two settings the Printing page keeps
 * (`receipt_logo_path`, `receipt_logo_width_pct`). Pure, so the app and the agent's server build the
 * same letterhead. The picture lives in the public `media` bucket, already reduced to black and white
 * for a thermal head when it was uploaded.
 *
 * "The store has a logo but the preview did not get that, and the receipts did not": the setting was
 * saved and drawn nowhere. Every reader of the header now reads this beside it.
 */
export function paperLogo(path: string | null | undefined, widthPct: number | string | null | undefined): PaperLogo | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!path || !base) return null;
  return { url: `${base}/storage/v1/object/public/media/${path}`, widthPct: Number(widthPct) || 60 };
}
