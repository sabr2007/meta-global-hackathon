// Renders AynaLoop for the landing page and copies the results next to it:
//   web/public/landing/ayna-loop.mp4           H.264, yuv420p, faststart, <= 4 MB
//   web/public/landing/ayna-loop-poster.webp   1080 x 1350 still (and a 540 px one for phones)
//   web/public/landing/ayna-loop.vtt           the on-screen captions as WebVTT
//   web/src/landing/facts/loop.json             poster time and length, for the landing's player
//
//   npm run render                      # everything above
//   npm run render -- --stills 80,640   # only PNG stills into out/ (for checking frames)
//   npm run render -- --demo            # also render the AynaDemo skeleton to out/ayna-demo.mp4

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import sharp from 'sharp';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const LANDING = path.resolve(ROOT, '..', 'web', 'public', 'landing');
const OUT = path.join(ROOT, 'out');
const MAX_BYTES = 4 * 1024 * 1024;
const POSTER_FRAME = 771; // the after photo with the moves drawn on it: the loop's idea in one frame
const FPS = 30;

const flag = (name) => process.argv.includes(`--${name}`);
const value = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function vttTime(frame) {
  const ms = Math.round((frame / FPS) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

/** The loop's captions with the featured run's values, in seconds (for the VTT and the landing). */
function captionCues() {
  const { cues } = JSON.parse(readFileSync(path.join(ROOT, 'src', 'loop', 'captions.json'), 'utf8'));
  const showcase = JSON.parse(readFileSync(path.join(ROOT, '..', 'web', 'src', 'landing', 'facts', 'showcase.json'), 'utf8'));
  const values = {
    request: showcase.run.request,
    objects: String(showcase.scan.objects.length),
    versions: String(Math.min(showcase.run.candidates.length, 6)),
  };
  const fill = (text) => text.replace(/\{(\w+)\}/g, (_, name) => values[name] ?? name);
  return cues.map((c) => ({ from: c.from, to: c.to, start: c.from / FPS, end: c.to / FPS, chip: c.chip, text: fill(c.text) }));
}

function writeCaptions(cues) {
  const body = cues.map((c) => `${vttTime(c.from)} --> ${vttTime(c.to)}\n${c.chip}: ${c.text}`).join('\n\n');
  writeFileSync(path.join(LANDING, 'ayna-loop.vtt'), `WEBVTT\n\n${body}\n`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log('bundling…');
  const serveUrl = await bundle({ entryPoint: path.join(ROOT, 'src', 'index.ts'), publicDir: LANDING });
  const loop = await selectComposition({ serveUrl, id: 'AynaLoop' });

  const stills = value('stills');
  if (stills) {
    for (const frame of stills.split(',').map(Number)) {
      const output = path.join(OUT, `loop-${String(frame).padStart(4, '0')}.png`);
      await renderStill({ serveUrl, composition: loop, frame, output, imageFormat: 'png' });
      console.log(output);
    }
    return;
  }

  console.log(`rendering ${loop.durationInFrames} frames…`);
  const raw = path.join(OUT, 'ayna-loop.raw.mp4');
  await renderMedia({
    serveUrl,
    composition: loop,
    codec: 'h264',
    crf: Number(value('crf') ?? 27),
    x264Preset: 'veryslow',
    pixelFormat: 'yuv420p',
    imageFormat: 'jpeg',
    jpegQuality: 92,
    muted: true,
    outputLocation: raw,
    onProgress: ({ progress }) => process.stdout.write(`\r${Math.round(progress * 100)}%`),
  });
  process.stdout.write('\n');

  // moov atom first so the browser can start playing before the whole file arrives
  const mp4 = path.join(LANDING, 'ayna-loop.mp4');
  execFileSync('npx', ['remotion', 'ffmpeg', '-y', '-loglevel', 'error', '-i', raw, '-c', 'copy', '-movflags', '+faststart', mp4], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const bytes = statSync(mp4).size;
  console.log(`ayna-loop.mp4: ${(bytes / 1024 / 1024).toFixed(2)} MB, ${(loop.durationInFrames / FPS).toFixed(1)} s`);
  if (bytes > MAX_BYTES) throw new Error(`ayna-loop.mp4 is over 4 MB: raise --crf`);

  const posterPng = path.join(OUT, 'poster.png');
  await renderStill({ serveUrl, composition: loop, frame: POSTER_FRAME, output: posterPng, imageFormat: 'png' });
  await sharp(posterPng).webp({ quality: 78, effort: 6 }).toFile(path.join(LANDING, 'ayna-loop-poster.webp'));
  await sharp(posterPng).resize(540, 675).webp({ quality: 76, effort: 6 }).toFile(path.join(LANDING, 'ayna-loop-poster-540.webp'));
  const cues = captionCues();
  const meta = {
    note: 'Written by video/scripts/render.mjs with ayna-loop.mp4.',
    posterFrame: POSTER_FRAME,
    posterSeconds: POSTER_FRAME / FPS,
    seconds: loop.durationInFrames / FPS,
    bytes,
    cues: cues.map(({ start, end, chip, text }) => ({ start, end, chip, text })),
  };
  writeFileSync(path.join(ROOT, '..', 'web', 'src', 'landing', 'facts', 'loop.json'), `${JSON.stringify(meta, null, 1)}\n`);
  writeCaptions(cues);
  console.log('wrote ayna-loop.mp4, ayna-loop-poster.webp, ayna-loop-poster-540.webp, ayna-loop.vtt to web/public/landing/');

  if (flag('demo')) {
    const demo = await selectComposition({ serveUrl, id: 'AynaDemo' });
    await renderMedia({ serveUrl, composition: demo, codec: 'h264', crf: 26, outputLocation: path.join(OUT, 'ayna-demo.mp4'), muted: true });
    console.log('wrote out/ayna-demo.mp4 (skeleton)');
  }
  copyFileSync(raw, path.join(OUT, 'ayna-loop.mp4'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
