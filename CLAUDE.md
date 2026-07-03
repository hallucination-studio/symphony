# CLAUDE.md

Operating notes for Claude Code (and other agents) working in the Symphony repo.

## Read this first

The canonical, detailed agent guide is [`AGENT.md`](./AGENT.md) — product
positioning, package/import boundaries, coding standards, standard commands, and
the mandatory real-run verification rules all live there. Read it before making
changes.

## Podium UI changes: read DESIGN.md first (mandatory)

Podium (`packages/podium/web`) is the only user-facing surface. **Before making
any UI change to it, read [`packages/podium/web/DESIGN.md`](./packages/podium/web/DESIGN.md)
and follow it.** This applies to every frontend edit, however small — new
components, tweaks, and refactors alike.

- The DESIGN.md YAML tokens are normative and mirror the CSS custom properties in
  `packages/podium/web/src/styles/tokens.css`. Consume design values through
  those `--color-*`, `--space-*`, `--radius-*`, and `--font-*` variables. Do not
  hardcode hex codes, pixel font sizes, or radii.
- Need a value that isn't a token yet? Add it to DESIGN.md (and `tokens.css`)
  first, then use it. Keep the two in sync.
- After editing DESIGN.md, keep the lint clean (0 errors, 0 warnings):

  ```bash
  cd packages/podium/web && npm run design:lint
  ```

- Podium is onboarding-first and deliberately restrained: one indigo accent,
  near-white surfaces, hairline borders over heavy shadows, system fonts only,
  one primary action per view. Never render Linear tokens, session cookies,
  passwords, or client secrets in the UI.

## Standard checks

- Frontend lint: `cd packages/podium/web && npm run lint`
- Design tokens lint: `cd packages/podium/web && npm run design:lint`
- Full suite: `make test` (see `AGENT.md` for focused and real-run commands).
