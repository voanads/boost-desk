# Boost Desk design system

All styles live in `public/assets/app.css`. The tokens are at the top of the file (`:root`), and dark mode redefines the colour tokens.
**Use tokens and the shared components below. Don't add raw hex colours, px radii or rem font sizes.**

## Tokens

| Group | Tokens | Notes |
|---|---|---|
| Brand | `--brand` `--brand-2` `--brand-soft` `--grad` `--grad-hero` `--brand-glow` `--brand-mist` | `--grad` is the purple gradient used on primary buttons and the hero tile |
| Surfaces | `--bg` `--bg-2` `--surface` `--line` `--paper` | `--paper` is always white (QR, invoice preview, switch knobs) |
| Text | `--ink` `--muted` `--on-brand` `--on-ok` | `--on-brand` = text on the gradient or a solid status colour |
| Status | `--ok` `--ok-soft` `--ok-grad` · `--warn` `--warn-soft` · `--danger` `--danger-soft` · `--amber` | `--live` / `--accent` are the older names for danger / ok |
| Type | `--fs-2xs` .66 · `--fs-xs` .72 · `--fs-sm` .78 · `--fs-md` .82 · `--fs-lg` .86 · `--fs-xl` .9 · `--fs-2xl` .95 · `--fs-base` 1 · `--fs-h3` 1.1 · `--fs-h2` 1.2 · `--fs-h1` 1.4 · `--fs-hero` 1.6 (rem) | Font: Kantumruy Pro (`--f-ui`, `--f-num`) |
| Radius | `--r-xs` 4 · `--r-sm` 8 · `--r-md` 10 · `--r-lg` 12 · `--r-xl` 16 · `--r-pill` (px) | `--r` = 12px, the panel radius |
| Spacing | `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 24 · `--s-6` 32 (px) | For new work |
| Elevation | `--shadow-sm` `--shadow-md` `--shadow-lg` `--glow` | `--glow` = purple button glow |
| Motion | `--t-fast` .15s · `--t-med` .3s · `--t-slow` .6s · `--ease` | Everything respects `prefers-reduced-motion` |
| Decorative | `--fx-1` … `--fx-9` | Confetti, sparks and live thumbnails only |

## Components

### Button
`<button>`, with `.primary` (gradient, one per screen area), `.ghost` (text only), `.danger` (red outline) and `.sm` (small).
States: hover, `:disabled`, `.busy` (spinner). Icon-only buttons need `aria-label`.

### Card — `.card`
A raised box: surface, 1px line, `--r-xl`. Existing cards (`.ucard`, `.setcard`, `.syscard`) share this rule. New card types add their class to the same selector list instead of repeating the styles.

### Pill — `.pill`
A small status label. Variants: `.ok` `.warn` `.bad` `.brand` `.solid`, and the default is muted.
`.sc-st` and `.rolechip` are the same component.

### Status text
`.is-ok` / `.is-warn` / `.is-danger`. The older names `.okt`, `.warnt` and `.over` still work.

### Others
- `.chips`: period filter, using `aria-pressed`.
- `.seg`: segmented control.
- `.summary`: stat tiles, with the first tile as `.hero`.
- `.panel`: page section.
- `.switch`: toggle.
- `dialog.dlg`: dialog.
- `.dtable`: tables that turn into cards on phones.

## Rules
1. Use colours, sizes, radii, shadows and motion only from tokens. Dark mode then works automatically.
2. Make a new screen from Card, Pill, Button, Panel and Chips before inventing a new box.
3. Don't add `!important`. If a style doesn't apply, find the earlier rule and change it.
4. After a style change, run the screenshot check (light, dark, phone) before shipping.
