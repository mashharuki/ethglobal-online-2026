# TrueCollective — English opening (Remotion)

The narrated English script is the source of truth in [`src/narration.ts`](src/narration.ts)'s `SUBTITLE_CUES`; scene boundaries are `BOUNDS` in [`src/Opening.tsx`](src/Opening.tsx). The original standalone script documents (`opening-30s-en.md` / `opening-30s-ja.md`) have been superseded by the code and removed.

The English version preserves the original message, five scenes, screenshots, dark theme, logo, and animations: **1920×1080 / 30 fps / 1008 frames (33.6 seconds)**. Headlines, subtitles, diagram labels, captions, and missing-footage instructions are in English.

## Narration

The default includes the **presenter’s English narration** (`hasNarrationAudio: true`). The user replaced `public/audio/narration.m4a` with the English recording on 2026-09-13. The recording is used directly, without trimming, time stretching, or voice replacement.

The source is about 33.6 seconds long. Subtitle and scene timing use local word-timestamp analysis plus pause detection. If the recording is replaced again, realign `SUBTITLE_CUES`, `Opening.tsx` scene boundaries (`BOUNDS`), and `theme.ts` duration to the new speech.

Optional music: place `public/audio/bgm.m4a` and enable `hasBgm`; volume is 0.16.

## Actual app screenshots

| Prop | File | Source | What it shows |
|---|---|---|---|
| `coupleClip` | `footage/market.png` | `docs/img/4.jpg` | Asset cards, x402/HBAR purchase, transfer policies |
| `contrastDenyClip` | `footage/audit-deny.png` | `docs/img/3.jpg` | Audit log: owner_keygate denies NOT_CURRENT_OWNER |
| `contrastOkClip` | `footage/viewer-licensee.png` | `docs/img/0.jpg` | Licensee decryption, use #1 of 5, SURVIVE_TRANSFER |
| `revenueClip` | `footage/dashboard-revenue.png` | `docs/img/2.jpg` | Recorded owner/creator allocations (0.07 / 0.03 ħ) |

Screenshots are unchanged, labeled “Actual app,” and identify their source. The denial image is an audit log, not a Viewer denial screen or standalone proof that a transfer occurred. Diagrams are explicitly labeled; no invented success screens or measured figures are added. Continued access remains conditional on SURVIVE_TRANSFER, expiry, and remaining uses. Settled revenue and the creator share stay unchanged.

Replace props with new real footage when available; an empty prop displays capture instructions. The unused `S5Handover` is retained and translated, but is not in the timeline.

## Timeline and verification

| Frames | Scene | Representative frame |
|---|---|---|
| 0–275 | S1Hook | 190 |
| 276–418 | S2Couple | 390 |
| 419–711 | S3Contrast | 620 |
| 712–821 | S4Revenue | 750 |
| 822–1007 | S6Close | 930 |

Scene transitions use 10-frame crossfades; the closing brand remains visible through the final frame. English subtitles follow the recorded wording and phrase timing, with brief holds after speech for readability.

Run from this directory using the installed Remotion dependencies:

```bash
npm run dev
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/remotion still Opening out/english-hook.png --frame=190
./node_modules/.bin/remotion render Opening out/opening-en.mp4
```

The existing Noto Sans JP font also supports English. Rendering waits for its Google Fonts requests to finish.
