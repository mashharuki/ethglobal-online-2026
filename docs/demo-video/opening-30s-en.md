# TrueCollective — English opening

English translation of [the Japanese v4 script](opening-30s-ja.md). The message, five-scene structure, actual app screenshots, colors, transitions, are preserved. The duration is now 33.6 seconds to include the complete English recording. On-screen wording is adapted to fit English. No features or claims have been added.

**Audio status:** English human narration is included. The user replaced `remotion/public/audio/narration.m4a` with the English recording on 2026-09-13. It plays at its original speed and full length. Captions and scene boundaries follow this recording, checked with local word timestamps and silence detection. The five-part narration below reflects the revised spoken wording; the original Japanese production script remains available for historical reference.

## Message

**Keep licensees connected when management changes. Pass access rights and future revenue to the new manager.**

For people managing character and brand IP and licensing assets to businesses. Show one handover: who can access the asset, whether existing licensees can keep using it, and who receives future usage fees.

The closing line is **“Beyond the NFT.”** Technical explanations follow in the presentation.

## Storyboard

| Time | Headline | Visual |
|---|---|---|
| 0–9.2s | Every change of management means / sorting rights and revenue by hand | Audience label: “For character and brand IP managers.” One asset card, previous-to-new manager connection above, purchased license below. Focus on the licensee. Label the diagram as an example use case. |
| 9.2–13.97s | Ownership and usage rights. / One NFT. | Actual Market screenshot: asset cards, x402/HBAR purchase, survives/invalidated-on-transfer policies. Any replacement transfer footage must include signing and confirmation time. |
| 13.97–23.73s | Previous manager: free access ends / Licensee: access continues | Left: actual audit log with `deny NOT_CURRENT_OWNER`. Right: Viewer licensee path, use #1 of 5, `SURVIVE_TRANSFER`. Keep the expiry and remaining-use conditions visible. |
| 23.73–27.4s | Future usage fees → Creator + New manager | Keep the access-status ribbon. Allocation diagram: creator share fixed, owner share switches from previous to new manager. Settled payments stay unchanged. Actual Dashboard settlement records remain below (owner 0.07 ħ, creator 0.03 ħ). |
| 27.4–33.6s | TrueCollective / Beyond the NFT. | Existing logo and tagline. Hold the brand to the end, with no long blackout, end card, repeated introduction, or slide-transition wipe. |

## Narration — caption transcript of the supplied recording

> When brand assets are used by companies, access and revenue can get harder to manage when the owner changes.

>
> TrueCollective makes this simple by giving NFTs a new role.

>
> When the NFT moves to a new owner, the old owner’s free access ends, but paid access stays active until the end date.

>
> New fees go to the creator and the new owner.

>
> TrueCollective brings ownership and access rights together and gives NFTs a new meaning.

Pronunciation: NFT = N-F-T; TrueCollective = True Collective; HBAR = H-bar.

## Transition to the live presentation

“Here is the actual app. We’ll compare the same NFT before and after a change of management. Watch how the licensee’s access continues.”

Then demonstrate the transfer, previous-owner denial, licensee continuity, new-owner access, and allocation of the next payment. Explain MCP-driven AI purchases, Hedera, Privy, and x402 after showing this value.

## Production requirements retained from the Japanese version

- 1920×1080, 16:9, 30 fps, 1008 frames (33.6 seconds); retain the original five scenes and 10-frame crossfades.
- Preserve the app’s dark theme: background `#101014`, headings `#f7f6fb`, accent `#bd9aff`, continued access `#6bcf9a`, denied access `#e57a7a`. Pair colors with explicit state labels.
- Use readable bold type, safe margins, and subtitles of at most two lines. Keep subtitles clear of important app states; inspect at 720p.
- One visual focus per scene. Use the existing logo and actual cropped screenshots. Do not add decorative fake interfaces, invented results, or extra information cards.
- Distinguish “Diagram,” “Allocation diagram,” and “Actual app.” If footage is missing, show an awaiting-footage label and capture instructions.
- Movement expresses changed connections, continued usage, and changed recipients. No coin storms, blockchain networks, or long logo animations.
- Keep the presenter’s narration prominent. Background music, if supplied, stays quiet.
- If transfer wait time is omitted in future footage, use a clear cut labeled “After transfer confirmation.” Do not imply instant transaction finality.
- Continued paid access requires `SURVIVE_TRANSFER`, an unexpired license, and remaining uses. The audit screenshot shows a non-owner denial; it is not itself footage proving a transfer occurred.
- Revenue remains a two-party creator/owner split. Only the owner share of future revenue changes. Settled revenue and the creator share stay unchanged. Numbers are shown only in the existing actual settlement screenshot.
- Legal permission requires a separate agreement, to be stated in the subsequent presentation. Do not imply an NFT alone transfers copyright or contracts, or that downloaded files can be recalled.
- Do not invent performance improvements, adoption numbers, or revenue growth. Screenshots and code are not a new verification of the live demo flow.

Original evidence references and production history remain in [the Japanese source](opening-30s-ja.md). The executable English copy is in `remotion/src/narration.ts` and the scene/component files.
