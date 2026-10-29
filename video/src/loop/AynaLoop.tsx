import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { chosen, scan } from '../data';
import { loadAynaFonts } from '../fonts';
import { C } from '../theme';
import { Logo } from '../components/Logo';
import { BASE_CAMERA, Photo, useProjection } from '../components/Stage';
import { run } from '../data';
import { DevelopBeat, InstructBeat, PlanBeat, ReceiptBeat, RequestBeat, SegmentBeat, TwinBeat, WIPE, WipeChrome, wipePosition } from './beats';
import { EdgeShade, Shade } from './parts';
import { BEATS, contactLayout, ramp, sheetCandidates, type BeatName } from './timeline';

loadAynaFonts();

const STEPS: BeatName[] = ['request', 'segment', 'instruct', 'develop', 'wipe', 'plan', 'twin', 'receipt'];

/** 1 inside [from, to), fading in and out over `fade` frames. */
const windowed = (frame: number, from: number, to: number, fade = 14) => ramp(frame, from, from + fade) * (1 - ramp(frame, to - fade, to));

const Header: React.FC<{ frame: number }> = ({ frame }) => {
  const reset = 1 - ramp(frame, BEATS.outro.from, BEATS.outro.from + 30);
  return (
    <AbsoluteFill style={{ padding: '50px 56px 0', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <Logo size={30} />
      <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
        {STEPS.map((step) => {
          const { from, frames } = BEATS[step];
          const fill = interpolate(frame, [from, from + frames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) * reset;
          return (
            <div key={step} style={{ width: 30, height: 4, borderRadius: 2, background: C.raised, overflow: 'hidden' }}>
              <div style={{ width: '100%', height: '100%', background: C.lime, transform: `scaleX(${fill})`, transformOrigin: 'left' }} />
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/** The chosen version: grows from its print on the contact sheet into the frame, then wipes. */
const AfterLayer: React.FC<{ frame: number }> = ({ frame }) => {
  const { box } = useProjection(BASE_CAMERA);
  const file = chosen.images?.['1080'];
  if (!file || frame < BEATS.wipe.from) return null;
  const local = frame - BEATS.wipe.from;
  const sheet = sheetCandidates();
  const index = Math.max(0, sheet.findIndex((c) => c.id === chosen.id));
  const from = contactLayout(sheet.length)[index];
  const t = ramp(local, 0, WIPE.expand, Easing.inOut(Easing.cubic));
  const rect = {
    left: interpolate(t, [0, 1], [from.left, box.left]),
    top: interpolate(t, [0, 1], [from.top, box.top]),
    width: interpolate(t, [0, 1], [from.width, box.width]),
    height: interpolate(t, [0, 1], [from.height, box.height]),
  };
  const p = local < BEATS.wipe.frames ? wipePosition(local) : 0;
  const fadeOut = 1 - ramp(frame, BEATS.outro.from, BEATS.outro.from + 40, Easing.inOut(Easing.quad));
  return (
    <AbsoluteFill style={{ opacity: fadeOut, clipPath: `inset(0 0 0 ${p * 100}%)` }}>
      <div style={{ position: 'absolute', ...rect, borderRadius: 14 * (1 - t), overflow: 'hidden', boxShadow: t < 1 ? `0 0 0 ${4 * (1 - t)}px ${C.lime}` : undefined }}>
        <Img src={staticFile(file)} style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
      </div>
    </AbsoluteFill>
  );
};

export const AynaLoop: React.FC = () => {
  const frame = useCurrentFrame();
  const developFrom = BEATS.develop.from;
  const beforeOpacity =
    frame < developFrom ? 1 : frame < BEATS.wipe.from + WIPE.expand ? 1 - ramp(frame, developFrom, developFrom + 16) : 1;
  const shade = Math.max(
    windowed(frame, BEATS.instruct.from, developFrom + 16) * 0.68,
    windowed(frame, BEATS.plan.from, BEATS.twin.from + 8, 12) * 0.66,
    windowed(frame, BEATS.receipt.from - 8, BEATS.outro.from + 30, 12) * 0.66,
  );
  const render = run.render?.['720'];
  const twin = windowed(frame, BEATS.twin.from - 4, BEATS.receipt.from + 8, 14);
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Photo camera={BASE_CAMERA} file={scan.before['1080']} style={{ opacity: beforeOpacity }} />
      <AfterLayer frame={frame} />
      {render && twin > 0 ? <Photo camera={BASE_CAMERA} file={render} style={{ opacity: twin }} /> : null}
      <EdgeShade />
      <Shade amount={shade} />
      <Sequence from={BEATS.request.from} durationInFrames={BEATS.request.frames} layout="none">
        <RequestBeat />
      </Sequence>
      <Sequence from={BEATS.segment.from} durationInFrames={BEATS.segment.frames} layout="none">
        <SegmentBeat />
      </Sequence>
      <Sequence from={BEATS.instruct.from} durationInFrames={BEATS.instruct.frames} layout="none">
        <InstructBeat />
      </Sequence>
      <Sequence from={BEATS.develop.from} durationInFrames={BEATS.develop.frames} layout="none">
        <DevelopBeat />
      </Sequence>
      <Sequence from={BEATS.wipe.from} durationInFrames={BEATS.wipe.frames} layout="none">
        <WipeChrome />
      </Sequence>
      <Sequence from={BEATS.plan.from} durationInFrames={BEATS.plan.frames} layout="none">
        <PlanBeat />
      </Sequence>
      <Sequence from={BEATS.twin.from} durationInFrames={BEATS.twin.frames} layout="none">
        <TwinBeat />
      </Sequence>
      <Sequence from={BEATS.receipt.from} durationInFrames={BEATS.receipt.frames} layout="none">
        <ReceiptBeat />
      </Sequence>
      <Header frame={frame} />
    </AbsoluteFill>
  );
};
