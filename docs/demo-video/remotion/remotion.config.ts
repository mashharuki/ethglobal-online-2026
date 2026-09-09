/**
 * Node.JS API 経由のレンダリングではこの config は適用されない。
 * 全オプション: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
