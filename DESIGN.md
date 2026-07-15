# music-bot Design System

## 1. Atmosphere & Identity

A quiet Discord control room for music playback: calm, utilitarian, and trustworthy rather than promotional. The signature is a sage-tinted glass panel over a soft botanical background, making a self-hosted music tool feel approachable while keeping operational controls legible.

## 2. Color

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Surface/page | `--color-page` | `#eef3ee` | n/a | Browser background fallback |
| Surface/page-start | `--color-page-start` | `#f7faf6` | n/a | Body gradient start |
| Surface/page-mid | `--color-page-mid` | `#e6eee7` | n/a | Body gradient midpoint |
| Surface/page-end | `--color-page-end` | `#dfe9e4` | n/a | Body gradient end |
| Surface/panel | `--color-panel` | `rgb(255 255 255 / 0.74)` | n/a | Cards, dashboard panels, auth card |
| Surface/solid | `--color-solid` | `#ffffff` | n/a | Status and nested controls |
| Surface/muted | `--color-muted` | `#eef3ee` | n/a | Metadata chips, queue indices |
| Text/primary | `--color-text` | `#17211b` | n/a | Headings and main copy |
| Text/secondary | `--color-text-muted` | `#5c6f62` | n/a | Eyebrows, captions, hints |
| Text/body-muted | `--color-body-muted` | `#425447` | n/a | Auth and landing body copy |
| Border/default | `--color-border` | `rgb(36 66 49 / 0.14)` | n/a | Panel borders |
| Border/control | `--color-border-control` | `#b8c7ba` | n/a | Inputs |
| Border/subtle | `--color-border-subtle` | `#d7e1d9` | n/a | List rows and tabs |
| Accent/primary | `--color-accent` | `#244231` | n/a | Primary buttons and focus |
| Accent/hover | `--color-accent-hover` | `#315c43` | n/a | Button hover, links |
| Accent/soft | `--color-accent-soft` | `#97b29d` | n/a | Album fallback gradient |
| Status/danger | `--color-danger` | `#874334` | n/a | Destructive actions |
| Status/warning-bg | `--color-warning-bg` | `#fff6e8` | n/a | Relink warning surface |
| Status/warning-border | `--color-warning-border` | `#e4bd80` | n/a | Relink warning border |

### Rules
- The green accent is reserved for navigation, confirmation, and actionable controls.
- Public landing content uses the same palette so the transition into the dashboard feels continuous.
- Add semantic variables here before introducing new visual colors.

## 3. Typography

### Scale

| Level | Size | Weight | Line Height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Display | `clamp(2.75rem, 8vw, 6.8rem)` | 800 | 0.92 | -0.055em | Landing hero headline |
| H1 | `clamp(2rem, 5vw, 4.5rem)` | 760 | 1 | 0 | Dashboard title |
| H2 | `clamp(1.65rem, 3vw, 2.35rem)` | 760 | 1.05 | -0.025em | Landing section headings |
| H3 | `1.3rem` | 760 | 1.25 | 0 | Track/card titles |
| Body/lg | `1.08rem` | 450 | 1.7 | 0 | Landing lead copy |
| Body | `1rem` | 400 | 1.55 | 0 | Default text |
| Body/sm | `0.875rem` | 400 | 1.5 | 0 | Secondary text |
| Caption | `0.78rem` | 500 | 1.4 | 0 | Metadata |
| Overline | `0.76rem` | 700 | 1.3 | 0 | Eyebrows, uppercase labels |

### Font Stack
- Primary: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- Mono: system monospace only if future technical identifiers need it.

### Rules
- Body text never drops below 14px.
- Tight headline tracking is allowed only for display/H1 sizes.

## 4. Spacing & Layout

### Base Unit
All spacing derives from a base of **4px**.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Tight inline separation |
| `--space-2` | 8px | Compact gaps, radius baseline |
| `--space-3` | 12px | Form and list internal gaps |
| `--space-4` | 16px | Standard section/card gap |
| `--space-5` | 20px | Header/card padding |
| `--space-6` | 24px | Page padding mobile/auth |
| `--space-7` | 28px | Dashboard shell padding |
| `--space-8` | 32px | Landing card padding |
| `--space-10` | 40px | Hero groups |
| `--space-12` | 48px | Section breaks |
| `--space-16` | 64px | Landing section vertical rhythm |
| `--space-20` | 80px | Hero top/bottom padding |

### Grid
- Max dashboard width: 1360px.
- Max landing width: 1180px.
- Dashboard: two-column grid above 860px, single-column below.
- Landing: responsive document flow using auto-fit grids and one-column mobile collapse.

### Rules
- Use CSS intrinsic sizing and `clamp()` for mechanics; token values describe design intent.
- Public content must stay readable at 320px without horizontal scroll.

## 5. Components

### Panel Card
- **Structure**: section/article with `.panel` or `.auth-card`/landing panel class, optional heading and body.
- **Variants**: dashboard panel, auth card, landing feature/stat/preview panel.
- **Spacing**: `--space-4` to `--space-8` depending on density.
- **States**: static by default; interactive cards use link/button states instead of card hover.
- **Accessibility**: semantic heading order; no card-as-button unless the whole card is an anchor.
- **Motion**: none except child CTA micro-interactions.
- **Layout**: stack/grid; no internal scroll owner.

### Primary Action
- **Structure**: `<button>` or `<a>` with `.primary-link`/button styling.
- **Variants**: primary, danger, ghost-danger, secondary link.
- **Spacing**: min-height 40px, horizontal padding from `--space-3`/`--space-4`.
- **States**: hover changes accent tone, active translates 1px, disabled lowers opacity, focus uses browser-visible outline plus accent color.
- **Accessibility**: real button/link element matching behavior.
- **Motion**: 140ms transform/background/border transitions.
- **Layout**: inline cluster.

### Landing Hero
- **Structure**: header/nav, hero copy, CTA cluster, product preview object.
- **Variants**: public only.
- **Spacing**: `--space-10`/`--space-20` hero rhythm.
- **States**: CTA hover/focus/active only.
- **Accessibility**: single H1, descriptive links, no auto-moving content.
- **Motion**: none by default; static dimensional CSS art.
- **Layout**: two-column hero that collapses to one column.

### Form Row
- **Structure**: label wrapping text and input, optional action button.
- **Variants**: guild selector, search row.
- **Spacing**: `--space-2`/`--space-3`.
- **States**: input focus visible; disabled button state.
- **Accessibility**: visible label text.
- **Motion**: none.
- **Layout**: grid.

## 6. Motion & Interaction

### Timing

| Type | Duration | Easing | Usage |
|------|----------|--------|-------|
| Micro | 140ms | ease | Button hover/press |
| Standard | 200ms | ease-in-out | Future panel state changes |
| Emphasis | 400ms | cubic-bezier(0.16, 1, 0.3, 1) | Reserved for future page transitions |

### Rules
- Animate only `transform`, `opacity`, `background`, and border/color transitions.
- Respect `prefers-reduced-motion` by removing transitions.

## 7. Depth & Surface

### Strategy
Mixed: translucent panels with subtle borders and a single soft shadow family.

| Level | Value | Usage |
|-------|-------|-------|
| Panel | `0 18px 50px rgb(31 51 39 / 0.08)` | Dashboard/auth/landing panels |
| Hero object | layered radial gradients plus panel shadow | Landing preview card |

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- Target WCAG 2.2 AA: 4.5:1 body contrast, 3:1 large text/non-text UI.
- Every interactive control must be reachable by keyboard with visible focus.
- Use semantic landmarks: header/nav/main/section/footer where applicable.
- No emoji icons in UI. Use text labels or CSS/SVG primitives.
- `prefers-reduced-motion` disables non-essential transitions.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| React dev inspection tools not installed | Vite app | Existing small project; task is a focused landing/auth route fix and adding dev-only tooling would change dependencies outside the request. | Install when doing a broader frontend performance pass. |
| Primitive showcase not added | Web UI | Existing UI extraction task; Playwright browser QA covers public/auth/dashboard routes for this change. | Add component showcase if the design system grows beyond current dashboard primitives. |
