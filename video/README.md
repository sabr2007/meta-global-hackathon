# Ayna videos (Remotion)

Two compositions, built only from real material: the desk scan's hero photo, the SAM 3.1 masks
from that scan, the versions Muse Image developed in a saved run (with the verdicts SAM 3.1 gave
them), and numbers from the eval log.

| Composition | Size | Length | What it is |
|---|---|---|---|
| `AynaLoop` | 1080 x 1350, 30 fps | 39 s | The landing page's film. One run from request to receipt; the last frame is the first, so it loops. |
| `AynaDemo` | 1920 x 1080, 30 fps | 180 s | Skeleton of the 3-minute demo: the 8 beats of the video script, each with a slot labelled "screen recording goes here". Not the final edit. |

## Render the landing film

```sh
cd video
npm install
npm run render
```

This writes, next to the landing page:

- `web/public/landing/ayna-loop.mp4` (H.264, yuv420p, faststart; the script fails above 4 MB)
- `web/public/landing/ayna-loop-poster.webp` (1080 x 1350) and `ayna-loop-poster-540.webp`
- `web/public/landing/ayna-loop.vtt` (the on-screen captions)
- `web/src/landing/facts/loop.json` (poster time, length and captions for the landing's player)

The outputs are committed, so the landing builds without Remotion installed.

Other commands:

```sh
npm run studio                                   # preview both compositions
npm run render -- --stills 80,771                # PNG stills into out/
npm run render -- --crf 24                       # sharper, bigger file
npm run render -- --demo                         # also render the AynaDemo skeleton to out/
```

## Where the material comes from

`npm run prepare-assets` reads the private scan and its saved runs (git-ignored, on the machine that
made them) and writes small public copies that are committed:

```sh
npm run prepare-assets -- --source /path/to/checkout     # default: this repo's root
#   reads  <source>/web/public/scenes/desk-sam3d/{hero.jpg,masks.json,scene.json}
#          <source>/data/store/scans/*/desk-sam3d/runs/*/{run.json,candidate-*.webp}
#   writes web/public/landing/{before,after-<run>-<version>}-{720,1080}.webp
#          web/src/landing/facts/showcase.json (objects, dotted mask outlines, the featured run)
```

It features the run that shows the whole loop best: one with a version SAM 3.1 rejected if there is
one, then the best receipt (`--run <id>` picks one). Candidates are stretched onto the hero photo's
pixels exactly as the app maps their masks. The eval totals come from the eval log:

```sh
cd ../web && node scripts/landing-numbers.mjs ../.night/eval-runs.jsonl   # -> src/landing/facts/eval.json
```

After either step, run `npm run render` again so the film shows the same run and numbers.

## Filling the demo skeleton (recording day)

1. Put each screen recording in `video/recordings/` (git-ignored).
2. Register it under its beat id in `src/demo/recordings.ts`
   (`open`, `problem`, `scan`, `imagine`, `approve`, `verify`, `why`, `close`).
3. `npm run studio` to check timing, then `npm run render -- --demo`.

Beats and their script live in `src/demo/script.ts` (section 8 of the project concept, in English).

## Licence note

Remotion is free for individuals and for companies or teams of up to 3 people; larger teams need a
company licence (see https://www.remotion.dev/license). This project qualifies for the free licence.
Michroma and Doto are used under the SIL Open Font License (`web/src/styles/fonts/`).
