# music-bot Design System

## 1. Atmosphere & Identity

A Discord-native control room for music playback: dark, high-contrast, and built to feel like an extension of Discord itself rather than a separate product. The signature is a near-black app background with Discord's blurple accent, plain surface panels, and no decorative chrome beyond a soft radial glow behind the page — calm enough for an always-open dashboard, familiar enough that Discord users don't have to relearn a visual language.

## 2. Color

### Palette

All color lives in `web/src/styles.css` as CSS custom properties on `:root`. There is a single dark theme (`color-scheme: dark`) — no light-mode variant.

| Role | Token | Value | Usage |
|------|-------|-------|-------|
| Surface/app background | `--bg-app` | `#1e1f22` | `<body>` background, base page color |
| Surface/base | `--bg-base` | `#313338` | Reserved base surface tone |
| Surface/panel | `--bg-surface` | `#2b2d31` | `.panel`, `.auth-card`, `.hero-preview`, `.feature-card` |
| Surface/raised | `--bg-surface-raised` | `#35373c` | Nested controls: queue rows, service tabs, transport buttons |
| Surface/floating | `--bg-floating` | `#111214` | Reserved for floating/overlay surfaces |
| Surface/input | `--bg-input` | `#1e1f22` | Text inputs |
| Accent/primary | `--accent` | `#5865f2` | Primary buttons, brand mark, focus ring companion, live-track glow |
| Accent/hover | `--accent-hover` | `#4752c4` | Primary button hover |
| Accent/active | `--accent-active` | `#3c45a5` | Primary button active/pressed |
| Accent/soft | `--accent-soft` | `rgb(88 101 242 / 0.16)` | Selected tab/list-item background, status message background, avatar background |
| Status/success | `--success` | `#23a55a` | "Playing" status dot, live-track ring |
| Status/success-soft | `--success-soft` | `rgb(35 165 90 / 0.16)` | "Playing" status chip background, admin log success badge |
| Status/danger | `--danger` | `#da373c` | Destructive button hover/active |
| Status/danger-hover | `--danger-hover` | `#a12828` | Reserved stronger danger tone |
| Status/danger-soft | `--danger-soft` | `rgb(218 55 60 / 0.16)` | Ghost-danger button default state, "Stop" transport button |
| Status/warning | `--warning` | `#f0b132` | "Paused" status dot, relink-warning button |
| Status/warning-soft | `--warning-soft` | `rgb(240 177 50 / 0.14)` | Relink-warning banner background |
| Text/primary | `--text-primary` | `#f2f3f5` | Headings, primary body copy, selected-item text |
| Text/secondary | `--text-secondary` | `#b5bac1` | Ghost-button text, username, unselected tab text |
| Text/muted | `--text-muted` | `#949ba4` | Eyebrows, placeholders, metadata, empty-state copy |
| Text/link | `--text-link` | `#00a8fc` | Anchors, focus outline color, avatar-initial text |
| Border/default | `--border` | `rgb(255 255 255 / 0.06)` | Panel borders |
| Border/strong | `--border-strong` | `rgb(255 255 255 / 0.14)` | Input borders, ghost-button hover background |
| Shadow/panel | `--shadow-panel` | `0 8px 24px rgb(0 0 0 / 0.28)` | Panels, auth card, landing hero/feature cards |
| Shadow/floating | `--shadow-floating` | `0 16px 40px rgb(0 0 0 / 0.4)` | Reserved for floating/overlay elements |

### Rules

- `--accent` (Discord blurple) is reserved for primary actions, brand marks, and the one currently-selected item in a tab/list group — never for large background fills.
- Semantic status colors (`--success`/`--warning`/`--danger`) always pair a solid tone (dot, badge text, hover fill) with a `-soft` translucent tone (chip/banner background) — never use the solid tone as a large background.
- Public (landing/help) and authenticated (dashboard/admin) surfaces share the same token set — there is no separate "marketing" palette.
- Add a new semantic variable to `styles.css`'s `:root` before introducing a new visual color anywhere else.

## 3. Typography

### Font Stack

- Primary: `"gg sans", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif` — `"gg sans"` first to match Discord's own client where the font is installed/available, falling back to Inter/system fonts otherwise.
- No separate monospace stack is declared; none of the UI currently needs one.

### Observed Scale

There is no formal type-scale token table (unlike the spacing scale below) — sizes are set ad hoc per component in rem/em. Representative sizes in use:

| Usage | Size | Weight | Notes |
|-------|------|--------|-------|
| Landing hero H1 | `clamp(2.4rem, 6.5vw, 4.6rem)` | inherited (bold via heading default) | `letter-spacing: -0.03em`, `line-height: 1.05` |
| Landing section H2 | `clamp(1.55rem, 3vw, 2.15rem)` | inherited | `letter-spacing: -0.02em` |
| Dashboard H1 | `1.4rem` | inherited | `letter-spacing: -0.01em` |
| Track title | `1.2rem` | 700 | `.track-title`, `.preview-track p` |
| Feature/panel H3 | `1.15rem` | inherited | `.feature-card h3` |
| Section heading H2 | `1.05rem` | inherited | `.section-heading h2` |
| Landing lead copy | `1.05rem` | inherited | `line-height: 1.7` |
| Body/default | `1rem` (browser default) | 400 | Unset elements |
| User chip name | `0.88rem` | 600 | `.user-name` |
| Metadata/small | `0.76rem`–`0.85rem` | 400–700 | Eyebrows, chip labels, queue/review `<small>` |

### Rules

- Eyebrow labels (`.eyebrow`) are always uppercase, `0.72rem`, weight 700, `letter-spacing: 0.02em`, colored `--text-muted`.
- Tight negative letter-spacing (`-0.01em` to `-0.03em`) is reserved for headings (H1/H2); body text never uses it.

## 4. Spacing & Layout

### Scale

Defined as CSS custom properties in `styles.css`, base unit 4px. Only used consistently by `landing.css`; `dashboard.css` mixes scale tokens with hand-written pixel values (e.g. `padding: 20px`, `gap: 16px`) rather than referencing `--space-*` throughout — treat the token scale as the target for new dashboard CSS, not yet a strictly-enforced rule.

| Token | Value |
|-------|-------|
| `--space-1` | 4px |
| `--space-2` | 8px |
| `--space-3` | 12px |
| `--space-4` | 16px |
| `--space-5` | 20px |
| `--space-6` | 24px |
| `--space-7` | 28px |
| `--space-8` | 32px |
| `--space-10` | 40px |
| `--space-12` | 48px |
| `--space-16` | 64px |
| `--space-20` | 80px |

### Grid

- Dashboard shell max width: 1360px (`.dashboard-shell`).
- Landing/help page max width: 1180px (`.landing-page`).
- Dashboard grid (`.dashboard-grid`): named-area CSS grid, two columns (`minmax(0, 1.3fr) minmax(300px, 1fr)`) above 860px — `now`/`controls`/`autoplay`/`playlist`/`review`/`builder` stack in the left column, `queue` spans the full right column height. Collapses to a single column below 860px.
- Landing hero: two-column grid (`minmax(0, 1.05fr) minmax(320px, 0.95fr)`), collapses to one column below 860px.
- Admin grid (`.admin-grid`): single-column stack of `PermissionMatrix` / `VisibilityPanel` / `OperationLogTable`.

### Rules

- The single breakpoint across the whole app is `max-width: 860px` (both `dashboard.css` and `landing.css`) — there is no intermediate tablet breakpoint.
- Public content (landing/help) must stay usable at narrow widths without horizontal scroll; `.admin-table-wrap` explicitly opts into horizontal scroll for wide tabular data instead.

## 5. Components

### Panel Card
- **Structure**: `<section>`/`<article>` with `.panel` (dashboard) or `.auth-card`/`.hero-preview`/`.feature-card` (auth/landing), each with an optional `.section-heading` (eyebrow + `<h2>`).
- **Style**: `1px solid var(--border)`, `border-radius: 12px` (16px for `.hero-preview`/`.feature-card`), `background: var(--bg-surface)`, `box-shadow: var(--shadow-panel)`.
- **Variants**: dashboard panel (`padding: 20px`), auth card (`max-width: 460px; padding: 32px`), landing hero/feature card.
- **States**: static; no hover state on the card itself.
- **Layout**: dashboard panels are grid-area children of `.dashboard-grid`; landing/feature cards sit in `.feature-grid` (`repeat(3, minmax(0, 1fr))`, collapsing to 1 column at 860px).

### Primary / Ghost / Danger Button
- **Structure**: native `<button>` or `.primary-link` anchor.
- **Variants**:
  - Primary: solid `--accent` background, white text (default `button`/`.primary-link` style in `styles.css`).
  - Ghost: `button.ghost-button`/`.secondary-link` — `--bg-surface-raised` background, `--text-secondary` text, hovers to `--border-strong` background + `--text-primary` text.
  - Ghost-danger: `.ghost-danger` — transparent background, `1px solid var(--danger)` border, `--danger` text; hovers to `--danger-soft` background (or solid `--danger` + white text for the transport dock's own `.danger` variant).
- **States**: hover darkens/fills background; `:active` translates 1px and shifts to `--accent-active`; `:disabled` drops opacity to 0.45 and sets `cursor: not-allowed`; `:focus-visible` gets a 2px `--text-link`-colored outline with 2px offset.
- **Sizing**: `min-height: 40px` standard; queue/action buttons inside panels use a denser `min-height: 32px`.
- **Motion**: 120ms `ease` transitions on `transform`, `background`, `border-color`.

### Status Chip / Badge
- **Structure**: inline `<span>` pairing a small color dot (`.status-dot`) with a label, or a plain rounded label (`.log-badge`).
- **Variants**: `.vc-status-chip.status-playing` (success tones, pulsing dot via `@keyframes speaking-pulse`), `.status-paused` (warning tones, static dot), `.log-badge-success`/`.log-badge-fail` (admin operation log).
- **Motion**: the playing-status dot pulses a `box-shadow` ring on a 1.8s `ease-out` loop; nothing else animates continuously.

### Form Row
- **Structure**: `<label>` wrapping an uppercase eyebrow-style `<span>` and an `<input>`, or a small `<form>` grid (create/rename/search rows) pairing an input with a submit button.
- **Style**: inputs are `--bg-input` background, `1px solid var(--border-strong)`, `border-radius: 8px`, `min-height: 40px`.
- **Layout**: `grid-template-columns: minmax(0, 1fr) auto` (input + button), collapsing to a single column at 860px.

### List Row (queue / review / playlist / search results)
- **Structure**: `<li>` or `<button role="option">` in a `display: grid` list, index/marker + title/subtitle + trailing actions.
- **Style**: `border-radius: 8px`, hover background `--bg-surface-raised`; the queue index badge (`.queue-index`) is a 32px circle in `--accent-soft` with `--text-link` text.
- **States**: `selected` class swaps to `--accent-soft` background + `--accent` border + `--text-primary` text (service tabs, saved-playlist list).

## 6. Motion & Interaction

### Timing

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 120ms | ease | Button hover/active background, transform |
| Ambient | 1.8s | ease-out (loop) | "Playing" status dot pulse (`speaking-pulse`) |

There is no separate "standard"/"emphasis" tier in use today — only the button micro-interaction and the one ambient pulse animation exist in the shipped CSS.

### Rules

- Animate only `transform`, `background`, and `border-color`/`box-shadow`.
- `prefers-reduced-motion: reduce` forces all animation/transition durations to `0.01ms` globally (`styles.css`), including the status-dot pulse.

## 7. Depth & Surface

### Strategy

Flat dark panels with a single soft drop-shadow family — no translucency/glassmorphism, no layered blurs. The only atmospheric depth cue is a fixed radial gradient glow behind the page body and behind the landing hero preview card.

| Level | Value | Usage |
|-------|-------|-------|
| Panel | `0 8px 24px rgb(0 0 0 / 0.28)` | `.panel`, `.auth-card`, `.hero-preview`, `.feature-card` |
| Floating | `0 16px 40px rgb(0 0 0 / 0.4)` | Reserved token, not yet applied to a shipped component |
| Page glow | `radial-gradient(circle at 18% -10%, rgb(88 101 242 / 0.16), transparent 38rem)` over `--bg-app` | `<body>` background |
| Hero glow | Two radial gradients (blurple + success green) layered via `.hero-preview::before` | Landing hero preview card only |

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- Every interactive control is a real `<button>`/`<a>`/`<input>` — no clickable non-semantic elements.
- `:focus-visible` gets an explicit 2px outline (`--text-link` color) on inputs, buttons, and links.
- `prefers-reduced-motion: reduce` disables all transitions/animations app-wide.
- No emoji icons in dashboard UI chrome (panel/button labels are text); Discord command replies elsewhere in the product do use emoji, which is out of this design system's scope.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| No formal type-scale tokens | All CSS | Sizes were set ad hoc per component as the UI grew; no regressions observed from the inconsistency so far | Introduce `--font-size-*`/`--line-height-*` tokens if a new page/section makes the drift visible |
| `--space-*` scale not used consistently in `dashboard.css` | `web/src/dashboard.css` | Predates the token scale being introduced via `landing.css`; retrofitting every hand-written pixel value was out of scope for unrelated changes | Migrate `dashboard.css` to the `--space-*` scale opportunistically when touching a given rule |
| `--shadow-floating` / `--bg-floating` tokens unused | `web/src/styles.css` | Reserved ahead of an actual floating/overlay UI (tooltip, popover, modal) that doesn't exist yet | Apply when the first floating UI element ships, or remove if it never materializes |
| React dev inspection tools not installed | Vite app | Small self-hosted project; adding dev-only tooling would change dependencies outside whatever task is in flight | Install when doing a broader frontend tooling pass |
| No component showcase/Storybook | Web UI | Playwright E2E + bun:test component tests cover the current surface area | Add if the component set grows enough that visual regressions become hard to catch by hand |
