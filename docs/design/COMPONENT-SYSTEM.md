# Loomrail component system — Linear study baseline

**Status:** M2/M3 implementation baseline — current Workbench owner-reviewed; cross-platform acceptance pending
**Date:** 2026-08-24
**Applies to:** browser-first product UI and the future desktop shell

This document turns the approved direction into a reusable UI contract. It is intentionally a close study of
Linear's density and interaction grammar, not a copy of Linear assets, branding, source code or product structure.
Loomrail keeps its own information model: work items, agents, runs, human requests, budgets, evidence and acceptance.

The durable implementation lives in `packages/ui`; production review happens through the real Workbench flows and
focused browser tests. Earlier local design-lab explorations are excluded from the repository and are not product
dependencies.

## 1. Visual direction

The product is a compact local workbench, not a dashboard made of decorative cards.

- one continuous application surface split by hairline dividers;
- a narrow neutral sidebar, flat top bars and dense rows;
- white or near-canvas work areas, with gray grouping surfaces used sparingly;
- accent reserved for primary action, focus and selected semantic state;
- shadows only for elements that physically float above the current surface;
- no colored side stripes, hover lift, gradients, glass, glow or vanity metrics;
- status is communicated by icon, label and shape, never by color alone.

### 1.1 Measured working geometry

The values below were derived from the supplied full-resolution product screenshots and then normalized to a 4 px
grid. They are the current implementation baseline, pending owner approval.

| Element                       | Working value | Rule                                              |
| ----------------------------- | ------------: | ------------------------------------------------- |
| Desktop sidebar               |        240 px | May collapse below tablet width                   |
| Desktop app surface inset     |          8 px | Top/right/bottom; left stays flush with sidebar   |
| App/top bar                   |         44 px | One row; no second decorative header              |
| Navigation row                |         28 px | 24 px only for compact secondary rows             |
| Default control               |         28 px | 24/28/32 px size scale                            |
| Mobile form control           |      >= 40 px | Text remains at least 16 px to avoid browser zoom |
| Control radius                |          8 px | Buttons, inputs and nav selection                 |
| Card/popover radius           |         10 px | Task cards, menus and popovers                    |
| Shell radius                  |         14 px | Application frame and large bounded surfaces      |
| Dialog radius                 |         18 px | Deliberate overlays only                          |
| Pill radius                   |          full | Tabs, segmented choices and compact properties    |
| Hairline                      |          1 px | Low-contrast semantic border                      |
| Base text                     |         13 px | 12 px metadata, 14 px prominent row titles        |
| Sidebar/item horizontal inset |          8 px | Inner row padding commonly 6–8 px                 |
| Section rhythm                |   16/24/32 px | Dense rows still use 4/8 px local spacing         |

### 1.2 Working color primitives

Components consume semantic tokens rather than these raw values. The primitives document the current visual target.

| Token           | Light     | Dark      |
| --------------- | --------- | --------- |
| canvas          | `#f9f9fa` | `#171719` |
| surface         | `#ffffff` | `#1d1d1f` |
| grouped surface | `#efeff0` | `#202022` |
| hover surface   | `#ededee` | `#29292c` |
| active surface  | `#dfdfe1` | `#303034` |
| text strong     | `#1b1b1d` | `#f0f0f2` |
| text default    | `#3b3b3f` | `#d0d0d4` |
| text muted      | `#6f6f75` | `#9a9aa1` |
| border subtle   | `#e6e6e8` | `#2c2c2f` |
| border strong   | `#d4d4d7` | `#3a3a3e` |
| action/focus    | `#5e6ad2` | `#7c85e6` |

The action color is deliberately scarce. Semantic success, warning, danger, workflow and diff palettes remain
separate token families and must pass contrast checks in both themes.

### 1.3 Elevation and motion

- in-flow cards, rows and selected navigation have no drop shadow;
- menu/popover: `0 12px 36px rgb(0 0 0 / 12%)` plus a subtle close shadow;
- dialog: `0 20px 60px rgb(0 0 0 / 16%)` plus a subtle close shadow;
- hover/focus feedback: 120 ms; popovers: 120 ms; dialog/overlay entrance: 180/160 ms;
- components never change position on hover;
- `prefers-reduced-motion` removes non-essential movement.

## 2. Ownership and package boundary

### `packages/ui`

Owns Loomrail's reusable visual language:

- primitive, semantic and stable component tokens;
- accessible primitives and their complete state geometry;
- keyboard behavior, focus management and reduced-motion rules;
- stable cross-feature patterns that have at least two real consumers;
- theme tokens, component state contracts and visual test fixtures.

The public API exports Loomrail components. Radix or another headless dependency remains an implementation detail;
product code must not spread dependency-specific props throughout the application.

### `apps/web`

Owns product composition:

- route layouts and responsive shell;
- Command Center, Kanban, Task Cockpit, Agent Fleet and review/QA screens;
- query/mutation hooks and optimistic-state policy;
- feature-specific copy, permissions and domain decisions;
- feature patterns that have not yet proven a reusable contract.

`packages/ui` never imports application code, domain queries or provider data. Application screens do not hardcode
visual state colors and do not recreate an existing primitive with local CSS.

## 3. Component layers

### 3.1 Foundations

- `Button`: ghost-first, plus primary, secondary and destructive; 24/28/32 px sizes;
- `IconButton`: accessible label required, tooltip when the action is not self-evident;
- `LinkButton`;
- `StatusIcon` and `StatusLabel`;
- `Badge` and compact property chip;
- `Avatar` and `AgentIdentity`;
- `Divider`, `Progress`, `Skeleton`;
- `EmptyState`, `ErrorState`, `OfflineState` and `StaleState`.

### 3.2 Form controls

- `Field`, `FieldLabel`, `FieldDescription`, `FormError`;
- `TextField`, `Textarea`, `SearchField`, `CodeField`, `SecretField`;
- `Checkbox`, `RadioGroup`, `Switch`;
- `Select`, its shared 24 px `compact` variant for dense property panels, searchable `Combobox` and multi-select
  property picker;
- `BudgetInput` and `BudgetMeter`;
- `DateTimeField` when workflow scheduling requires it.

Native semantics are preferred. Headless primitives are used for controls that require managed focus, positioning,
typeahead, collision handling or composite keyboard navigation.

### 3.3 Navigation and overlays

- `Tabs`, `SegmentedControl`, `Breadcrumbs`;
- `Menu`, `ContextMenu`, `Popover`, `Tooltip`;
- `Dialog`, `Sheet` and inspector panel;
- `CommandPalette`;
- cascading property filter;
- view/display options panel;
- toast and durable notification center.

Menus use 28 px rows, 7 px item radii and 10 px panel radii. On desktop, hovering or focusing a filter branch opens
the next level as a separate adjacent popover to the left of its parent row. Every level owns its search field,
border, radius and shadow; the surfaces never merge into one wide grid. The current selection path stays visible.
Panels at the same depth preserve their DOM surface while the hovered branch changes; only content and the anchored
vertical position update, with a 120 ms transition. This avoids remount flashes and abrupt vertical jumps.
At 760 px and below the same filter becomes a full-viewport dialog with one level visible at a time: selecting a
branch drills forward and Back preserves the path. Leaf selections apply immediately. Clicking the dedicated
checkbox toggles a value without closing the current level so several values can be selected; clicking the value row
toggles it and closes the picker. Mobile rows are at least 44 px high and the search field uses 16 px text so browser
zoom is not triggered.

Applied conditions render in a persistent compound filter bar. Each condition has distinct property, operator and
value segments plus a remove action. Opening the value segment exposes a searchable multi-select editor with the
same immediate checkbox/row behavior as the primary picker. The add action reopens the hierarchy, Clear removes all
conditions, and every mutation updates the controlled filter value in the same event cycle. When this bar is
present, it owns a grouped neutral surface and visually replaces the toolbar's lower divider; the two rows must not
render a duplicate border between them.

### 3.4 Data and work surfaces

- compact list row and grouped list;
- task card and Kanban column;
- table, tree and virtual list;
- split pane and resizable panel;
- timeline and activity row;
- Markdown, code block, terminal and diff foundations.

Task cards are information rows adapted to a board, not marketing cards. They contain only information needed to
decide the next action. Hover changes the surface or border without movement.

### 3.5 Loomrail product patterns

- `HumanRequestRow` and structured question with `Other`;
- `EpicTree` and dependency relation row;
- `PipelineRail`, `StageAttempt` and recovery state;
- `AgentFleetRow`, `AgentRunSummary` and provider capability hint;
- `BudgetMeter`, cost/usage provenance and hard-stop state;
- `PermissionPrompt` and approval summary;
- `ArtifactViewer`, review finding and resolution control;
- `QAScenario`, evidence gallery and stale-evidence warning;
- `AcceptanceMatrix` and final human decision.

## 4. Required states

Every interactive primitive specifies and visually tests:

- default, hover, focus-visible, pressed and disabled;
- loading without layout shift;
- success and error feedback where the component owns an async action;
- keyboard and pointer parity;
- light and dark themes;
- compact/default density;
- reduced motion;
- high zoom and narrow viewport behavior.

Workflow patterns additionally cover empty, offline, stale, waiting-human, paused, recovering and permission-denied
states. A transient toast must never be the only record of a durable workflow decision.

## 5. Keyboard contract

- `Tab` moves between controls; arrow keys move within composite widgets;
- `Enter` activates the primary row action; `Space` toggles check/radio/switch controls;
- `Escape` closes only the topmost overlay and restores focus to its trigger;
- `Home`/`End` navigate tabs, menus and lists where expected;
- menus and comboboxes support typeahead;
- Kanban has a non-drag keyboard move command and explains the resulting state transition;
- visible focus is never replaced by selection color alone;
- global shortcuts do not fire while the user is typing in an editable field.

## 6. React application contract

The accepted baseline remains:

- React 19.2 SPA on Vite 8.1;
- TanStack Router 1.x for typed routes, route params and route-level loading boundaries;
- TanStack Query 5.x for daemon-owned server state, caching, mutation lifecycle and invalidation;
- Tailwind CSS 4.3 as the composition layer over committed semantic CSS tokens;
- Zod 4.x for runtime validation of HTTP, SSE and persisted UI boundaries;
- headless Radix only behind Loomrail wrappers where native HTML is insufficient;
- local React state for ephemeral view state.

There is no Next.js or TanStack Start requirement: Loomrail is a local browser application with a separate daemon,
so SSR adds a second server model without solving a Phase 0 problem. There is no global state library initially;
TanStack Query owns daemon state and local React state owns open panels, drafts and display choices. Zustand or a
reducer-based app store is introduced only after a measured cross-route client-state problem exists.

React Hook Form is optional for later complex configuration forms; simple forms should not gain a framework solely
for consistency. `dnd-kit`, TanStack Table and virtualization are introduced with the first real board/table scale
requirement and must include keyboard and non-drag alternatives.

### 6.1 Realtime ownership

1. Route loader establishes the minimum query dependencies.
2. TanStack Query reads canonical state from the daemon HTTP API.
3. Commands mutate through typed daemon endpoints with idempotency and expected version.
4. SSE delivers only committed events; the frame carries three opaque identifiers and no content.
5. A signal invalidates the smallest matching query scope; nothing patches a normalized record.
6. Connecting and every reconnect invalidate everything, catching up on any work missed while disconnected;
   there is no event cursor and no replay.

SSE payloads never become an independent UI store, and provider-native events never bypass Loomrail's domain
contracts.

## 7. Review and acceptance gate

The current Workbench, toolbar, filters and display-settings overlays have completed owner review and focused browser
regression coverage on macOS. Before the component system becomes the cross-platform accepted baseline:

- primary accent, typography rendering and density are checked on macOS and Windows;
- desktop, 200% zoom and narrow-screen overflow are reviewed;
- keyboard focus, popup dismissal and focus return are verified;
- semantic color contrast is measured;
- production tokens and primitives are already consumed by the Workbench and its real product overlays;
- the responsive shell, board, inspector, forms and overlays share the same package implementation;
- Windows rendering, screenshot fixtures and broader component interaction coverage remain the acceptance gate.
