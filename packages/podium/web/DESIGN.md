---
version: alpha
name: Podium Console
description: Visual identity for Podium — Symphony's self-serve onboarding console.
colors:
  # Foundation
  surface-muted: "#fafafa"
  surface: "#ffffff"
  border: "#e5e7eb"
  border-strong: "#d1d5db"
  text: "#18181b"
  text-muted: "#6b7280"
  text-subtle: "#9ca3af"
  # Brand
  primary: "#4f46e5"
  primary-hover: "#4338ca"
  primary-soft: "#eef2ff"
  # Status — foreground / tinted background pairs
  status-completed: "#16a34a"
  status-completed-bg: "#f0fdf4"
  status-in-progress: "#2563eb"
  status-in-progress-bg: "#eff6ff"
  status-blocked: "#dc2626"
  status-blocked-bg: "#fef2f2"
  status-not-started: "#9ca3af"
  status-not-started-bg: "#f3f4f6"
typography:
  display:
    fontFamily: system-ui
    fontSize: 26px
    fontWeight: "700"
    lineHeight: 32px
    letterSpacing: 0
  h1:
    fontFamily: system-ui
    fontSize: 22px
    fontWeight: "600"
    lineHeight: 28px
    letterSpacing: 0
  title:
    fontFamily: system-ui
    fontSize: 15px
    fontWeight: "600"
    lineHeight: 20px
  body:
    fontFamily: system-ui
    fontSize: 15px
    fontWeight: "400"
    lineHeight: 22px
  caption:
    fontFamily: system-ui
    fontSize: 13px
    fontWeight: "400"
    lineHeight: 18px
  label-caps:
    fontFamily: system-ui
    fontSize: 11px
    fontWeight: "600"
    lineHeight: 16px
    letterSpacing: 0.04em
  mono:
    fontFamily: ui-monospace
    fontSize: 13px
    fontWeight: "400"
    lineHeight: 20px
rounded:
  sm: 6px
  md: 10px
  lg: 14px
  pill: 999px
spacing:
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  5: 24px
  6: 32px
  8: 48px
components:
  app-shell:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
  sidebar:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    padding: "{spacing.4}"
  nav-link:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "{spacing.2}"
  nav-link-hover:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
  nav-link-active:
    backgroundColor: "{colors.primary-soft}"
    textColor: "{colors.primary-hover}"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "{spacing.5}"
  card-title:
    textColor: "{colors.text}"
    typography: "{typography.title}"
  card-description:
    textColor: "{colors.text-muted}"
    typography: "{typography.caption}"
  page-title:
    textColor: "{colors.text}"
    typography: "{typography.h1}"
  metric-value:
    textColor: "{colors.text}"
    typography: "{typography.display}"
  field-label:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.label-caps}"
  code-inline:
    backgroundColor: "{colors.surface-muted}"
    textColor: "{colors.text}"
    typography: "{typography.mono}"
    rounded: "{rounded.sm}"
    padding: "{spacing.1}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  divider-strong:
    backgroundColor: "{colors.border-strong}"
    height: 1px
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "{spacing.2}"
    height: 38px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "{spacing.2}"
    height: 36px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.surface}"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "{spacing.2}"
    height: 36px
  progress-track:
    backgroundColor: "{colors.border}"
    rounded: "{rounded.pill}"
    height: 6px
  progress-fill:
    backgroundColor: "{colors.primary}"
    rounded: "{rounded.pill}"
    height: 6px
  badge-positive:
    backgroundColor: "{colors.status-completed-bg}"
    textColor: "{colors.text}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.pill}"
  badge-progress:
    backgroundColor: "{colors.status-in-progress-bg}"
    textColor: "{colors.text}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.pill}"
  badge-negative:
    backgroundColor: "{colors.status-blocked-bg}"
    textColor: "{colors.text}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.pill}"
  badge-neutral:
    backgroundColor: "{colors.status-not-started-bg}"
    textColor: "{colors.text}"
    typography: "{typography.label-caps}"
    rounded: "{rounded.pill}"
  badge-dot-positive:
    backgroundColor: "{colors.status-completed}"
    rounded: "{rounded.pill}"
    size: 6px
  badge-dot-progress:
    backgroundColor: "{colors.status-in-progress}"
    rounded: "{rounded.pill}"
    size: 6px
  badge-dot-negative:
    backgroundColor: "{colors.status-blocked}"
    rounded: "{rounded.pill}"
    size: 6px
  badge-dot-neutral:
    backgroundColor: "{colors.status-not-started}"
    rounded: "{rounded.pill}"
    size: 6px
  status-dot-idle:
    backgroundColor: "{colors.text-subtle}"
    rounded: "{rounded.pill}"
    size: 8px
---

## Overview

Podium is the external, self-serve onboarding console for Symphony — the place a
customer lands, creates an account, connects Linear, enrolls a runtime, and
watches their onboarding checklist turn green. It is **onboarding-first, not an
ops dashboard**. Every screen should feel like a calm, legible setup wizard that
a first-time operator can finish without a call.

The personality is **quiet SaaS utility**: near-white canvas, one confident
indigo accent, generous whitespace, and hairline borders instead of heavy
shadows. Nothing decorative competes with the task at hand. When a screen feels
"boring but obvious," it is correct. Reach for restraint before reaching for
color, motion, or elevation.

This file is the single source of truth for Podium's look. Treat the YAML tokens
as normative — they mirror the CSS custom properties in
`src/styles/tokens.css`. When you add UI, consume these tokens (via those CSS
variables); do not hardcode hex values, font sizes, or radii.

## Colors

The palette is a restrained neutral scale plus **one** brand accent and a
semantic status set. Color carries meaning here — it is never ornament.

- **Surfaces:** `surface-muted` (#fafafa) is the app canvas; `surface` (#ffffff)
  is every card, panel, and input. The whole product lives in this two-step
  near-white stack — resist introducing darker fills.
- **Text:** `text` (#18181b) for primary copy, `text-muted` (#6b7280) for
  descriptions and metadata, `text-subtle` (#9ca3af) for uppercase eyebrow
  labels and idle indicators only. Do not use `text-subtle` for anything a user
  must read as content.
- **Borders:** `border` (#e5e7eb) is the default hairline; `border-strong`
  (#d1d5db) marks interactive or emphasized edges (secondary buttons, focused
  inputs). Structure comes from borders, not shadows.
- **Brand:** `primary` (#4f46e5 indigo) is the **sole** interaction color —
  primary buttons, active nav, progress fill, links. `primary-hover` (#4338ca)
  is its pressed/hover state; `primary-soft` (#eef2ff) is the tint behind the
  active nav item. One accent, used consistently, is the whole brand.
- **Status:** each onboarding/health state pairs a saturated foreground with a
  tinted background — completed (green), in-progress (blue), blocked (red),
  not-started (gray). Badges render **dark text on the tint** with a small
  saturated dot for the hue, keeping labels readable while still color-coded.

## Typography

One family — the **system UI stack** (`system-ui` / `-apple-system`) — with
`ui-monospace` reserved for commands, tokens, and IDs. No web fonts: onboarding
must paint instantly and never flash.

- **`display` (26px/700):** big single numbers, e.g. the onboarding progress
  count. Used sparingly, one per view at most.
- **`h1` (22px/600):** page titles in the header.
- **`title` (15px/600):** card headings and section labels.
- **`body` (15px/400):** default UI and prose copy.
- **`caption` (13px/400):** card descriptions, hints, secondary metadata.
- **`label-caps` (11px/600, +0.04em, uppercase):** eyebrow labels and badge
  text. Uppercase is reserved for these — never uppercase body or buttons.
- **`mono` (13px):** install commands, runtime IDs, tokens. Always render
  copyable command strings in mono.

Tighten letter-spacing slightly on large headings (`-0.01em` to `-0.02em`);
leave body at default. Weight, not size, carries most of the hierarchy.

## Layout

A fixed **232px sidebar** (brand, nav, account chip pinned to the bottom) beside
a scrollable main column capped at ~960px so reading lines stay short. Content
is a vertical stack of cards separated by `spacing.4` (16px).

- **Spacing scale** is an implicit 4px grid: `1`=4, `2`=8, `3`=12, `4`=16,
  `5`=24, `6`=32, `8`=48. Compose padding and gaps from these steps only.
- **Card padding** is `spacing.5` (24px); **main padding** is `spacing.6`
  vertical, `spacing.8` horizontal. Let whitespace, not rules, group things.
- **One primary action per view.** The onboarding "next step" is always the most
  prominent element; everything else is secondary or ghost.
- Auth screens (`/login`, `/register`) render **outside** the shell as a single
  centered `max-width: 400px` card on the muted canvas.

## Elevation & Depth

Depth is expressed through **borders and near-white layering**, not heavy
shadows. This is a flat, papery interface.

- Cards sit on the canvas with a 1px `border` and only a whisper of shadow
  (`0 1px 2px rgba(16,24,40,0.05)`). Reserve the slightly deeper
  `0 4px 12px rgba(16,24,40,0.08)` for genuinely floating surfaces — the auth
  card, menus, toasts.
- Never stack multiple shadow levels to fake hierarchy; move up the surface/
  border steps first. If two things need separating, a hairline `divider`
  usually beats a shadow.

## Shapes

Soft, consistent rounding: `sm` (6px) for buttons, inputs, nav items and most
controls; `md` (10px) for cards; `lg` (14px) for the large auth card; `pill`
(999px) for badges, dots, and progress bars. Pick the radius by element role,
and keep controls that sit together on the same step.

## Components

- **Buttons:** `button-primary` is solid indigo with white text for the single
  key action; `button-secondary` is white with a `border-strong` edge; ghost
  buttons are transparent muted text for tertiary actions. All share `sm`
  rounding and ~36px height. Buttons use sentence case, never uppercase.
- **Cards:** white, hairline-bordered, 24px padding, with a `title` heading and
  optional `caption` description in the header. Cards are the primary content
  container — group one concern per card.
- **Badges (`StatusBadge`):** pill with tinted background, dark `label-caps`
  text, and a leading saturated dot (`badge-dot-*`) for the status hue. Use the
  tone that matches state: positive/progress/negative/neutral.
- **Inputs:** white field, `border` at rest, `border-strong`/`primary` on focus,
  `sm` rounding, mono for anything that echoes a token or command.
- **Onboarding progress:** a `display`-sized "n / total" count above a `pill`
  progress bar (`primary` fill on `border` track) and a step list. This is the
  emotional center of the product — keep it prominent and always current.
- **Account chip:** pinned bottom-left in the sidebar, showing workspace/session
  identity with a small status dot. Never render tokens or secrets here.

## Do's and Don'ts

- **Do** consume tokens through the `src/styles/tokens.css` CSS variables
  (`--color-*`, `--space-*`, `--radius-*`, `--font-*`). If a value you need
  isn't a token, add the token here first, then use it.
- **Do** keep indigo as the only accent and reserve status colors for real
  state. One accent is the brand.
- **Do** lead every view with a single, obvious primary action and let the
  onboarding checklist stay front-and-center.
- **Don't** hardcode hex codes, pixel font sizes, or radii in components — that
  silently forks the design system.
- **Don't** introduce new fonts, gradients, decorative color, or heavy shadows.
  Depth comes from borders and near-white layering.
- **Don't** render Linear access/refresh tokens, session cookies, passwords, or
  client secrets in any surface. This is a hard product invariant, not a style
  preference.
- **Don't** turn Podium into a dense ops dashboard; if a screen stops feeling
  like calm setup, reconsider it.
