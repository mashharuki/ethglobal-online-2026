# TrueCollective web - design notes

Minimal design system for the hackathon UI (tasks.md T104-T113). Tailwind v4 utilities on top
of the tokens in `src/css/index.css`; no component library.

## Tokens (`src/css/index.css`)

| token | light | dark | use |
|---|---|---|---|
| `--bg` / `--text` / `--text-h` | white / #6b6375 / #08060d | #16171d / #9ca3af / #f3f4f6 | page, body copy, headings |
| `--accent` | #aa3bff | #c084fc | primary actions, active nav, the "settled" counter |
| `--border` / `--code-bg` | #e5e4e7 / #f4f3ec | #2e303a / #1f2028 | cards, `code`, tables |
| `--ok` / `--warn` / `--deny` | #15803d / #b45309 / #b91c1c | same | RightsBadge, audit outcomes, attack counter |
| font | system sans 16-18px, mono for hashes | | |

## Rules

- One column, max width 72rem, cards with a 1px border and no shadows; the demo is watched on a
  projector, so contrast over decoration.
- Every on-chain fact (owner, epochs) is rendered from a chain read and labelled with the block
  it was read at; graph / gateway data is labelled "indexed".
- Errors show the openapi `ErrorCode` verbatim in mono - the judges match them against
  error-codes.md.
- Hashes and addresses are shortened (`0x1234…abcd`) with the full value in `title`.
- No spinners without text: every pending state says what it is waiting for.
