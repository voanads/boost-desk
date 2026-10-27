# Boost Desk design system

All styles live in `public/assets/app.css`. The tokens are at the top of the file (`:root`), and dark mode redefines the colour tokens.
**Use tokens and the shared components below. Don't add raw hex colours, px radii or rem font sizes.**
The look and the rules behind it ("Calm console": one blue, flat, no gradients) are in [`DESIGN.md`](../DESIGN.md); this file lists the tokens and class names.

## Tokens

| Group | Tokens | Notes |
|---|---|---|
| Brand | `--brand` `--brand-2` `--brand-fill` `--brand-hover` `--brand-text` `--brand-soft` `--brand-glow` `--brand-mist` | `--brand-fill` = solid fills (the one primary button, solid badges); `--brand-text` on `--brand-soft` for selected chips and nav. `--grad`, `--grad-hero`, `--ok-grad` are older names that are now **flat** colours — no gradients |
| Surfaces | `--bg` `--bg-2` `--surface` `--line` `--paper` | `--paper` is always white (QR, invoice preview, switch knobs) |
| Text | `--ink` `--muted` `--on-brand` `--on-ok` | `--on-brand` = text on `--brand-fill` or a solid status colour |
| Status | `--ok` `--ok-soft` · `--warn` `--warn-soft` · `--danger` `--danger-soft` · `--amber` | `--live` / `--accent` are the older names for danger / ok |
| Type | `--fs-2xs` .72 · `--fs-xs` .76 · `--fs-sm` .8 · `--fs-md` .84 · `--fs-lg` .875 · `--fs-xl` .9 · `--fs-2xl` .95 · `--fs-base` 1 · `--fs-h3` 1.1 · `--fs-h2` 1.2 · `--fs-h1` 1.4 · `--fs-hero` 1.6 (rem) | Font: Inter, with Kantumruy Pro for Khmer (`--f-ui`, `--f-num`); the Aa picker can switch it |
| Radius | `--r-xs` 4 · `--r-sm` 6 · `--r-md` 8 · `--r-lg` 10 · `--r-xl` 12 · `--r-pill` 999 (px) | `--r` = 12px, the older panel radius (same as `--r-xl`) |
| Spacing | `--s-1` 4 · `--s-2` 8 · `--s-3` 12 · `--s-4` 16 · `--s-5` 24 · `--s-6` 32 (px) | For new work |
| Elevation | `--shadow-sm` `--shadow-md` `--shadow-lg` | `--glow` is `none` now; don't use it |
| Motion | `--t-fast` .15s · `--t-med` .3s · `--t-slow` .6s · `--ease` | Everything respects `prefers-reduced-motion` |
| Decorative | `--fx-1` … `--fx-9` | Confetti, sparks and live thumbnails only |

## Components

### Button
`<button>`, with `.primary` (solid `--brand-fill`, one per screen), `.ghost` (text only), `.danger` (red outline) and `.sm` (small).
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
- `.summary`: stat tiles, with the first tile as `.hero` (white card, 3px `--brand` inside edge).
- `.panel`: page section.
- `.switch`: toggle.
- `dialog.dlg`: dialog.
- `.dtable`: tables that turn into cards on phones.

### Patterns
- **List + detail** (`.cwrap` → `.clist` of `.crow` + `.cdetail`): the Clients tab. Desktop: sticky list on the left, detail on the right, first item open. Phones (≤900px): the list, then the detail full width with **← All clients**. Rows use `role="option"` / `aria-selected`.
- **Detail panel** (`.cd-in`): header (`.cr-av` initial, name, tags) → stat tiles (`.cd-stats`, first one `.hero`, white with the blue inside edge) → sections (`.cd-sec`, top border, `h4` title + `countpill`). The client edit form is moved into the last section instead of opening a dialog; the dialog is still used for **+ Add client**.
- **AI section** (`.aisec` / `.aibox`): soft brand gradient + brand border, EN / ខ្មែរ segmented control, **↻ New**, loading dots (`.ai-dot`), answer rendered with light Markdown (`.ai-text`: `h4`, lists, bold). Only the AI section repaints when the answer arrives, so the form keeps what is being typed.

## Rules
1. Use colours, sizes, radii, shadows and motion only from tokens. Dark mode then works automatically.
2. Make a new screen from Card, Pill, Button, Panel and Chips before inventing a new box.
3. Don't add `!important`. If a style doesn't apply, find the earlier rule and change it.
4. After a style change, run the screenshot check (light, dark, phone) before shipping.
