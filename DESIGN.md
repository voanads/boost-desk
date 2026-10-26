# Boost Desk — design system

How every page of Boost Desk should look. The values live as CSS variables in
`public/assets/app.css` (`:root`, and `:root[data-theme=dark]`). Use the
variable names in CSS, never raw values.

## Feel

Calm, clear, fast to scan on a phone at the end of a work day. One purple
brand, white cards on a soft grey ground, status told by colour **and** words.
Khmer and English sit side by side, so the type must carry Khmer well.

## Colour

| Token | Light | Role |
| --- | --- | --- |
| `--brand` | `#5B45F0` | The one main action per screen, links, selected text, the brand mark |
| `--brand-2` | `#8B5CF6` | Second stop of the gradient; "behind plan" state |
| `--brand-soft` | `#EEEBFF` | Selected chips, soft tags, hover tint |
| `--grad` | `#8B5CF6 → #5B45F0` | **Hero cards only** (Total spent, Spent this month). Not buttons, not chips |
| `--bg` / `--bg-2` | `#F4F5F9` / `#EEF0F5` | Page ground / inset areas, inputs, calendar days |
| `--surface` | `#ffffff` | Cards, sidebar, dialogs |
| `--line` | `#E1E4EC` | Borders, dividers |
| `--ink` / `--muted` | `#11142A` / `#565C74` | Text / secondary text and labels |
| `--ok` + `--ok-soft` | `#12A36B` / `#E3F6EE` | Done, on plan, connected, running |
| `--warn` + `--warn-soft` | `#C27800` / `#FFF3DC` | Needs attention, ahead of plan, ends today |
| `--live` (= `--danger`) + `--live-soft` | `#E5484D` / `#FDECEC` | Live videos, over budget, late, delete |
| `--on-brand` | `#ffffff` | Text on purple or on a solid status colour |

Rules
- **One solid purple button per screen** — the main action (Sync from Meta,
  Save, Send). Everything else is outline, grey or text.
- Selected chips and segments are **soft purple** (`--brand-soft` background,
  `--brand` text), never solid, so they don't compete with the main button.
- Status colours always come with a word (On plan, Late, Connected). Never
  colour alone.
- Dark mode redefines every token above, so a new block must use tokens; a
  raw `#fff` or `#11142A` breaks in dark mode.
- Text contrast: body ≥ 4.5:1, large numbers ≥ 3:1. `--muted` on `--surface`
  passes; `--muted` on `--brand-soft` does not — use `--brand` there.

## Typography

- Family: `--f-ui` — **Inter** by default, with Kantumruy Pro for Khmer;
  the Aa picker lets a person switch (System, Noto Sans, Lexend, Plus
  Jakarta, Onest). Numbers use `--f-num` (same family, `tabular-nums`).
- Scale (rem, from `--fs-*`): 2xs .66 · xs .72 · sm .78 · md .82 · lg .86 ·
  xl .9 · 2xl .95 · base 1 · h3 1.1 · h2 1.2 · h1 1.4 · hero 1.6. The Aa
  picker's text size (S/M/L/XL) scales the root, so sizes stay in rem.
- Weights: 400 body, 500 labels, 600 names and buttons, 700 headings and
  numbers.
- Two number sizes only: **hero** (`--fs-hero`, the one headline figure)
  and **card** (`--fs-h2`, every other stat). Section labels are
  `--fs-2xs`, uppercase, `--muted`, letter-spacing .05em.
- Line length ≤ 75 characters; body ≥ 14 px at the M size.

## Spacing

4-px grid: 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 20 · 24 · 28. Cards pad
16–20 px, rows 8–12 px, page gutter 24 px (14 px on phone). Grid gaps 8–14 px.
Content width: full width of the main column; dialogs max 560 px.

## Shape and depth

Radius scale (`--r-*`): xs 4 · sm 8 · md 10 · lg 12 · xl 16 · pill 999.
- Buttons and inputs `--r-md`; cards `--r-xl`; small tags `--r-pill`;
  avatars 50 %.
- Shadow: `--shadow` on cards only; dialogs `0 10px 30px rgba(17,20,42,.18)`.
  Nothing else casts a shadow.

## Components

- **Button** primary (solid `--brand`, white text), secondary (white,
  `--line` border), ghost (no border), danger (white, `--danger` text and
  border). Min height 44 px on phone, 38 px in dense rows. Hover: tint; focus:
  2 px `--brand` outline; disabled: 50 % opacity.
- **Chip / segment**: `--bg-2` default, soft purple when selected.
- **Card**: `--surface`, 1 px `--line`, `--r-xl`, title row with a one-line
  hint on the right.
- **Stat card**: label (2xs uppercase) · number (card size) · sub-line
  (muted). Hero card takes the gradient.
- **Table / list row**: 8–12 px padding, `--line` dividers, numbers right
  aligned and tabular.
- **Status pill**: soft background + matching text + the word.
- **Progress bar**: 6–10 px, `--bg-2` track, status colour fill, black
  marker for "where it should be".
- **Dialog**: centred, max 560 px, header with ✕, dark save bar for long
  forms (`--ink` background, `--surface` text).
- **Navigation**: desktop = white sidebar with groups (Work / Admin / Manage,
  each foldable); phone = bottom bar with **four** tabs (Dashboard, Clients,
  Live videos, Payments) and **More** for the rest. Admin pages only show
  for admins.

## Icons and imagery

- Inline stroke SVG icons, 2 px stroke, round caps, 17–22 px. Emoji only as
  task-type markers inside lists (📨 🔁 ✍️), never as navigation icons.
- Facebook Page pictures come from Meta and are shown round; post pictures
  are 4:3 thumbnails with `--r-md`.

## Writing

Sentence case. Short labels. Khmer for client-facing text (reports, plans,
to-do titles), English for admin and settings. Say what happened, not what
the system did ("Plan sent to DC Shop", not "Request succeeded").
