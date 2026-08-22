# Email templates

Supabase auth emails for Store Manager. Applied to the live project with
`scripts/apply-email-templates.py`; kept here so the source of truth is in the repository rather
than only in a dashboard nobody can diff.

## The constraints these are written against

**Email clients are not browsers.** Gmail strips `<style>` blocks in some contexts, Outlook
renders through Word, and almost none support flexbox or grid reliably. So: tables for layout,
inline styles, no external CSS, no web fonts, no JavaScript. This looks like 2005 HTML because
that is what survives.

**Dark mode is the part that usually breaks.** Many clients auto-invert light emails, and the
common result is dark text on a dark background — which is exactly how a one-time code becomes
unreadable at the moment it matters most. Two defences here:

1. `color-scheme` and `supported-color-schemes` meta, so a client that respects them stops
   force-inverting and uses the `prefers-color-scheme` rules instead.
2. **Every critical element carries its own background and its own foreground.** The code block
   is white-on-teal explicitly, so even a client that inverts everything around it leaves a
   readable, high-contrast panel. Never light text on "whatever the default background is".

*(academix-web hit precisely this: its OTP code was unreadable in dark mode. Same fix.)*

**Read on a phone, one-handed, often in sunlight.** Single column, 16px+ body text, a 44px+ tap
target for the button, and the code repeated as selectable text for anyone who would rather copy
it than tap.

## Variables

Supabase substitutes these:

| Variable | Meaning |
|---|---|
| `{{ .ConfirmationURL }}` | The full action link |
| `{{ .Token }}` | 6-digit one-time code |
| `{{ .SiteURL }}` | The configured site URL |
| `{{ .Email }}` | Recipient address |
