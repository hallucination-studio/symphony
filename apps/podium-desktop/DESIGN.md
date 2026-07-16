---
version: alpha
name: Podium Desktop
description: Visual identity tokens for the Symphony Podium Desktop.
colors:
  surface-muted: "#fafafa"
  surface: "#ffffff"
  border: "#e5e7eb"
  border-strong: "#d1d5db"
  text: "#18181b"
  text-muted: "#6b7280"
  text-subtle: "#9ca3af"
  primary: "#4f46e5"
  primary-hover: "#4338ca"
  primary-soft: "#eef2ff"
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
  h1:
    fontFamily: system-ui
    fontSize: 22px
    fontWeight: "600"
    lineHeight: 28px
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
---

# Podium Desktop visual rules

This file governs visual presentation only. Product behavior, navigation,
runtime boundaries, and workflow semantics come exclusively from
`docs/architecture/`.

- Preserve the near-white surface stack, hairline borders, one indigo
  interaction color, and the existing semantic status palette.
- Use the CSS custom properties in `src/styles/tokens.css`; do not introduce a
  second token system.
- Keep the 232px sidebar and approximately 960px main reading column.
- Use the existing spacing, type, and radius scales. Do not introduce web
  fonts, decorative gradients, dense dashboard styling, or heavy shadows.
- Keep one visually primary action per view.
- Status must use text in addition to color.
- Narrow layouts may hide secondary metadata, but never the next action or an
  actionable error.
- Never display secrets, absolute local paths, Provider handles, raw logs, or
  SDK payloads.
