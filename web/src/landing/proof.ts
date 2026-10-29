// The evidence slots: the comparison, the receipt, the eval totals, refusals and scan facts.
import { fillSlot, h, num, s } from './dom';
import { allRefusals, chosen, deviceName, evalFacts, formatCm, formatDate, formatUsd, judgeOf, median, robotMoves, run, scan, sentenceCase } from './facts';
import { photoCrop, type Crop } from './photo';

// Wide enough to show where the mouse goes in the chosen version (hero pixels, 3:2).
export const COMPARE_CROP: Crop = { x: 100, y: 372, w: 1320, h: 880 };

const arrows = () =>
  s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, s('path', { fill: 'currentColor', d: 'M9 6 3 12l6 6V6Zm6 0v12l6-6-6-6Z' }));

export function renderCompare(): HTMLInputElement | null {
  const after = chosen.images;
  if (!after) return null;
  const sizes = '(min-width: 1248px) 1200px, calc(100vw - 32px)';
  const range = h('input', {
    class: 'compare__range',
    type: 'range',
    min: 0,
    max: 100,
    step: 1,
    value: 50,
    'aria-label': 'Compare the before and after photos: move to reveal more of the before photo',
  });
  const knob = h('span', { class: 'compare__knob' }, arrows());
  const judge = judgeOf(chosen.id);
  fillSlot(
    'compare',
    h(
      'div',
      { class: 'compare__before' },
      photoCrop({ crop: COMPARE_CROP, images: scan.before, alt: 'Before: the real desk as the scanner photographed it.', sizes }),
    ),
    h(
      'div',
      { class: 'compare__after' },
      photoCrop({
        crop: COMPARE_CROP,
        images: after,
        alt: `After: version ${chosen.id} from Muse Image, with the moved objects outlined by SAM 3.1.`,
        sizes,
        outlines: run.afterOutlines.filter((o) => o.moves).map((outline) => ({ outline, tone: 'lime' as const })),
      }),
    ),
    range,
    h('div', { class: 'compare__handle', 'aria-hidden': 'true' }, knob),
    h(
      'div',
      { class: 'compare__labels', 'aria-hidden': 'true' },
      h('span', { class: 'tag' }, 'Before · your photo'),
      h('span', { class: 'tag tag--lime' }, judge ? `After · version ${chosen.id} · ${judge.followsRequest}/10` : `After · version ${chosen.id}`),
    ),
  );
  fillSlot('summary', h('p', {}, `“${run.summary}”`), h('footer', {}, `Muse Spark, on version ${chosen.id} for “${run.request}”`));
  return range;
}

export function renderReceipt(): void {
  const receipt = run.receipt;
  fillSlot(
    'receipt',
    h(
      'div',
      { class: 'receipt__head' },
      h('span', { class: 'eyebrow' }, `Receipt · ${formatDate(run.created)}`),
      h('p', { class: 'receipt__request' }, `“${run.request}”`),
    ),
    h(
      'ul',
      { class: 'receipt__rows', role: 'list' },
      ...receipt.results.map((row) =>
        h(
          'li',
          { class: `receipt__row${row.ok ? '' : ' is-miss'}` },
          h('span', { class: `dot ${row.ok ? 'dot--lime' : 'dot--orange'}`, 'aria-hidden': 'true' }),
          h('span', { class: 'receipt__label' }, row.label),
          h('span', { class: `tag${row.wanted === 'move' ? ' tag--lime' : ''}` }, row.wanted === 'move' ? 'moves' : 'stays'),
          h('span', {}, num(formatCm(row.errorCm), 'cm', 'unit')),
          row.note ? h('span', { class: 'receipt__note' }, sentenceCase(row.note)) : null,
          h('span', { class: 'visually-hidden' }, row.ok ? 'matches the after photo' : 'does not match the after photo'),
        ),
      ),
    ),
    h(
      'div',
      { class: 'receipt__total' },
      h('p', { class: 'figure' }, h('span', {}, num(`${receipt.matched}/${receipt.total}`)), h('span', { class: 'eyebrow' }, 'objects match')),
      h('p', { class: 'figure' }, h('span', {}, num(receipt.medianErrorCm.toFixed(1), 'cm')), h('span', { class: 'eyebrow' }, 'median error')),
      h('p', { class: 'figure' }, h('span', {}, num(run.seconds, 's')), h('span', { class: 'eyebrow' }, `${formatUsd(run.costUsd)} in model calls`)),
    ),
    run.verdict
      ? h(
          'p',
          { class: 'receipt__verdict' },
          h('span', { class: `tag ${run.verdict.matchesRequest ? 'tag--lime' : 'tag--orange'}` }, 'Muse Spark'),
          h('q', {}, run.verdict.text),
        )
      : null,
  );
}

export function renderEval(): void {
  const e = evalFacts;
  const tile = (value: string, label: string, modifier = '', unit = '') =>
    h('div', { class: `stat-tile${modifier ? ` stat-tile--${modifier}` : ''}` }, h('span', {}, num(value, unit || undefined)), h('p', {}, label));
  fillSlot(
    'eval',
    tile(`${e.moves.done}/${e.moves.asked}`, `requested moves done, each object within 3 cm of where the after photo put it, across ${e.runs} measured runs of the full loop`, 'hero'),
    tile(`${e.stays.kept}/${e.stays.total}`, 'objects the after photo left alone that the robots left alone too'),
    tile(`${e.medianErrorCm.median.toFixed(1)}`, 'median distance of the moved objects from their goals (the median of each run’s median)', '', 'cm'),
    tile(`${e.runs}/${e.attempted}`, 'runs that got an after photo SAM 3.1 approved; in the others no version passed and no robot moved', e.stopped ? 'orange' : ''),
    tile(`${e.versions.rejected}/${e.versions.developed}`, 'versions of the after photo rejected by SAM 3.1 before any robot moved', 'orange'),
    tile(String(e.refusals.count), `honest refusals, each with its reason, in ${e.refusals.runsWithRefusals} of ${e.runs} measured runs`, 'orange'),
    tile(String(e.failedSteps), 'robot steps that were tried and failed; the receipt shows each one'),
    tile(`${e.seconds.median}`, `median run, request to receipt, at a median $${e.costUsd.median.toFixed(3)} in Meta model calls`, '', 's'),
  );
  fillSlot(
    'eval-source',
    `Source: ${e.attempted} headless runs of the whole loop on the desk scan (${e.requests.length} different requests), with live Meta models, robots in MuJoCo and the same verifier as the app. Logged by `,
    h('code', {}, 'web/scripts/eval.ts'),
    ', summarised by ',
    h('code', {}, 'web/scripts/landing-numbers.mjs'),
    ` on ${formatDate(e.generated)}. The robots are scripted controllers that read exact poses from the simulator, so these numbers grade the goals and the plans, not a learned policy.`,
  );
}

/** What each robot actually moved in the saved runs, under its description. */
export function renderFleet(): void {
  const describe = (kind: 'arm' | 'mobile') => {
    const moves = robotMoves(kind);
    if (!moves.length) return null;
    const objects = [...new Set(moves.map((m) => m.label))];
    const best = [...moves].sort((a, b) => b.matched / b.total - a.matched / a.total)[0];
    return h(
      'span',
      { class: 'fleet__moves' },
      `In saved runs it moved the ${objects.join(', the ')}. `,
      `For “${best.request}”, ${best.matched} of ${best.total} objects matched the after photo.`,
    );
  };
  fillSlot('fleet-arm', describe('arm'));
  fillSlot('fleet-mobile', describe('mobile'));
}

export function renderRefusals(): void {
  fillSlot(
    'refusals',
    ...allRefusals(3).map((refusal) =>
      h(
        'li',
        { class: 'refusal' },
        h('span', { class: 'refusal__object' }, h('span', { class: 'tag tag--orange' }, 'Refused'), refusal.label || 'an object'),
        h('q', {}, sentenceCase(refusal.reason)),
        h('span', { class: 'refusal__context' }, `While asked: “${refusal.request}”`),
      ),
    ),
  );
}

export function renderScanFacts(): void {
  const figure = (value: string | number, unit: string | undefined, label: string) =>
    h('p', { class: 'figure' }, h('span', {}, num(value, unit)), h('span', { class: 'eyebrow' }, label));
  fillSlot(
    'scan-facts',
    figure(scan.photos, undefined, 'photos'),
    figure(scan.depthFrames, undefined, 'depth frames'),
    figure(scan.objects.length, undefined, 'SAM 3D bodies'),
    figure(median(scan.objects.map((o) => o.fitErrorMm)).toFixed(1), 'mm', 'median fit to LiDAR'),
    h('p', { class: 'scan-facts__device' }, `This desk, scanned with an ${deviceName(scan.device)}.`),
  );
}
