import { FPS } from "./theme";

/**
 * English translation of the five-part Japanese narration.
 * Cues follow the English human recording supplied on 2026-09-13.
 * Timing was checked with local word timestamps and silence detection.
 * Audio and footage play at their original speed.
 */
export type NarrationCue = {
  id: string;
  /** Burned-in English subtitles, at most two lines. */
  text: string;
  from: number;
  durationInFrames: number;
};

const s = (sec: number) => Math.round(sec * FPS);

/** Caption transcript of the supplied recording, with light grammar normalization. */
export const FULL_SCRIPT = [
  "When brand assets are used by companies, access and revenue can get harder to manage when the owner changes.",
  "TrueCollective makes this simple by giving NFTs a new role.",
  "When the NFT moves to a new owner, the old owner’s free access ends, but paid access stays active until the end date.",
  "New fees go to the creator and the new owner.",
  "TrueCollective brings ownership and access rights together and gives NFTs a new meaning."
];

export const SUBTITLE_CUES: NarrationCue[] = [
  { id: "l1a", text: "When brand assets are used by companies,", from: s(0.03), durationInFrames: s(3.5) - s(0.03) },
  { id: "l1b", text: "access and revenue can get harder to manage", from: s(4.0), durationInFrames: s(6.5) - s(4.0) },
  { id: "l1c", text: "when the owner changes.", from: s(6.5), durationInFrames: s(8.5) - s(6.5) },
  { id: "l2a", text: "TrueCollective makes this simple", from: s(9.1), durationInFrames: s(11.03) - s(9.1) },
  { id: "l2b", text: "by giving NFTs a new role.", from: s(11.03), durationInFrames: s(13.4) - s(11.03) },
  { id: "l3a", text: "When the NFT moves to a new owner,", from: s(13.97), durationInFrames: s(16.3) - s(13.97) },
  { id: "l3b", text: "the old owner’s free access ends,", from: s(16.73), durationInFrames: s(19.1) - s(16.73) },
  { id: "l3c", text: "but paid access stays active until the end date.", from: s(19.53), durationInFrames: s(23.1) - s(19.53) },
  { id: "l4a", text: "New fees go to the creator and the new owner.", from: s(23.73), durationInFrames: s(27.07) - s(23.73) },
  { id: "l5a", text: "TrueCollective brings ownership\nand access rights together", from: s(27.4), durationInFrames: s(30.6) - s(27.4) },
  { id: "l5b", text: "and gives NFTs a new meaning.", from: s(30.6), durationInFrames: s(33.2) - s(30.6) },
];

export const READING_NOTES =
  "NFT: N-F-T; IP: I-P; TrueCollective: True Collective; HBAR: H-bar.";

/** User replaced this file with the English human recording on 2026-09-13. */
export const NARRATION_AUDIO_SRC = "audio/narration.m4a";
