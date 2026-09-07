# TrueCollective web - design notes

"Premium marketplace" direction (design review 2026-09, replacing the earlier flat/1px-border
minimal system after team feedback that it read as an unstyled prototype). Tailwind v4 utilities
on top of the tokens in `src/css/index.css`; still no component library. Chosen from 5 mockups
(OpenSea/Blur-style, produced jointly by Codex and Claude) after the first live deploy.

## Tokens (`src/css/index.css`)

| token | dark (primary) | light (secondary) | use |
|---|---|---|---|
| `--bg` / `--bg-2` | #101014 / #17161c | #faf9fc / #f1eef7 | page background / card gradient stop |
| `--text` / `--text-h` / `--text-dim` | #a6a1b4 / #f7f6fb / #6b6377 | #5c5567 / #171321 / #948d9e | body copy / headings / muted labels |
| `--accent` / `--accent-strong` | #bd9aff / #b680ff | #8b3bdb / #7c2fd0 | primary actions, active nav, gradient text |
| `--border` / `--code-bg` | #ffffff1f / #1a191f | #e4dff0 / #ede9f6 | card borders, `code` |
| `--ok` / `--warn` / `--deny` | #6bcf9a / #e0b45a / #e57a7a | #1a8f5c / #ad7420 / #c23f3f | RightsBadge, audit outcomes, permission tags |
| `--shadow` / `--shadow-lg` | soft / elevated black shadow | soft / elevated tinted shadow | `.card`, `.market-feature` |
| font | Inter (sans), mono for hashes | | |

Dark is the primary, actively-designed appearance (demo recordings run dark); light mode reuses
the same structure with a lighter but still-saturated palette rather than a flat inversion, and
gets less scrutiny than dark.

## Rules

- Cards are elevated (real shadow + subtle gradient background + 14px radius), not flat 1px
  boxes - contrast now comes from depth/color, not just borders, but every interactive control
  still needs a visible `:hover`/`:focus-visible` state (no decoration-only motion).
- Motion is real but restrained and dependency-free (`index.css`'s `@media
  (prefers-reduced-motion: reduce)` block, plus any JS-driven effect checking
  `matchMedia("(prefers-reduced-motion: reduce)")` itself): card entrance/scroll-reveal, hover
  lift/tilt, and small ambient background motion (the Market hero's gradient orb) are welcome;
  anything that blocks or delays reaching a primary action button is not (see the E2E-critical
  constraints below).
- Every on-chain fact (owner, epochs) is rendered from a chain read and labelled with the block
  it was read at; graph / gateway data is labelled "indexed".
- No fabricated content: there is no dataset title/description/category field in AssetSummary or
  the Rights Manifest, so cards never show an invented name - the asset card thumbnail
  (`components/AssetArt.tsx`) is a deterministic gradient derived from a hash of `assetId`, not a
  claimed appearance for the dataset, and permission-based filter chips (Commercial use / AI
  training / Derivatives) use the real Rights Manifest booleans, not invented categories.
- Errors show the openapi `ErrorCode` verbatim in mono - the judges match them against
  error-codes.md.
- Hashes and addresses are shortened (`0x1234…abcd`) with the full value in `title`.
- No spinners without text: every pending state says what it is waiting for.

## E2E-critical constraints (apps/e2e/lib/ui.ts, buyerFlow.e2e.ts, ownerFlow.e2e.ts)

Restyle freely, but these structural points are load-bearing for real Playwright specs (SC-002,
SC-008) and must survive any future redesign pass:

- `App.tsx`'s wallet address stays a `<code title="0x...">` element inside `<header>`.
- The "Log in with Privy" button keeps that exact accessible name.
- Each Market listing (`components/AssetCard.tsx`) stays a `<section>` containing the literal
  text `token #<id>` (not `#<id>` alone, not renamed to "Dataset").
- The buy button's accessible name keeps containing "Buy access"; the owner-access button keeps
  the exact text "Access as owner (free)".
- Nothing gates or delays reaching either button with an extra required click - SC-008 budgets
  exactly 3 clicks from page load (Privy login included) to "Access as owner (free)".
