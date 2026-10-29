import React from 'react';
import { AbsoluteFill, Easing, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  afterOutlines,
  beforeOutlines,
  caption,
  chosen,
  developSeconds,
  editSentences,
  formatCm,
  judgeScore,
  moves,
  prettify,
  refusals,
  run,
  scan,
} from '../data';
import { C, FONT } from '../theme';
import { BASE_CAMERA, Overlay, useProjection } from '../components/Stage';
import { Card, Dot, Eyebrow, Num, Stamp, Tag } from '../components/Ui';
import { Caption, DottedPath, ObjectLabel, Print, typed } from './parts';
import { BEATS, beatOpacity, contactLayout, ramp, sheetCandidates } from './timeline';

const OBJECTS = scan.objects.length;
const sentence = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);
const BIG_MASK_PX = 30000; // labels sit inside big objects and under small ones

function labelAnchor(box: number[], centroid: number[] | null, areaPx = 0): [number, number] {
  const [x, y, w, h] = box;
  if (areaPx > BIG_MASK_PX && centroid) return [centroid[0], centroid[1] - 18];
  return [x + w / 2, y + h + 16];
}

// ---------------------------------------------------------------- 1. the request

export const RequestBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { frames } = BEATS.request;
  const opacity = beatOpacity(frame, frames, 8) * ramp(frame, 4, 14);
  const text = `“${run.request}”`;
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', padding: '0 56px 60px', opacity }}>
      <Card style={{ padding: '30px 34px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Dot tone="lime" size={12} />
          <Eyebrow color={C.text} size={18}>
            The request
          </Eyebrow>
          <Eyebrow size={15} style={{ marginLeft: 'auto' }}>
            spoken via Muse Voice Transcribe, or typed
          </Eyebrow>
        </div>
        <div style={{ fontFamily: FONT.title, fontSize: 40, lineHeight: 1.3, color: C.text, minHeight: 104 }}>
          {typed(text, frame, 12, 64)}
        </div>
      </Card>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 2. SAM 3.1 finds every object

const SCAN_TOP = 380;
const SCAN_BOTTOM = 1260;

export const SegmentBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { frames } = BEATS.segment;
  const { toFrame } = useProjection(BASE_CAMERA);
  const fade = beatOpacity(frame, frames, 10);
  const sweep = ramp(frame, 6, 66, Easing.inOut(Easing.cubic));
  const lineY = SCAN_TOP + (SCAN_BOTTOM - SCAN_TOP) * sweep;
  const appear = (cy: number) => {
    const at = 6 + 60 * ((cy - SCAN_TOP) / (SCAN_BOTTOM - SCAN_TOP));
    return ramp(frame, at, at + 12);
  };
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <Overlay camera={BASE_CAMERA}>
        {sweep < 1 ? (
          <g opacity={1 - ramp(frame, 60, 70)}>
            <rect x={0} y={lineY - 70} width={1440} height={70} fill="url(#scanGlow)" />
            <line x1={0} x2={1440} y1={lineY} y2={lineY} stroke={C.lime} strokeWidth={3} />
          </g>
        ) : null}
        <defs>
          <linearGradient id="scanGlow" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={C.lime} stopOpacity={0} />
            <stop offset="1" stopColor={C.lime} stopOpacity={0.22} />
          </linearGradient>
        </defs>
        {beforeOutlines.map((o) => (
          <DottedPath key={o.object} d={o.d} color={C.lime} opacity={appear(o.centroid?.[1] ?? 0)} />
        ))}
      </Overlay>
      {beforeOutlines.map((o) => {
        const [x, y] = toFrame(labelAnchor(o.box, o.centroid, (o as { areaPx?: number }).areaPx));
        return <ObjectLabel key={o.object} x={x} y={y} text={o.label ?? o.object} opacity={appear(o.centroid?.[1] ?? 0)} />;
      })}
      <Caption {...caption('segment')} opacity={1}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, opacity: ramp(frame, 40, 60) }}>
          <Num size={44} color={C.lime}>
            {OBJECTS}
          </Num>
          <Eyebrow size={16}>objects</Eyebrow>
        </div>
      </Caption>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 3. Muse Spark writes the edit

function Highlighted({ text }: { text: string }) {
  const moving = moves().map((m) => m.label);
  if (!moving.length) return <>{text}</>;
  const pattern = new RegExp(`(${moving.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return (
    <>
      {text.split(pattern).map((part, i) =>
        moving.includes(part) ? (
          <span key={i} style={{ color: C.lime }}>
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

export const InstructBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { frames } = BEATS.instruct;
  const fade = beatOpacity(frame, frames, 10);
  const sentences = editSentences(3);
  const total = sentences.join(' ').length;
  let used = 0;
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <AbsoluteFill style={{ padding: '200px 56px 0' }}>
        <Card style={{ display: 'flex', flexDirection: 'column', gap: 22, padding: '34px 36px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Dot tone="lime" size={12} />
            <Eyebrow color={C.text} size={17}>
              Edit instruction for this photo
            </Eyebrow>
          </div>
          {sentences.map((sentence, i) => {
            const start = 12 + (used / total) * 78;
            used += sentence.length + 1;
            const end = 12 + (used / total) * 78;
            const shown = typed(sentence, frame, start, end);
            return (
              <div key={i} style={{ fontFamily: FONT.body, fontSize: 31, lineHeight: 1.38, color: C.text, fontWeight: 500, minHeight: 43 }}>
                <Highlighted text={shown} />
              </div>
            );
          })}
        </Card>
      </AbsoluteFill>
      <Caption {...caption('instruct')} opacity={1} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 4. Muse Image develops versions; SAM 3.1 checks them; Spark picks

export const DEVELOP = { start: 14, stagger: 16, length: 62, check: 118, checkStagger: 12, choose: 172 } as const;

export const DevelopBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { frames } = BEATS.develop;
  const sheet = sheetCandidates();
  const rects = contactLayout(sheet.length);
  const chosenIndex = sheet.findIndex((c) => c.id === chosen.id);
  const phase = frame < DEVELOP.check - 6 ? 0 : frame < DEVELOP.choose - 4 ? 1 : 2;
  const phaseOpacity = (p: number, start: number, end: number) =>
    phase === p ? Math.min(ramp(frame, start, start + 8), 1 - ramp(frame, end - 8, end)) : 0;
  const rounds = new Set(sheet.map((c) => c.round)).size;
  const tailFade = 1 - ramp(frame, frames - 4, frames); // the chosen print carries on into the wipe

  return (
    <AbsoluteFill>
      {sheet.map((candidate, i) => {
        const rect = rects[i];
        const develop = ramp(frame, DEVELOP.start + i * DEVELOP.stagger, DEVELOP.start + i * DEVELOP.stagger + DEVELOP.length, Easing.inOut(Easing.quad));
        const checkAt = DEVELOP.check + i * DEVELOP.checkStagger;
        const stamp = spring({ frame: frame - checkAt, fps, config: { damping: 13, stiffness: 180, mass: 0.6 } });
        const isChosen = i === chosenIndex;
        const choose = ramp(frame, DEVELOP.choose, DEVELOP.choose + 16);
        const dim = isChosen ? 1 : 1 - 0.45 * choose;
        const seconds = developSeconds(candidate.id);
        const detail = sentence(prettify(candidate.passed ? candidate.notes[0] ?? '' : candidate.reasons.join('; ') || 'rejected'));
        const score = judgeScore(candidate.id);
        return (
          <React.Fragment key={candidate.id}>
            <div style={{ opacity: (isChosen ? 1 : tailFade) * ramp(frame, 0, 12) }}>
              <Print candidate={candidate} rect={rect} develop={develop} ring={isChosen && choose > 0 ? C.lime : null} opacity={dim} />
            </div>
            <div
              style={{
                position: 'absolute',
                left: rect.left,
                top: rect.top - 44,
                width: rect.width,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                opacity: tailFade * ramp(frame, 0, 12) * dim,
              }}
            >
              <Eyebrow size={15} color={C.text}>
                {rounds > 1 ? `Round ${candidate.round} · ` : 'Version '}
                {candidate.id}
              </Eyebrow>
              {seconds !== null ? (
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, opacity: ramp(frame, DEVELOP.start + i * DEVELOP.stagger + DEVELOP.length - 8, DEVELOP.start + i * DEVELOP.stagger + DEVELOP.length) }}>
                  <Num size={24} color={C.secondary}>
                    {seconds.toFixed(1)}
                  </Num>
                  <Eyebrow size={13}>s</Eyebrow>
                </span>
              ) : null}
            </div>
            <div
              style={{
                position: 'absolute',
                left: rect.left - 6,
                top: rect.top + rect.height + 16,
                width: rect.width + 12,
                display: 'flex',
                justifyContent: 'center',
                opacity: tailFade * Math.min(1, stamp * 1.4) * dim,
              }}
            >
              <Stamp
                tone={candidate.passed ? 'lime' : 'orange'}
                title={candidate.passed ? `Keeps all ${OBJECTS} objects` : 'Rejected'}
                detail={detail}
                scale={0.6 + 0.4 * stamp}
                rotate={i % 2 ? 2.5 : -2.5}
                style={{ maxWidth: rect.width + 12 }}
              />
            </div>
            {isChosen ? (
              <div
                style={{
                  position: 'absolute',
                  left: rect.left,
                  top: rect.top + 14,
                  width: rect.width,
                  display: 'flex',
                  justifyContent: 'center',
                  opacity: choose * tailFade,
                  transform: `translateY(${(1 - choose) * -10}px)`,
                }}
              >
                <span
                  style={{
                    padding: '7px 14px',
                    borderRadius: 999,
                    background: C.lime,
                    color: C.onLime,
                    fontFamily: FONT.body,
                    fontWeight: 700,
                    fontSize: 18,
                    whiteSpace: 'nowrap',
                    boxShadow: '0 8px 20px rgba(0,0,0,0.45)',
                  }}
                >
                  {score !== null ? `Chosen · follows the request ${score}/10` : 'Passed · goes on'}
                </span>
              </div>
            ) : null}
          </React.Fragment>
        );
      })}
      <Caption {...caption('develop')} opacity={phaseOpacity(0, 6, DEVELOP.check - 6)} />
      <Caption {...caption('check')} opacity={phaseOpacity(1, DEVELOP.check - 6, DEVELOP.choose - 4)} />
      <Caption {...caption('choose')} opacity={phaseOpacity(2, DEVELOP.choose - 4, frames + 8) * (1 - ramp(frame, frames - 10, frames))} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 5. before / after

export const WIPE = { expand: 34, sweepIn: [44, 92], sweepBack: [112, 156], arrows: [150, 190] } as const;

export function wipePosition(frame: number): number {
  // share of the frame, from the left, that shows the before photo
  const out = ramp(frame, WIPE.sweepIn[0], WIPE.sweepIn[1], Easing.inOut(Easing.cubic));
  const back = ramp(frame, WIPE.sweepBack[0], WIPE.sweepBack[1], Easing.inOut(Easing.cubic));
  return out * (1 - back);
}

export const WipeChrome: React.FC = () => {
  const frame = useCurrentFrame();
  const { frames } = BEATS.wipe;
  const { toFrame } = useProjection(BASE_CAMERA);
  const p = wipePosition(frame);
  const x = p * 1080;
  const showDivider = p > 0.002 && p < 0.998;
  const arrows = ramp(frame, WIPE.arrows[0], WIPE.arrows[1], Easing.inOut(Easing.quad));
  const fadeOut = 1 - ramp(frame, frames - 10, frames);
  const labels = ramp(frame, WIPE.expand, WIPE.expand + 10) * fadeOut;
  return (
    <AbsoluteFill>
      <Overlay camera={BASE_CAMERA}>
        {afterOutlines
          .filter((o) => o.moves)
          .map((o) => (
            <DottedPath key={o.object} d={o.d} color={C.lime} opacity={arrows * fadeOut} />
          ))}
        {moves().map((m) => {
          const [x1, y1] = m.from;
          const [x2, y2] = m.to;
          const xm = x1 + (x2 - x1) * arrows;
          const ym = y1 + (y2 - y1) * arrows;
          return (
            <g key={m.label} opacity={ramp(frame, WIPE.arrows[0], WIPE.arrows[0] + 6) * fadeOut}>
              <circle cx={x1} cy={y1} r={9} fill="none" stroke={C.neutral} strokeWidth={3} />
              <line x1={x1} y1={y1} x2={xm} y2={ym} stroke={C.lime} strokeWidth={6} strokeDasharray="0 14" strokeLinecap="round" />
              <circle cx={xm} cy={ym} r={11} fill={C.lime} />
            </g>
          );
        })}
      </Overlay>
      {moves().map((m) => {
        const [lx, ly] = toFrame(m.to);
        return <ObjectLabel key={m.label} x={lx} y={ly + 26} text={m.label} tone="lime" opacity={ramp(frame, WIPE.arrows[1] - 8, WIPE.arrows[1]) * fadeOut} />;
      })}
      {showDivider ? (
        <div style={{ position: 'absolute', left: x - 2, top: 0, width: 4, height: 1090, background: `linear-gradient(180deg, ${C.lime} 0%, ${C.lime} 86%, rgba(184,255,94,0) 100%)` }}>
          <div
            style={{
              position: 'absolute',
              top: 640,
              left: -24,
              width: 52,
              height: 52,
              borderRadius: 26,
              background: C.lime,
              boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            }}
          />
        </div>
      ) : null}
      <div style={{ position: 'absolute', top: 176, left: 56, right: 56, display: 'flex', justifyContent: 'space-between', opacity: labels }}>
        <div style={{ opacity: 0.35 + 0.65 * Math.min(1, p * 3) }}>
          <Tag size={19}>Before · your photo</Tag>
        </div>
        <div style={{ opacity: 0.35 + 0.65 * Math.min(1, (1 - p) * 3) }}>
          <Tag tone="lime" size={19}>
            After · version {chosen.id}
          </Tag>
        </div>
      </div>
      <Caption {...caption('wipe')} opacity={beatOpacity(frame, frames, 10) * ramp(frame, WIPE.expand - 6, WIPE.expand + 6)} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 6. the plan: robots and honest refusals

export const PlanBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { frames } = BEATS.plan;
  const fade = beatOpacity(frame, frames, 10);
  const rows = [
    ...run.executed.map((e) => ({
      tone: e.ok ? ('lime' as const) : ('orange' as const),
      tag: e.robot === 'arm' ? 'Arm' : 'Mobile manipulator',
      label: e.label,
      detail: run.steps.find((s) => s.label === e.label)?.why ?? '',
    })),
    ...refusals().map((r) => ({ tone: 'orange' as const, tag: 'Refused', label: r.label, detail: r.reason })),
  ].slice(0, 4);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <AbsoluteFill style={{ padding: '200px 56px 0' }}>
        <Card style={{ display: 'flex', flexDirection: 'column', gap: 26, padding: '32px 36px' }}>
          <Eyebrow color={C.text} size={17}>
            The plan · {run.executed.length} {run.executed.length === 1 ? 'move' : 'moves'}
            {refusals().length ? `, ${refusals().length} refused` : ''}
          </Eyebrow>
          {rows.map((row, i) => {
            const show = ramp(frame, 12 + i * 12, 24 + i * 12);
            return (
              <div key={i} style={{ display: 'flex', gap: 18, alignItems: 'flex-start', opacity: show, transform: `translateY(${(1 - show) * 12}px)` }}>
                <div style={{ paddingTop: 10 }}>
                  <Dot tone={row.tone} size={14} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <Tag tone={row.tone} size={18}>
                      {row.tag}
                    </Tag>
                    <span style={{ fontFamily: FONT.body, fontWeight: 650, fontSize: 34, color: C.text }}>{row.label}</span>
                  </div>
                  <span style={{ fontFamily: FONT.body, fontSize: 28, lineHeight: 1.35, color: row.tone === 'orange' ? C.orange : C.neutral }}>{sentence(row.detail)}</span>
                </div>
              </div>
            );
          })}
          {run.orderReason ? (
            <div style={{ fontFamily: FONT.body, fontSize: 26, lineHeight: 1.4, color: C.secondary, opacity: ramp(frame, 40, 56), borderTop: `1px solid ${C.line}`, paddingTop: 20 }}>
              Order: {run.orderReason}
            </div>
          ) : null}
        </Card>
      </AbsoluteFill>
      <Caption {...caption('plan')} opacity={1} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 7. the twin, rendered from the photo's camera

export const TwinBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { frames } = BEATS.twin;
  const fade = beatOpacity(frame, frames, 10);
  const draw = (i: number) => ramp(frame, 18 + i * 5, 30 + i * 5);
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      {run.render ? (
        <Overlay camera={BASE_CAMERA}>
          {afterOutlines.map((o, i) => (
            <DottedPath key={o.object} d={o.d} color={o.moves ? C.lime : C.neutral} opacity={draw(i)} />
          ))}
        </Overlay>
      ) : null}
      <div style={{ position: 'absolute', top: 176, left: 56, display: 'flex', gap: 10, opacity: ramp(frame, 8, 18) }}>
        <Tag size={19}>{run.render ? 'The twin, rendered from the photo’s camera' : 'The after photo'}</Tag>
        {run.render ? (
          <Tag tone="lime" size={19}>
            dots: the after photo
          </Tag>
        ) : null}
      </div>
      <Caption {...caption('twin')} opacity={1} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- 8. the receipt

export const ReceiptBeat: React.FC = () => {
  const frame = useCurrentFrame();
  const { frames } = BEATS.receipt;
  const fade = beatOpacity(frame, frames, 10);
  const r = run.receipt;
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <AbsoluteFill style={{ padding: '176px 56px 0' }}>
        <Card style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: '28px 34px 30px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <Eyebrow color={C.text} size={17}>
              Receipt · error vs the after photo
            </Eyebrow>
            <Eyebrow size={15}>within 3 cm = match</Eyebrow>
          </div>
          {r.results.map((row, i) => {
            const show = ramp(frame, 8 + i * 6, 18 + i * 6);
            const tone = row.ok ? 'lime' : 'orange';
            return (
              <div
                key={row.label}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '22px 1fr auto 150px',
                  alignItems: 'center',
                  gap: 16,
                  padding: '11px 0',
                  borderTop: `1px solid ${C.line}`,
                  opacity: show,
                }}
              >
                <Dot tone={tone} size={13} />
                <span style={{ fontFamily: FONT.body, fontSize: 29, fontWeight: 600, color: C.text }}>{row.label}</span>
                <Tag tone={row.wanted === 'move' ? 'lime' : 'neutral'} size={16}>
                  {row.wanted === 'move' ? 'moves' : 'stays'}
                </Tag>
                <span style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: 8 }}>
                  <Num size={30} color={row.ok ? C.text : C.orange}>
                    {formatCm(row.errorCm)}
                  </Num>
                  <span style={{ fontFamily: FONT.body, fontSize: 18, color: C.secondary }}>cm</span>
                </span>
              </div>
            );
          })}
          <div style={{ display: 'flex', gap: 34, alignItems: 'flex-end', paddingTop: 22, borderTop: `1px solid ${C.line}`, opacity: ramp(frame, 60, 76) }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Num size={76} color={C.lime}>
                {r.matched}/{r.total}
              </Num>
              <Eyebrow size={14}>objects match</Eyebrow>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <Num size={52}>{r.medianErrorCm.toFixed(1)}</Num>
                <span style={{ fontFamily: FONT.body, fontSize: 20, color: C.secondary }}>cm</span>
              </span>
              <Eyebrow size={14}>median error</Eyebrow>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginLeft: 'auto', alignItems: 'flex-end' }}>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <Num size={40}>{run.seconds}</Num>
                <span style={{ fontFamily: FONT.body, fontSize: 18, color: C.secondary, marginRight: 14 }}>s</span>
                <Num size={40}>${run.costUsd.toFixed(2)}</Num>
              </span>
              <Eyebrow size={14}>whole loop</Eyebrow>
            </div>
          </div>
        </Card>
        {run.verdict ? (
          <div style={{ marginTop: 20, display: 'flex', gap: 14, alignItems: 'baseline', opacity: ramp(frame, 78, 94) }}>
            <Tag tone={run.verdict.matchesRequest ? 'lime' : 'orange'} size={17}>
              Muse Spark
            </Tag>
            <span style={{ fontFamily: FONT.body, fontSize: 25, lineHeight: 1.35, color: C.text }}>“{run.verdict.text}”</span>
          </div>
        ) : null}
      </AbsoluteFill>
      <Caption {...caption('receipt')} opacity={1} />
    </AbsoluteFill>
  );
};
