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
    judged: string; // the app's line for the choice, e.g. "Only version 1c passed the check"
    steps: { label: string; robot: string; why: string }[];
    orderReason: string;
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
    verdict: { matchesRequest: boolean; text: string } | null; // Muse Spark on the result vs the goal
    render: { '720': string } | null; // the verifier's render of the twin from the photo's camera
    costUsd: number;
    seconds: number;
  };
  others: OtherRun[];
}

/** Another saved run on the same scan, without pictures. */
export interface OtherRun {
  id: string;
  request: string;
  candidates: { id: string; passed: boolean; reasons: string[] }[];
  executed: { label: string; robot: string; ok: boolean }[];
  refusals: { label: string; reason: string }[];
  receipt: { matched: number; total: number };
}

export interface EvalRun {
  run: string;
  scan: string;
  status: string; // 'done' (measured) or 'no-after' (every version rejected, nothing moved)
  request: string;
  matched: number | null;
  total: number | null;
  medianErrorCm: number | null;
  candidates: number;
  rejected: number;
  refusals: string[];
  seconds: number;
  costUsd: number;
}

export interface EvalFacts {
  source: string;
  generated: string;
  scan: string;
  runs: number; // measured runs
  stopped: number; // runs where no version passed SAM 3.1, so no robot moved
  attempted: number;
  scans: string[];
  requests: string[];
  objects: { checked: number; matched: number };
  medianErrorCm: { median: number; min: number; max: number };
  versions: { developed: number; rejected: number };
  moves: { asked: number; done: number };
  stays: { total: number; kept: number }; // objects the after photo left in place
  refusals: { count: number; runsWithRefusals: number };
  failedSteps: number;
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

export interface PolicyFacts {
  scan: string;
  generated: string;
  episodes: number;
  table: { policy: string; episodes: number; done: number; asked: number; kept: number; stays: number; meanScore: number; medianMoveErrorCm: number; slipped: number }[];
}
