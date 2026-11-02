# Boost Desk — design system

"Calm console", Professional Blue. Flat surfaces, one blue, status by colour, numbers in Inter.
Every value below is a CSS custom property in `public/assets/app.css` `:root` — **use the token, never the raw value.**
Dark theme swaps the tokens (`[data-theme=dark]` or the device setting); no component needs its own dark rule.

## Colour

| Role | Token | Light | Dark | Use for |
|---|---|---|---|---|
| Brand | `--brand` | #2563EB | #3B82F6 | links, active nav, focus rings, meters |
| Brand fill | `--brand-fill` | #2563EB | #2563EB | solid buttons and badges (white text in both themes) |
| Brand hover | `--brand-hover` | #1D4ED8 | #1D4ED8 | hover on solid brand |
| Brand text | `--brand-text` | #1D4ED8 | #93C5FD | brand-coloured text on a surface |
| Brand soft | `--brand-soft` | #EEF4FF | #1E2A4A | selected nav / segmented chip background |
| On brand | `--on-brand` | #fff | #fff | text on a solid brand or status fill |
| Page | `--bg` | #F6F7F9 | #0B1220 | body |
| Page 2 | `--bg-2` | #F1F3F7 | #172033 | inputs, hover rows, quiet avatars |
| Surface | `--surface` | #fff | #111827 | cards, dialogs, tables |
| Line | `--line` | #E5E7EB | #1F2937 | every border |
| Ink | `--ink` | #0F172A | #F1F5F9 | body text |
| Muted | `--muted` | #5B6B82 | #94A3B8 | hints, labels, secondary numbers |
| OK | `--ok` / `--ok-soft` | #047857 / #ECFDF5 | #34D399 / #0F2A22 | success pills, positive numbers |
| Warn | `--warn` / `--warn-soft` | #B45309 / #FFFBEB | #FBBF24 / #2A2210 | attention pills |
| Danger | `--danger` / `--danger-soft` | #B91C1C / #FEF2F2 | #F87171 / #3A1719 | errors, negative numbers, destructive buttons |
| Facebook | `--fb` | #1877F2 | #1877F2 | "Continue with Facebook" only |
| Decorative | `--fx-1…9` | — | — | confetti, sparks — never for meaning |

Aliases kept for old rules (don't use in new work): `--accent` = ok, `--live` = danger, `--bad`, `--card`, `--bg-1`, `--brand-2`.
No gradients anywhere (`--grad` is the flat brand fill).

## Typography

Font: `--f-ui` = Inter for Latin, Kantumruy Pro for Khmer, weights **400 / 500 / 600 / 700 only**. Numbers use the same face (`--f-num`), tabular where they line up in tables.

| Token | Size | Use |
|---|---|---|
| `--fs-hero` | 1.6rem | the one big number on a page |
| `--fs-h1` | 1.4rem | page title (700, letter-spacing −.01em) |
| `--fs-h2` | 1.2rem | section title |
| `--fs-h3` | 1.1rem | card title (600) |
| `--fs-base` | 1rem | body |
| `--fs-xl` / `--fs-2xl` | .9 / .95rem | emphasised body, inputs |
| `--fs-lg` | .875rem | buttons, field labels |
| `--fs-md` | .84rem | hints |
| `--fs-sm` | .8rem | pills |
| `--fs-xs` / `--fs-2xs` | .76 / .72rem | table heads, eyebrows (uppercase, letter-spacing .06–.08em, 700, muted) |

## Spacing, radius, elevation, motion

- Spacing scale `--s-1…6` = 4 · 8 · 12 · 16 · 24 · 32. Card padding 16 × 20, grid gaps 16, row gaps 8–12.
- Radius: `--r-sm` 6 (small buttons, Facebook button) · `--r-md` 8 (inputs, buttons, chips) · `--r-xl` 12 (cards, dialogs) · `--r-pill` 999 (pills, switches). Avoid `--r-xs`/`--r-lg` in new work.
- Shadow: `--shadow-sm` on cards (barely there), `--shadow-md` on popovers, `--shadow-lg` on dialogs. Borders carry the structure, not shadows.
- Motion: `--t-fast` .15s for hover/press, `--t-med` .3s for panels, `--ease` cubic-bezier(.2,.8,.2,1). Respect `prefers-reduced-motion`.

## Components

**Card** `.panel` / `.card` — surface, 1px line, radius 12, padding 16 × 20, `--shadow-sm`. Title row: `h2` at `--fs-h3` 600 on the left, a pill or action on the right. (Profit's `.pf-sheet` and Settings' `.st-card` are the same card.)

**Button**
- Primary `button.primary` — brand fill, white text, radius 8, height 38 (34 with `.sm`), 600.
- Secondary (default button inside `.wrap`) — surface, 1px line, ink text; hover → `--bg-2`.
- Ghost `.ghost` — no border, muted text; for Cancel / ✕ / Hide.
- Danger `.danger` (solid) or `.danger-txt` (text only) — destructive actions, always behind a confirm.
- Link `.linkbtn` — brand text, underline on hover; for inline actions in hints.
- States: hover, `:focus-visible` 2px brand outline offset 2, `:disabled` 50 % opacity, `.busy` spinner. Facebook login is the only off-palette button (`--fb`).

**Pill** `.pill` + `ok | warn | bad` (soft background, strong text, radius pill, `--fs-sm` 500). Plain `.pill` = neutral count. All other status badges (`.arstate`, `.pf-roleb`, `.pf-locked`, `.sc-st`, `.is-ok`…) should look identical to this.

**Chip / segmented** `.seg > button` — pill group; selected = `--brand-soft` background + `--brand-text`. Used for filters (Today / 7 days…), languages, teams. May carry a muted number after the label.

**Switch** `.switch` (46 × 28) and `.st-sw` (40 × 24) — line background off, brand on, white knob (`--paper`).

**Field** `.fld` — label `--fs-lg` 500 above, input height 38, 1px line, radius 8, surface background; read-only = `--bg-2` + muted text. Inline hint below in `--fs-md` muted.

**Stat tile** — uppercase eyebrow label (`--fs-2xs`), number at `--fs-hero` 700, one-line muted sub. The *one* key number on a page may use the inverted tile (brand fill, white text); never more than one per row.

**Table** — uppercase muted heads, zebra-free, 1px line between rows, numbers right-aligned in `.n`, totals row bold on `--bg-2`. Row hover `--bg-2`. Names with an avatar (`.who`).

**Avatar** — initials on `--bg-2`/muted (people) or `--brand-soft`/`--brand-text` (me); 32 in lists, 40 in headers, 48 on profile.

**Dialog** `.dlg` — surface, radius 12, `--shadow-lg`, head with title + muted sub + ✕ ghost, footer with secondary on the left and primary on the right.

**Toast / note** — `.note` inline (bg-2, radius 8); toasts bottom-centre, 3 s.

## Rules of thumb

1. One primary button per card. Everything else is secondary or ghost.
2. Colour means status, not decoration: green = ok, amber = needs attention, red = wrong/negative, blue = selected/brand. Grey for everything else.
3. Labels above, values below; uppercase only for eyebrows and table heads.
4. New styles go into the component's base rule, not a new "pass" block at the end of the file, and never with `!important`.
5. Khmer text sits next to English in the same style (`lang="km"`), no separate font size.
