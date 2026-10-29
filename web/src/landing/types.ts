// Shapes of the facts the landing renders (Vite bundles the JSON). All three are generated:
//   facts/showcase.json  video/scripts/prepare-assets.mjs (a real saved run on the desk scan)
//   facts/eval.json      web/scripts/landing-numbers.mjs  (the eval log of headless runs)
//   facts/loop.json      video/scripts/render.mjs         (the film's poster time and captions)

export interface Outline {
  object: string;
  label?: string;
  d: string; // SVG path in hero-photo pixels
  centroid: number[] | null; // [x, y]
  box: number[]; // [x, y, w, h] in hero-photo pixels
  areaPx: number;
  moves?: boolean;
}

export interface Images {
  '720': string;
  '1080': string;
}

export interface Candidate {
  id: string;
  round: number;
  passed: boolean;
  reasons: string[];
  notes: string[];
  images: Images | null;
}

export interface TraceEntry {
  at: number;
  step: string;
  state: string;
  text: string;
  usage: { model: string; ms: number; costUsd: number | null }[];
}

export interface ReceiptRow {
  label: string;
  wanted: string; // 'move' | 'stay'
  errorCm: number;
  ok: boolean;
  note: string;
}

export interface Showcase {
  scan: {
    id: string;
    device: string;
    photos: number;
    depthFrames: number;
    image: { width: number; height: number };
    objects: { name: string; label: string; sizeCm: number[]; fitErrorMm: number }[];
    before: Images;
    outlines: Outline[];
  };
  run: {
    id: string;
    request: string;
    created: string;
    editPrompt: string;
    summary: string;
    planRefusals: { label: string; reason: string }[];
    candidates: Candidate[];
    chosen: string;
    judge: { reason: string; ranking: { id: string; note: string; followsRequest: number }[] };
    steps: { label: string; robot: string; why: string }[];
    refusals: { label: string; reason: string }[];
    executed: { label: string; robot: string; ok: boolean }[];
    receipt: {
      score: number;
      matched: number;
      total: number;
      medianErrorCm: number;
      moved: { done: number; asked: number };
      results: ReceiptRow[];
    };
    afterOutlines: Outline[];
    trace: TraceEntry[];
    costUsd: number;
    seconds: number;
  };
}

export interface EvalRun {
  run: string;
  scan: string;
  request: string;
  score: number;
  matched: number;
  total: number;
  medianErrorCm: number;
  candidates: number;
  rejected: number;
  refusals: string[];
  seconds: number;
  costUsd: number;
}

export interface EvalFacts {
  source: string;
  generated: string;
  runs: number;
  attempted: number;
  scans: string[];
  requests: string[];
  objects: { checked: number; matched: number };
  medianErrorCm: { median: number; min: number; max: number };
  versions: { developed: number; rejected: number };
  moves: { asked: number; done: number };
  refusals: { count: number; runsWithRefusals: number };
  failedSteps: number;
  score: { median: number };
  costUsd: { median: number; total: number };
  seconds: { median: number; min: number; max: number };
  list: EvalRun[];
}

export interface LoopFacts {
  posterFrame: number;
  posterSeconds: number;
  seconds: number;
  bytes: number;
  cues: { start: number; end: number; chip: string; text: string }[];
}
