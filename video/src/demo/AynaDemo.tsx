import React from 'react';
import { AbsoluteFill, OffthreadVideo, Sequence, useCurrentFrame } from 'remotion';
import { evalNumbers, scan } from '../data';
import { loadAynaFonts } from '../fonts';
import { C, FONT, RADIUS } from '../theme';
import { Logo } from '../components/Logo';
import { Eyebrow, Num, Tag } from '../components/Ui';
import { AynaLoop } from '../loop/AynaLoop';
import { FPS, H as LOOP_H, W as LOOP_W } from '../loop/timeline';
import { RECORDINGS } from './recordings';
import { DEMO_BEATS, type DemoBeat } from './script';

loadAynaFonts();

// 1920 x 1080. Left: the slot for the beat's screen recording (16:9). Right: the beat card with the
// script, so the edit on recording day only has to fill slots and trim. This is a skeleton, not the cut.

const SLOT = { left: 64, top: 150, width: 1216, height: 684 };

const timecode = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const Slot: React.FC<{ beat: DemoBeat }> = ({ beat }) => {
  const entry = RECORDINGS[beat.id];
  const recording = typeof entry === 'string' ? { src: entry } : entry;
  return (
    <div style={{ position: 'absolute', ...SLOT, borderRadius: RADIUS.card, overflow: 'hidden', background: C.surface }}>
      {recording ? (
        <OffthreadVideo src={recording.src} trimBefore={Math.round((recording.trimStartSeconds ?? 0) * FPS)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <>
          {beat.loopFrom !== undefined ? (
            <div style={{ position: 'absolute', right: 40, top: (SLOT.height - LOOP_H * 0.42) / 2, width: LOOP_W * 0.42, height: LOOP_H * 0.42, borderRadius: 16, overflow: 'hidden', opacity: 0.9 }}>
              <div style={{ width: LOOP_W, height: LOOP_H, transform: 'scale(0.42)', transformOrigin: 'top left', position: 'relative' }}>
                <Sequence from={-Math.round(beat.loopFrom * FPS)} layout="none">
                  <AynaLoop />
                </Sequence>
              </div>
            </div>
          ) : null}
          <div
            style={{
              position: 'absolute',
              inset: 24,
              right: beat.loopFrom !== undefined ? LOOP_W * 0.42 + 80 : 24,
              borderRadius: 16,
              border: `3px dashed ${C.orange}`,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              gap: 22,
              padding: 40,
            }}
          >
            <Tag tone="orange" size={22}>
              Screen recording goes here
            </Tag>
            <div style={{ fontFamily: FONT.body, fontSize: 30, lineHeight: 1.4, color: C.text, fontWeight: 600 }}>{beat.record}</div>
            <div style={{ fontFamily: FONT.body, fontSize: 22, lineHeight: 1.4, color: C.secondary }}>
              Put the file in video/recordings/ and register it under “{beat.id}” in src/demo/recordings.ts.
              {beat.loopFrom !== undefined ? ' Until then, the real loop plays on the right.' : ''}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const BeatCard: React.FC<{ beat: DemoBeat; index: number }> = ({ beat, index }) => {
  const frame = useCurrentFrame();
  const seconds = beat.from + frame / FPS;
  return (
    <AbsoluteFill>
      <Slot beat={beat} />
      <div style={{ position: 'absolute', left: SLOT.left + SLOT.width + 48, top: SLOT.top, right: 64, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <Num size={44} color={C.lime}>
            {String(index + 1).padStart(2, '0')}
          </Num>
          <Eyebrow size={16}>
            {timecode(beat.from)}–{timecode(beat.to)}
          </Eyebrow>
        </div>
        <div style={{ fontFamily: FONT.title, fontSize: 34, lineHeight: 1.25, color: C.text }}>{beat.title}</div>
        <div style={{ fontFamily: FONT.body, fontSize: 22, lineHeight: 1.45, color: C.neutral }}>{beat.shot}</div>
        <div style={{ fontFamily: FONT.body, fontSize: 22, lineHeight: 1.45, color: C.text, borderLeft: `4px solid ${C.lime}`, paddingLeft: 18 }}>{beat.says}</div>
        <Eyebrow size={14}>{timecode(seconds)} / 3:00</Eyebrow>
      </div>
    </AbsoluteFill>
  );
};

const CloseCard: React.FC = () => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', gap: 40, background: C.bg }}>
    <Logo size={96} />
    <div style={{ fontFamily: FONT.title, fontSize: 40, color: C.text }}>Show your robot the after.</div>
    <div style={{ display: 'flex', gap: 48, alignItems: 'baseline' }}>
      <span style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
        <Num size={48} color={C.lime}>
          {evalNumbers.objects.matched}/{evalNumbers.objects.checked}
        </Num>
        <Eyebrow size={16}>objects within 3 cm · {evalNumbers.runs} runs</Eyebrow>
      </span>
      <span style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
        <Num size={48}>{median(scan.objects.map((o) => o.fitErrorMm)).toFixed(1)}</Num>
        <Eyebrow size={16}>mm median SAM 3D fit to LiDAR</Eyebrow>
      </span>
    </div>
    <div style={{ fontFamily: FONT.body, fontSize: 30, color: C.neutral }}>github.com/sabr2007/meta-global-hackathon</div>
  </AbsoluteFill>
);

export const AynaDemo: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg }}>
    <div style={{ position: 'absolute', left: 64, top: 48, display: 'flex', alignItems: 'center', gap: 28 }}>
      <Logo size={28} />
      <Eyebrow size={15}>Demo skeleton · 8 beats · fill the slots on recording day</Eyebrow>
    </div>
    {DEMO_BEATS.map((beat, i) => (
      <Sequence key={beat.id} from={Math.round(beat.from * FPS)} durationInFrames={Math.round((beat.to - beat.from) * FPS)} layout="none">
        {beat.id === 'close' && !RECORDINGS.close ? <CloseCard /> : <BeatCard beat={beat} index={i} />}
      </Sequence>
    ))}
  </AbsoluteFill>
);
