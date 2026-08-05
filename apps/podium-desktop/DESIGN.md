---
version: beta
name: Podium Desktop
description: Visual identity tokens for the Symphony Podium Desktop, following the Apple Human Interface Guidelines.
colors:
  light-window-bg: "#e9e9ee"
  light-content-bg: "#f5f5f7"
  light-card-bg: "#ffffff"
  light-separator: "rgba(0, 0, 0, 0.08)"
  light-separator-strong: "rgba(0, 0, 0, 0.16)"
  light-label: "rgba(0, 0, 0, 0.85)"
  light-label-secondary: "rgba(0, 0, 0, 0.5)"
  light-label-tertiary: "rgba(0, 0, 0, 0.26)"
  light-accent: "#007aff"
  light-accent-hover: "#0062cc"
  light-accent-soft: "rgba(0, 122, 255, 0.12)"
  light-focus-halo: "rgba(0, 122, 255, 0.35)"
  light-overlay: "rgba(0, 0, 0, 0.25)"
  light-selection: "rgba(0, 0, 0, 0.06)"
  light-accent-contrast: "#ffffff"
  dark-window-bg: "#26262b"
  dark-content-bg: "#1e1e1e"
  dark-card-bg: "#2c2c2e"
  dark-separator: "rgba(255, 255, 255, 0.12)"
  dark-separator-strong: "rgba(255, 255, 255, 0.22)"
  dark-label: "rgba(255, 255, 255, 0.85)"
  dark-label-secondary: "rgba(255, 255, 255, 0.55)"
  dark-label-tertiary: "rgba(255, 255, 255, 0.25)"
  dark-accent: "#0a84ff"
  dark-accent-hover: "#409cff"
  dark-accent-soft: "rgba(10, 132, 255, 0.24)"
  dark-focus-halo: "rgba(10, 132, 255, 0.45)"
  dark-overlay: "rgba(0, 0, 0, 0.5)"
  dark-selection: "rgba(255, 255, 255, 0.1)"
  status-green: "#34c759"
  status-green-dark: "#30d158"
  status-red: "#ff3b30"
  status-red-dark: "#ff453a"
  status-orange: "#ff9500"
  status-orange-dark: "#ff9f0a"
  status-gray: "#8e8e93"
  status-gray-dark: "#98989d"
  status-red-soft: "rgba(255, 59, 48, 0.12)"
  status-red-soft-dark: "rgba(255, 69, 58, 0.18)"
font-weights:
  regular: "400"
  medium: "500"
  semibold: "600"
  bold: "700"
typography:
  display:
    fontFamily: system-ui
    fontSize: 26px
    fontWeight: "700"
    lineHeight: 32px
  h1:
    fontFamily: system-ui
    fontSize: 22px
    fontWeight: "700"
    lineHeight: 27px
  title:
    fontFamily: system-ui
    fontSize: 13px
    fontWeight: "600"
    lineHeight: 16px
  body:
    fontFamily: system-ui
    fontSize: 13px
    fontWeight: "400"
    lineHeight: 16px
  caption:
    fontFamily: system-ui
    fontSize: 11px
    fontWeight: "400"
    lineHeight: 13px
  label-caps:
    fontFamily: system-ui
    fontSize: 11px
    fontWeight: "600"
    lineHeight: 13px
    letterSpacing: 0.04em
  mono:
    fontFamily: ui-monospace
    fontSize: 11px
    fontWeight: "400"
    lineHeight: 16px
rounded:
  control: 6px
  card: 10px
  dialog: 12px
  pill: 999px
metrics:
  control-height: 28px
  sidebar-width: 232px
  content-column: 840px
shadows:
  button: "0 0.5px 1.5px rgba(0, 0, 0, 0.12)"
  button-dark: "0 0.5px 1.5px rgba(0, 0, 0, 0.4)"
  dialog: "0 12px 40px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(0, 0, 0, 0.06)"
  dialog-dark: "0 12px 40px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.08)"
z-index:
  drag-region: 1
  dialog: 100
motion:
  duration-instant: 80ms
  duration-fast: 140ms
  duration-standard: 220ms
  duration-slow: 320ms
  duration-brand: 600ms
  duration-sweep: 1400ms
  duration-pulse: 2s
  duration-stagger: 30ms
  duration-spin: 700ms
  easing-standard: cubic-bezier(0.2, 0, 0, 1)
  easing-emphasized: cubic-bezier(0.34, 1.3, 0.64, 1)
  easing-continuous: linear
spacing:
  1: 4px
  2: 8px
  3: 12px
  4: 16px
  5: 24px
  6: 32px
  8: 48px
---

# Podium Desktop visual rules

This file governs visual presentation only. Product behavior, navigation,
runtime boundaries, and workflow semantics come exclusively from
`docs/architecture/`.

The visual language follows the Apple Human Interface Guidelines for macOS:

- The window uses an overlay title bar with inset traffic lights and a
  translucent NSVisualEffectView sidebar material (Tauri `windowEffects`).
  The opaque `window-bg` tokens are fallbacks for non-Tauri hosts and for
  environments where the private API is unavailable.
- Light and dark appearances are both normative. Every color token has a
  light and a dark value, switched via `prefers-color-scheme`. Do not
  hard-code appearance-specific values outside `tokens.css`.
- One accent color: macOS system blue (`#007aff` light, `#0a84ff` dark).
  Semantic status colors come from the macOS system palette and must always
  be paired with text or an icon; color is never the only signal.
- Base font size is 13px (SF Pro via `system-ui`). Use the type scale above;
  do not introduce web fonts, decorative gradients, or dense dashboard
  styling. The mono face (`ui-monospace`) is for identifiers, log event
  kinds, and command literals — not for prose.
- Controls use macOS metrics: 28px-high push buttons with 6px radius,
  5-6px radius inputs, and a translucent accent focus halo instead of a
  hard outline.
- Content is presented as inset grouped lists (System Settings style):
  10px-radius cards on the content background, hairline separators between
  rows. Keep the 232px sidebar and a main reading column of at most 840px.
- Keep one visually primary action per view.
- Motion is fast and purposeful: 80-320ms ease-out transitions on
  transform/opacity only (no layout shift), tokenized durations and
  easings, and everything must collapse under `prefers-reduced-motion`.
  Status color animation never carries meaning alone.
- Narrow layouts may hide secondary metadata, but never the next action or
  an actionable error.
- Never display secrets, absolute local paths, Provider handles, raw logs,
  or SDK payloads.
- Use the CSS custom properties in `src/styles/tokens.css`; do not introduce
  a second token system. `src/styles/layout.css` must not contain raw color
  values, numeric font weights, or raw spacing-scale values (4/8/12/16/24/32/
  48px) in margin, padding, or gap declarations; use the font-weight, size,
  spacing, and z-index tokens instead. Animations and transitions must use
  the motion tokens; raw durations or easings are not allowed in
  `layout.css` outside keyframe definitions. Every color value in
  `tokens.css` must
  be declared in the YAML manifest above (checked both directions).
