// Building blocks of the run panel: who did what (models by name, time, cost), the developed
// versions with their verdicts, the robots' steps and the receipt.

import type { RunCard } from '../ayna/client';
import type { PlannedStep, Refusal } from '../ayna/dispatch';
import type { Step, TraceEvent, Usage } from '../ayna/run';
import type { Receipt } from '../ayna/verify';

export const MODEL_OF: Record<Step, string> = {
  listen: 'Voice Transcribe',
  instruct: 'Muse Spark',
  imagine: 'Muse Image',
  check: 'SAM 3.1',
  judge: 'Muse Spark',
  plan: 'Muse Spark',
  execute: 'Robots',
  verify: 'Verifier',
  verdict: 'Muse Spark',
};

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const seconds = (ms: number): string => (ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

/** The live log of model calls. */
export function timeline(): { root: HTMLElement; add(event: TraceEvent): void; clear(): void } {
  const root = h('ol', 'timeline');
  root.setAttribute('aria-live', 'polite');
  let working: HTMLElement | null = null;
  return {
    root,
    clear() {
      root.replaceChildren();
      working = null;
    },
    add(event) {
      // A version can fail SAM 3.1's object check or the robots' reach test; say which did.
      const reach = event.step === 'check' && /no robot can|would land on/.test(event.text);
      const model = event.step === 'execute' ? event.text.split(':')[0] : reach ? 'SAM 3.1 · reach test' : MODEL_OF[event.step];
      if (event.state === 'start') {
        working?.remove();
        working = h('li', 'timeline__row timeline__row--working');
        working.append(h('span', 'timeline__pulse'), h('span', 'eyebrow', model), h('span', 'timeline__text', event.text));
        root.append(working);
        return;
      }
      working?.remove();
      working = null;
      const row = h('li', `timeline__row timeline__row--${event.state}`);
      const tone = event.state === 'fail' ? 'dot--orange' : event.state === 'done' ? 'dot--lime' : '';
      row.append(h('span', `dot ${tone}`), h('span', 'eyebrow', model), h('span', 'timeline__text', event.text));
      const usage = event.usage ?? [];
      if (usage.length) {
        const ms = Math.max(...usage.map((u) => u.ms));
        const cost = usage.reduce((s, u) => s + u.costUsd, 0);
        const meter = h('span', 'timeline__meter');
        meter.append(h('span', 'num', seconds(ms)));
        if (cost > 0) meter.append(h('span', 'timeline__cost', `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`));
        row.append(meter);
      }
      root.append(row);
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
  };
}

export interface VersionView {
  id: string;
  image: string;
  passed: boolean;
  reasons: string[];
  chosen: boolean;
}

/** The developed versions of the after photo, each with SAM 3.1's verdict. */
export function versions(onPick: (id: string) => void): { root: HTMLElement; set(list: VersionView[]): void } {
  const root = h('div', 'versions');
  return {
    root,
    set(list) {
      root.replaceChildren(
        ...list.map((v) => {
          // No version could be done in full: this one keeps every object and goes ahead, and the
          // robots refuse the moves they cannot do (the receipt counts them).
          const fallback = v.chosen && !v.passed;
          const state = v.passed ? 'version--passed' : fallback ? 'version--fallback' : 'version--rejected';
          const card = h('button', `version ${state} ${v.chosen ? 'version--chosen' : ''}`);
          card.type = 'button';
          const said = v.passed ? 'kept every object' : fallback ? `goes ahead, the robots refuse what they cannot do: ${v.reasons.join('; ')}` : `rejected, ${v.reasons.join('; ')}`;
          card.setAttribute('aria-label', `Version ${v.id}: ${said}`);
          const img = h('img');
          img.src = v.image;
          img.alt = '';
          img.loading = 'lazy';
          const label = h('span', 'version__label');
          label.append(h('span', 'num', v.id.toUpperCase()), h('span', `dot ${v.passed ? 'dot--lime' : 'dot--orange'}`));
          card.append(img, label);
          if (fallback) card.append(h('span', 'version__chosen version__chosen--fallback', 'Goes ahead · robots refuse what they cannot do'));
          else if (!v.passed) card.append(h('span', 'version__reason', v.reasons[0] ?? 'rejected'));
          else if (v.chosen) card.append(h('span', 'version__chosen', 'Approved goal'));
          card.addEventListener('click', () => onPick(v.id));
          return card;
        }),
      );
    },
  };
}

export function stepsList(steps: PlannedStep[], refusals: Refusal[], robotLabel: (id: string) => string): { root: HTMLElement; mark(object: string, ok: boolean, reason: string): void } {
  const root = h('ol', 'steps');
  const rows = new Map<string, HTMLElement>();
  steps.forEach((s, i) => {
    const row = h('li', 'steps__row');
    row.append(h('span', 'num steps__index', String(i + 1).padStart(2, '0')), h('span', 'steps__what', s.label), h('span', 'tag', robotLabel(s.robot)));
    if (s.why) row.append(h('span', 'steps__why', s.why));
    rows.set(s.object, row);
    root.append(row);
  });
  for (const r of refusals) {
    const row = h('li', 'steps__row steps__row--refused');
    row.append(h('span', 'dot dot--orange'), h('span', 'steps__what', r.label), h('span', 'tag tag--orange', 'refused'), h('span', 'steps__why', r.reason));
    root.append(row);
  }
  return {
    root,
    mark(object, ok, reason) {
      const row = rows.get(object);
      if (!row) return;
      row.classList.add(ok ? 'steps__row--done' : 'steps__row--failed');
      if (!ok) row.append(h('span', 'steps__why', reason));
    },
  };
}

const MODEL_NAMES: Record<string, string> = {
  'muse-voice-transcribe-1.0': 'Voice Transcribe',
  'muse-spark-1.3': 'Muse Spark',
  'muse-image-1.0': 'Muse Image',
  'sam-3.1': 'SAM 3.1',
};

/** Calls, time and cost per Meta model over a run. */
export function modelSummary(usage: Usage[]): { model: string; calls: number; ms: number; costUsd: number }[] {
  const byModel = new Map<string, { model: string; calls: number; ms: number; costUsd: number }>();
  for (const u of usage) {
    const entry = byModel.get(u.model) ?? { model: MODEL_NAMES[u.model] ?? u.model, calls: 0, ms: 0, costUsd: 0 };
    entry.calls += 1;
    entry.ms += u.ms;
    entry.costUsd += u.costUsd;
    byModel.set(u.model, entry);
  }
  return [...byModel.values()];
}

function wantedLabel(r: Receipt['results'][number]): string {
  if (r.wanted === 'stay') return 'stays';
  if (/^refused/.test(r.note)) return 'move refused';
  return r.overlap === null ? 'moved' : `moved · overlap ${Math.round(r.overlap * 100)}%`;
}

export function receiptCard(receipt: Receipt, extras: { seconds: number; costUsd: number; verdict: string | null; replay: boolean; usage?: Usage[]; episodeUrl?: string }): HTMLElement {
  const card = h('section', 'receipt card');
  card.setAttribute('aria-label', 'Receipt');
  const head = h('header', 'receipt__head');
  const score = h('div', 'receipt__score');
  score.append(h('span', `num ${receipt.score >= 80 ? 'is-lime' : 'is-orange'}`, String(receipt.score)), h('span', 'eyebrow', 'score'));
  const summary = h('div', 'receipt__summary');
  const overlap = receipt.overlap === null ? '' : ` · independent check against the imagined photo: contours overlap ${Math.round(receipt.overlap * 100)}%`;
  const inPhoto = receipt.photoMedianErrorCm === null || receipt.photoMedianErrorCm === undefined ? '' : `, centres ${receipt.photoMedianErrorCm.toFixed(1)} cm apart (median)`;
  summary.append(
    h('p', 'receipt__line', `${receipt.moved.done} of ${receipt.moved.asked} requested moves done`),
    h('p', 'receipt__sub', `${receipt.stayed.kept} of ${receipt.stayed.total} other objects left in place · moved objects off their goals by ${receipt.medianErrorCm.toFixed(1)} cm (median), tolerance 3 cm${overlap}${inPhoto}`),
  );
  head.append(score, summary);
  const table = h('ul', 'receipt__rows');
  for (const r of receipt.results) {
    const row = h('li', `receipt__row ${r.ok ? '' : 'receipt__row--miss'}`);
    row.append(
      h('span', `dot ${r.ok ? 'dot--lime' : 'dot--orange'}`),
      h('span', 'receipt__object', r.label),
      h('span', 'receipt__wanted', wantedLabel(r)),
      h('span', 'num receipt__error', /^refused before the edit/.test(r.note) ? '—' : `${(r.errorM * 100).toFixed(1)}`),
      h('span', 'receipt__unit', 'cm'),
    );
    if (r.note) row.append(h('span', 'receipt__note', r.note.replace(/^refused: /, 'refused — ').replace(/^refused before the edit: /, 'refused before the edit — ').replace(/^failed: /, 'failed — ')));
    table.append(row);
  }
  card.append(head, table);
  if (extras.verdict) {
    const verdict = h('blockquote', 'receipt__verdict');
    verdict.append(h('span', 'eyebrow', 'Muse Spark'), h('p', '', extras.verdict));
    card.append(verdict);
  }
  if (extras.usage?.length) {
    const models = h('ul', 'receipt__models');
    models.setAttribute('aria-label', 'Meta models used in this run');
    for (const m of modelSummary(extras.usage)) {
      const chip = h('li', 'receipt__model');
      chip.append(h('span', 'eyebrow', m.model), h('span', 'num', `×${m.calls}`), h('span', 'receipt__model-cost', `${seconds(m.ms)} · $${m.costUsd.toFixed(3)}`));
      models.append(chip);
    }
    card.append(models);
  }
  const foot = h('footer', 'receipt__foot');
  foot.append(
    h('span', '', extras.replay ? 'Replay · robots re-ran in the twin, no model calls' : 'Live run'),
    h('span', 'num', `${Math.round(extras.seconds)}s`),
    h('span', 'num', `$${extras.costUsd.toFixed(2)}`),
  );
  card.append(foot);
  if (extras.episodeUrl) {
    const episode = h('a', 'pill pill--small pill--outline receipt__episode', 'Export as an evaluation episode');
    episode.href = extras.episodeUrl;
    episode.setAttribute('download', '');
    card.append(episode);
  }
  return card;
}

export function historyStrip(runs: RunCard[], onOpen: (id: string) => void): HTMLElement {
  const root = h('div', 'history');
  if (!runs.length) {
    root.append(h('p', 'history__empty', 'No runs yet. The first one is saved here.'));
    return root;
  }
  for (const run of runs) {
    const card = h('button', 'history__run');
    card.type = 'button';
    if (run.thumb) {
      const img = h('img');
      img.src = run.thumb;
      img.alt = '';
      img.loading = 'lazy';
      card.append(img);
    }
    const meta = h('span', 'history__meta');
    const outcome =
      run.score === null
        ? `SAM 3.1 rejected all ${run.versions} after photos`
        : `${run.moves ? `${run.moves.done}/${run.moves.asked} moves` : ''}${run.rejected ? ` · ${run.rejected} of ${run.versions} versions rejected` : ''}`;
    meta.append(
      h('span', `num ${run.score !== null && run.score >= 80 ? 'is-lime' : 'is-orange'}`, run.score === null ? '—' : String(run.score)),
      h('span', 'history__request', run.request),
      h('span', 'history__outcome', outcome),
      h('span', 'history__date', new Date(run.created).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
    );
    card.append(meta);
    card.addEventListener('click', () => onOpen(run.id));
    root.append(card);
  }
  return root;
}
