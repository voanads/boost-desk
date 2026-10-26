# Boost Desk — design system ("Calm console", Oct 2026)

How every page of Boost Desk should look. The values live as CSS variables in
`public/assets/app.css` (`:root`, and `:root[data-theme=dark]`). Use the
variable names in CSS, never raw values.

## Feel

Calm, clear, fast to scan on a phone at the end of a work day. One
professional blue, white cards on a soft grey ground, **no gradients, no
glows, no background lights** — depth comes from a 1 px line and a faint
shadow. Status told by colour **and** words. Khmer and English sit side by
side, so the type must carry Khmer well. Inspiration: Linear, Stripe, Vercel.

## Colour

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--brand` | `#2563EB` | `#3B82F6` | Links, selected icons, the blue edge on hero cards, bars |
| `--brand-fill` | `#2563EB` | `#2563EB` | Solid fills with white text: the one main button, solid badges |
| `--brand-text` | `#1D4ED8` | `#93C5FD` | Text on `--brand-soft` (selected chips, segments, nav item) |
| `--brand-soft` | `#EEF4FF` | `#1E2A4A` | Selected chips/segments/nav item, soft tags |
| `--bg` / `--bg-2` | `#F6F7F9` / `#F1F3F7` | `#0B1220` / `#172033` | Page ground / inset areas, option boxes |
| `--surface` | `#FFFFFF` | `#111827` | Cards, sidebar, dialogs, inputs |
| `--line` | `#E5E7EB` | `#1F2937` | Borders, dividers |
| `--ink` / `--muted` | `#0F172A` / `#5B6B82` | `#F1F5F9` / `#94A3B8` | Text / secondary text and labels |
| `--ok` + `--ok-soft` | `#047857` / `#ECFDF5` | `#34D399` / `#0F2A22` | Done, on plan, connected, running |
| `--warn` + `--warn-soft` | `#B45309` / `#FFFBEB` | `#FBBF24` / `#2A2210` | Needs attention, ahead of plan, ends today |
| `--danger` (= `--live`) + `--danger-soft` | `#B91C1C` / `#FEF2F2` | `#F87171` / `#3A1719` | Live videos, over budget, late, delete |
| `--on-brand` | `#FFFFFF` | `#FFFFFF` | Text on `--brand-fill` or a solid status colour |

`--grad`, `--grad-hero` and `--ok-grad` still exist for older rules but are
**solid colours** now. Do not add a gradient.

Rules
- **One solid blue button per screen** — the main action (Sync from Meta,
  Save, Send, Add). Everything else is white with a `--line` border, or text.
- **Hero number** (Total spent, Spent this month, per order): a white card
  with a 3 px blue inside edge (`box-shadow: inset 3px 0 0 var(--brand)`)
  and ink text — never a filled card.
- Selected chips, segments and the current sidebar item are **soft blue**
  (`--brand-soft` background, `--brand-text` text), never solid.
- Status colours always come with a word (On plan, Late, Connected). Never
  colour alone. Every status pill passes 4.5:1 on its soft background.
- Dark mode redefines every token above, so a new block must use tokens; a
  raw `#fff` or `#0F172A` breaks in dark mode.
- Text contrast: body ≥ 4.5:1, large numbers ≥ 3:1. `--muted` passes on
  `--surface`, `--bg`, `--bg-2` and `--brand-soft`.

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

Radius scale (`--r-*`): xs 4 · sm 6 · md 8 · lg 10 · xl 12 · pill 999.
- Buttons and inputs `--r-md` (8); cards and dialogs `--r-xl` (12); small
  tags `--r-pill`; avatars 50 %.
- Shadow: `--shadow-sm` (1 px, 4 % ink) on cards; `--shadow-md` on
  dialogs and toasts. Nothing lifts or glows on hover — hover is a tint.

## Components

- **Button** primary (solid `--brand-fill`, white text, hover
  `--brand-hover`), secondary (`--surface`, `--line` border), ghost (no
  border, `--muted` text), danger (`--danger` text, `--line` border, hover
  `--danger-soft`). Min height 44 px on phone, 36 px for small buttons on
  touch screens. Focus: 2 px `--brand` outline; disabled: 55 % opacity.
- **Chip / segment**: `--surface` with a `--line` border, soft blue when
  selected.
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
