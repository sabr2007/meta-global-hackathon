// Remotion settings for `remotion studio` and `remotion render` (scripts/render.mjs passes the rest).
import { Config } from '@remotion/cli/config';

// The landing's public assets (real photos and versions written by scripts/prepare-assets.mjs) are
// the video's assets too, so both always show the same run.
Config.setPublicDir('../web/public/landing');
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(92);
Config.setOverwriteOutput(true);
Config.setConcurrency(4);
