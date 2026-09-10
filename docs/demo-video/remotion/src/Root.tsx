import "./index.css";
import { Composition } from "remotion";
import { Opening } from "./Opening";
import { openingDefaults, openingSchema } from "./schema";
import { DURATION_IN_FRAMES, FPS, HEIGHT, WIDTH } from "./theme";

/**
 * TrueCollective — 30秒オープニング。
 * 1920×1080 / 30fps / 900フレーム。台本: docs/demo-video/opening-30s-ja.md
 *
 * 静止画チェック用の代表フレーム（`npx remotion still <id> --frame=<n>`）:
 *   冒頭      Opening --frame=60
 *   左右比較  Opening --frame=360
 *   収益      Opening --frame=520
 *   締め      Opening --frame=780
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
