import "./index.css";
import { Composition } from "remotion";
import { Opening } from "./Opening";
import { openingDefaults, openingSchema } from "./schema";
import { DURATION_IN_FRAMES, FPS, HEIGHT, WIDTH } from "./theme";

/** English opening: 1920×1080 / 30 fps / 1008 frames.
 * Script: src/narration.ts (SUBTITLE_CUES).
 * Inspection frames: 190, 390, 620, 750, 930.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Opening"
        component={Opening}
        durationInFrames={DURATION_IN_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        schema={openingSchema}
        defaultProps={openingDefaults}
      />
    </>
  );
};
