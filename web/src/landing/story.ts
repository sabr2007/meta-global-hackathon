// The narrative slots: the film's caption, the problem photo, and the six stations of the loop.
import { fillSlot, h, num } from './dom';
import {
  chosen,
  editSentences,
  evalFacts,
  formatSeconds,
  formatUsd,
  judgeOf,
  loop,
  median,
  movedLabels,
  prettify,
  run,
  scan,
  sentenceCase,
  usageOf,
} from './facts';
import { photoCrop, type Crop } from './photo';

// The table, with a margin around every object (hero pixels).
export const PROBLEM_CROP: Crop = { x: 250, y: 360, w: 1150, h: 920 };

const GRIPPER_OPENS_CM = 11; // the arm's gripper, as its refusals report it

const objectWidth = (label: string): string | null => {
  const object = scan.objects.find((o) => o.label === label);
  return object ? Math.min(object.sizeCm[0], object.sizeCm[1]).toFixed(1) : null;
};

/** One honest question per object on the desk; the numbers come from the scan. */
function questionFor(label: string): string {
  const width = objectWidth(label);
  switch (label) {
    case 'white keyboard':
      return `${width} cm wide. Can a gripper that opens ${GRIPPER_OPENS_CM} cm hold it?`;
    case 'yellow cylinder':
      return `${width} cm wide, and the gripper opens ${GRIPPER_OPENS_CM} cm. Close enough?`;
    case 'white mouse':
      return 'Next to the keyboard, or out of the way?';
    case 'white earbud case':
      return 'Which corner, and how close to the edge?';
    case 'orange ring toy':
      return 'With the other orange toy, or on its own?';
    case 'orange figurine':
      return 'Which way should it face?';
    case 'silver laptop':
      return 'It stays. Does everything else make room?';
    default:
      return 'Moves, or stays?';
  }
}

export function renderFilmCaption(): void {
  fillSlot(
    'film-caption',
    `A real run on this desk, from request to receipt: “${run.request}” in ${run.seconds} s for ${formatUsd(run.costUsd)} of model calls.`,
  );
  fillSlot('film-transcript', ...loop.cues.map((cue) => h('li', {}, `${cue.chip}: ${cue.text}`)));
}

export function renderProblem(): void {
  const ordered = [...scan.outlines].sort((a, b) => (a.centroid?.[1] ?? 0) - (b.centroid?.[1] ?? 0));
  const markers = ordered.flatMap((o, i) => {
    if (!o.centroid) return [];
    const [x, y, w] = o.box;
    // big objects carry their number inside, small ones just above their outline
    const at: [number, number] = o.areaPx > 30000 ? [o.centroid[0], o.centroid[1]] : [x + w / 2, y - 36];
    return [{ at, text: String(i + 1) }];
  });
  fillSlot(
    'problem-photo',
    photoCrop({
      crop: PROBLEM_CROP,
      images: scan.before,
      alt: `The real desk before anything moves, with SAM 3.1's dotted outline around each of its ${scan.objects.length} objects.`,
      sizes: '(min-width: 1024px) 700px, calc(100vw - 32px)',
      outlines: scan.outlines.map((outline) => ({ outline, tone: 'orange' as const })),
      markers,
    }),
  );
  fillSlot(
    'questions',
    ...ordered.map((o, i) =>
      h('li', {}, h('span', { class: 'num' }, i + 1), h('span', {}, h('strong', {}, sentenceCase(o.label ?? o.object)), questionFor(o.label ?? o.object))),
    ),
  );
}

function highlighted(sentence: string): (string | HTMLElement)[] {
  const moved = movedLabels();
  if (!moved.length) return [sentence];
  const pattern = new RegExp(`(${moved.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
  return sentence.split(pattern).map((part) => (moved.includes(part) ? h('mark', {}, part) : part));
}

function stationRequest(): void {
  const wave = h('span', { class: 'wave', 'aria-hidden': 'true' });
  for (const height of [0.35, 0.7, 1, 0.55, 0.85, 0.4, 0.65, 0.3, 0.75, 0.5, 0.9, 0.45]) {
    const bar = h('span');
    bar.style.setProperty('--h', String(height));
    wave.append(bar);
  }
  fillSlot('request', wave, h('p', { class: 'request__text' }, `“${run.request}”`), h('p', { class: 'eyebrow' }, 'The request of this run'));
}

function stationEdit(): void {
  const usage = usageOf('instruct');
  fillSlot(
    'edit',
    ...editSentences(3).map((sentence) => h('p', {}, ...highlighted(sentence))),
    usage ? h('p', { class: 'meta' }, h('span', { class: 'eyebrow' }, 'Muse Spark'), num(formatSeconds(usage.ms), 's'), num(`$${usage.costUsd.toFixed(3)}`)) : null,
  );
}

function stationVersions(): void {
  fillSlot(
    'versions',
    ...run.candidates.map((candidate, i) => {
      const develop = usageOf('imagine', `Version ${candidate.id} `);
      const print = h('div', { class: 'version__print' });
      print.style.setProperty('--delay', `${i * 180}ms`);
      if (candidate.images) {
        print.append(
          h('img', {
            src: `/landing/${candidate.images['720']}`,
            width: 720,
            height: 960,
            loading: 'lazy',
            decoding: 'async',
            alt: `Version ${candidate.id} of the after photo, as Muse Image developed it.`,
          }),
        );
      }
      return h(
        'li',
        { class: `version${candidate.id === chosen.id ? ' version--chosen' : ''}` },
        h(
          'div',
          { class: 'version__head' },
          h('span', { class: 'eyebrow' }, h('span', { class: 'version__word' }, 'Version '), candidate.id),
          develop ? h('span', {}, num(formatSeconds(develop.ms), 's')) : null,
        ),
        print,
      );
    }),
  );
}

function stationVerdicts(): void {
  const objects = scan.objects.length;
  fillSlot(
    'verdicts',
    ...run.candidates.map((candidate) =>
      h(
        'li',
        { class: `verdict${candidate.passed ? '' : ' verdict--rejected'}` },
        h('span', { class: 'eyebrow verdict__id' }, candidate.id),
        h('span', { class: 'verdict__title' }, candidate.passed ? `Keeps all ${objects} objects` : 'Rejected'),
        h('span', { class: 'verdict__detail' }, sentenceCase(prettify((candidate.passed ? candidate.notes[0] : candidate.reasons[0]) ?? ''))),
      ),
    ),
  );
  const strictest = [...evalFacts.list].sort((a, b) => b.rejected - a.rejected)[0];
  if (strictest && strictest.rejected > 0) {
    fillSlot(
      'rejections',
      `In the “${strictest.request}” run, SAM 3.1 rejected ${strictest.rejected} of ${strictest.candidates} versions before one passed. Rejected versions never reach a robot.`,
    );
  }
}

function stationPick(): void {
  const judge = judgeOf(chosen.id);
  const plan = h(
    'ul',
    { class: 'plan', role: 'list' },
    ...run.executed.map((step) => {
      const why = run.steps.find((s) => s.label === step.label)?.why ?? '';
      return h('li', {}, h('span', { class: `tag ${step.ok ? 'tag--lime' : 'tag--orange'}` }, step.robot === 'arm' ? 'Arm' : 'Mobile'), h('strong', {}, step.label), h('span', {}, why));
    }),
    ...[...run.refusals, ...run.planRefusals].map((refusal) =>
      h('li', { class: 'is-refused' }, h('span', { class: 'tag tag--orange' }, 'Refused'), h('strong', {}, refusal.label), h('span', {}, sentenceCase(prettify(refusal.reason)))),
    ),
  );
  fillSlot(
    'pick',
    h(
      'div',
      { class: 'pick__choice' },
      h('span', { class: 'tag tag--lime tag--wrap' }, judge ? `Version ${chosen.id} · follows the request ${judge.followsRequest}/10` : `Version ${chosen.id}`),
      judge ? h('q', {}, sentenceCase(judge.note)) : null,
    ),
    plan,
  );
}

function stationBodies(): void {
  const fits = scan.objects.map((o) => o.fitErrorMm);
  fillSlot(
    'bodies',
    h(
      'div',
      { class: 'bodies__totals' },
      h('p', { class: 'figure' }, h('span', {}, num(scan.objects.length)), h('span', { class: 'eyebrow' }, 'SAM 3D bodies on this desk')),
      h('p', { class: 'figure' }, h('span', {}, num(median(fits).toFixed(1), 'mm')), h('span', { class: 'eyebrow' }, 'median gap to their LiDAR points')),
    ),
    h(
      'ul',
      { class: 'chips', role: 'list' },
      ...scan.objects.map((o) => h('li', { class: 'tag' }, `${o.label} `, h('span', { class: 'num' }, o.fitErrorMm.toFixed(1)), ' mm')),
    ),
  );
}

export function renderStations(): void {
  stationRequest();
  stationEdit();
  stationVersions();
  stationVerdicts();
  stationPick();
  stationBodies();
}
