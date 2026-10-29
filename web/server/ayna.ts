// Ayna's model steps. Each handler takes plain JSON from the browser, calls Meta models and returns
// JSON plus the usage of every call, so the UI can show which model did what and what it cost.

import { editImage, MetaError, segmentBox, segmentConcept, sparkJson, transcribe, type InputContent, type SamMask, type Usage } from './meta.js';

const GRID = 1000; // Muse Spark grounding grid for boxes
const SAM_CONCURRENCY = 6;

export interface SceneObjectBrief {
  name: string;
  label: string;
  concept: string;
  size_cm: [number, number, number];
  /** Where it is in the hero photo, for Spark: "lower left", "center back", ... */
  where: string;
  /** One line per robot: "arm: ok" / "arm: 0.77 m away, reach 0.76 m". */
  reach: string[];
}

export interface InstructInput {
  request: string;
  photo: string; // data URL of the hero photo
  objects: SceneObjectBrief[];
  robots: string[]; // one line per robot: kind, reach band, gripper width
  feedback?: string; // why the previous imagined photos were rejected
}

export interface Instruction {
  request_en: string;
  edit_prompt: string;
  moves: { object: string; action: 'move' | 'stay'; where: string }[];
  refusals: { object: string; reason: string }[];
  summary: string;
}

const INSTRUCTION_SCHEMA = {
  type: 'object',
  properties: {
    request_en: { type: 'string', description: 'the request in English' },
    edit_prompt: { type: 'string', description: 'the instruction for the image editing model' },
    moves: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          object: { type: 'string', description: 'object name from the list' },
          action: { type: 'string', enum: ['move', 'stay'] },
          where: { type: 'string', description: 'destination in the photo, or "" for stay' },
        },
        required: ['object', 'action', 'where'],
        additionalProperties: false,
      },
    },
    refusals: {
      type: 'array',
      items: {
        type: 'object',
        properties: { object: { type: 'string' }, reason: { type: 'string' } },
        required: ['object', 'reason'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string', description: 'one sentence for the person: what will change' },
  },
  required: ['request_en', 'edit_prompt', 'moves', 'refusals', 'summary'],
  additionalProperties: false,
};

function objectLines(objects: SceneObjectBrief[]): string {
  return objects
    .map((o) => `- ${o.name}: ${o.label}, ${o.size_cm.map((v) => v.toFixed(0)).join(' x ')} cm, ${o.where}; ${o.reach.join('; ')}`)
    .join('\n');
}

export async function instruct(input: InstructInput): Promise<{ instruction: Instruction; usage: Usage[] }> {
  const text = `You plan a tidy-up for robots in a real room. The photo shows a table scanned into a physics twin.
A person asked (any language): "${input.request}"

Objects on the table (name: what it is, size, where in the photo; which robot reaches it):
${objectLines(input.objects)}

Robots:
${input.robots.join('\n')}

Write ONE instruction for an image-editing model that edits THIS photo into the state after the robots
have done the job. The edited photo becomes the robots' goal, so it must be physically achievable:
- move only objects a robot can reach and grip; objects marked MUST STAY never move;
- objects stay on the same table top, upright, the same size, not stacked unless asked;
- make the change obvious at a glance: moved objects travel 10-30 cm, into a clear arrangement (a group,
  a row, a corner), and describe destinations relative to other objects and to the visible table edges;
- the instruction must start with "Edit this photo. Keep the same camera, framing, lighting and table." and
  end with "Keep every other object exactly where it is. Do not add, remove, duplicate or resize anything.";
- name every object by its look (colour + noun), never by its id.
List every object in "moves" (move or stay). Put objects the request implies but no robot can handle in
"refusals" with a short reason (and keep them in place in the image).${input.feedback ? `\n\nThe previous edits were rejected by an automatic check: ${input.feedback}\nRewrite the instruction so this does not happen again.` : ''}`;
  const { value, usage } = await sparkJson<Instruction>('ayna_instruction', INSTRUCTION_SCHEMA, [
    { type: 'input_text', text },
    { type: 'input_image', image_url: input.photo },
  ]);
  return { instruction: value, usage: [usage] };
}

export async function imagine(input: { photo: string; prompt: string }): Promise<{ image: string; usage: Usage[] }> {
  const { dataUrl, usage } = await editImage(input.photo, input.prompt);
  return { image: dataUrl, usage: [usage] };
}

export async function listen(wav: Uint8Array): Promise<{ text: string; usage: Usage[] }> {
  const { text, usage } = await transcribe(wav);
  return { text, usage: [usage] };
}

export interface SegmentInput {
  image: string; // data URL
  width: number;
  height: number;
  objects: { name: string; concept: string; label: string }[];
}

export interface SegmentedObject {
  name: string;
  source: 'concept' | 'spark-box' | 'none';
  masks: SamMask[];
}

const LOCATE_SCHEMA = {
  type: 'object',
  properties: {
    found: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          visible: { type: 'boolean' },
          box_2d: { type: 'array', items: { type: 'integer' }, description: `[x1, y1, x2, y2] on a 0-${GRID} grid` },
        },
        required: ['name', 'visible', 'box_2d'],
        additionalProperties: false,
      },
    },
  },
  required: ['found'],
  additionalProperties: false,
};

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

/** SAM 3.1 finds every scanned object in a photo by its noun phrase; whatever SAM misses, Muse Spark
 * boxes and SAM segments inside the box (the same recovery the scan pipeline uses). */
export async function segment(input: SegmentInput): Promise<{ objects: SegmentedObject[]; usage: Usage[] }> {
  const usage: Usage[] = [];
  const concepts = [...new Set(input.objects.map((o) => o.concept))];
  const byConcept = new Map<string, SamMask[]>();
  await inBatches(concepts, SAM_CONCURRENCY, async (concept) => {
    const result = await segmentConcept(input.image, concept);
    usage.push(result.usage);
    byConcept.set(concept, result.masks);
  });
  const objects: SegmentedObject[] = input.objects.map((o) => {
    const masks = byConcept.get(o.concept) ?? [];
    return { name: o.name, source: masks.length ? 'concept' : 'none', masks };
  });
  const missing = input.objects.filter((o) => !(byConcept.get(o.concept)?.length));
  if (missing.length) {
    const listing = missing.map((o) => `- ${o.name}: ${o.label}`).join('\n');
    const located = await sparkJson<{ found: { name: string; visible: boolean; box_2d: number[] }[] }>(
      'locate',
      LOCATE_SCHEMA,
      [
        {
          type: 'input_text',
          text: `Locate each object in the photo. Give a tight box_2d [x1, y1, x2, y2] on a 0-${GRID} grid (x right, y down). If it is not visible, set visible=false and box_2d=[0,0,0,0].\n${listing}`,
        },
        { type: 'input_image', image_url: input.image },
      ],
    );
    usage.push(located.usage);
    await inBatches(located.value.found, SAM_CONCURRENCY, async (hit) => {
      const target = objects.find((o) => o.name === hit.name);
      if (!target || !hit.visible || hit.box_2d.length !== 4) return;
      const [x1, y1, x2, y2] = hit.box_2d.map((v) => Math.min(Math.max(v, 0), GRID) / GRID);
      const box = {
        left: Math.floor(x1 * (input.width - 1)),
        top: Math.floor(y1 * (input.height - 1)),
        right: Math.ceil(x2 * (input.width - 1)),
        bottom: Math.ceil(y2 * (input.height - 1)),
      };
      if (box.right <= box.left || box.bottom <= box.top) return;
      const result = await segmentBox(input.image, { width: input.width, height: input.height }, box);
      usage.push(result.usage);
      if (result.masks.length) {
        target.masks = result.masks;
        target.source = 'spark-box';
      }
    });
  }
  return { objects, usage };
}

export interface JudgeInput {
  request: string;
  prompt: string;
  before: string;
  candidates: { id: string; image: string; facts: string }[];
}

export interface Judgement {
  best: string;
  reason: string;
  ranking: { id: string; follows_request: number; plausible: number; note: string }[];
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    best: { type: 'string', description: 'id of the best candidate' },
    reason: { type: 'string', description: 'one sentence: why it is the best goal for the robots' },
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          follows_request: { type: 'integer', description: '0-10' },
          plausible: { type: 'integer', description: '0-10: a robot could produce exactly this' },
          note: { type: 'string' },
        },
        required: ['id', 'follows_request', 'plausible', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['best', 'reason', 'ranking'],
  additionalProperties: false,
};

export async function judge(input: JudgeInput): Promise<{ judgement: Judgement; usage: Usage[] }> {
  const content: InputContent[] = [
    {
      type: 'input_text',
      text: `A person asked: "${input.request}". An image model was told: "${input.prompt}".
The first image is the real photo (before). The others are candidate "after" photos that passed an automatic
check (every object still present and the same size). Pick the one that best fulfils the request as a goal
a robot can reach exactly: objects on the table, nothing floating, nothing new. Measured facts per candidate
come from segmentation and the 3D scan, trust them over your impression of distances.`,
    },
    { type: 'input_image', image_url: input.before },
  ];
  for (const candidate of input.candidates) {
    content.push({ type: 'input_text', text: `Candidate ${candidate.id}: ${candidate.facts}` });
    content.push({ type: 'input_image', image_url: candidate.image });
  }
  const { value, usage } = await sparkJson<Judgement>('ayna_judge', JUDGE_SCHEMA, content);
  if (!input.candidates.some((c) => c.id === value.best)) throw new MetaError('Muse Spark picked an unknown candidate', 502);
  return { judgement: value, usage: [usage] };
}

export interface PlanInput {
  request: string;
  moves: string[]; // one line per object to move: id, from, to, distance, rotation, size
  robots: string[]; // one line per robot and object: who reaches what, or why not
  facts: string[]; // e.g. "obj_2 target is 4 cm from obj_6's current spot"
}

export interface Plan {
  steps: { object: string; robot: string; why: string }[];
  refusals: { object: string; reason: string }[];
  order_reason: string;
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          object: { type: 'string' },
          robot: { type: 'string', description: 'robot id' },
          why: { type: 'string', description: 'why this robot and this position in the order, ≤ 15 words' },
        },
        required: ['object', 'robot', 'why'],
        additionalProperties: false,
      },
    },
    refusals: {
      type: 'array',
      items: {
        type: 'object',
        properties: { object: { type: 'string' }, reason: { type: 'string', description: 'honest, with the number that blocks it' } },
        required: ['object', 'reason'],
        additionalProperties: false,
      },
    },
    order_reason: { type: 'string', description: 'one sentence on the order' },
  },
  required: ['steps', 'refusals', 'order_reason'],
  additionalProperties: false,
};

export async function plan(input: PlanInput): Promise<{ plan: Plan; usage: Usage[] }> {
  const text = `You dispatch robots to rearrange a real table so it matches an approved "after" photo.
Request: "${input.request}"

Objects to move (world metres, z up; table plane):
${input.moves.join('\n')}

What each robot can do (computed from the scan; do not contradict it):
${input.robots.join('\n')}

Facts:
${input.facts.length ? input.facts.join('\n') : '- none'}

Order the moves so no object is put where another still stands (move the one standing there first), assign each move
to a robot that reaches BOTH the object and its target and whose gripper is wide enough, prefer the
stationary arm when both can, and refuse moves no robot can do with the blocking number in the reason.
Every object to move appears exactly once, in steps or in refusals; never refuse a move a robot can do just
because of the order, reorder instead. Write reasons for a person: name
objects by what they are (e.g. "white mouse"), never by id.`;
  const { value, usage } = await sparkJson<Plan>('ayna_plan', PLAN_SCHEMA, [{ type: 'input_text', text }]);
  return { plan: value, usage: [usage] };
}

export interface VerdictInput {
  request: string;
  after: string; // the approved imagined photo
  render: string; // the simulation rendered from the photo's camera
  results: string[]; // one line per object: error cm, IoU, status
  score: number;
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', description: 'two short sentences for the person, plain words, honest about misses' },
    matches_request: { type: 'boolean' },
  },
  required: ['verdict', 'matches_request'],
  additionalProperties: false,
};

export async function verdict(input: VerdictInput): Promise<{ verdict: { verdict: string; matches_request: boolean }; usage: Usage[] }> {
  const { value, usage } = await sparkJson<{ verdict: string; matches_request: boolean }>('ayna_verdict', VERDICT_SCHEMA, [
    {
      type: 'input_text',
      text: `Request: "${input.request}". Image 1 is the approved goal photo. Image 2 is the robots' result in the
physics twin, rendered from the same camera. Measured per object:\n${input.results.join('\n')}\nOverall score ${input.score}/100.
Say whether the result matches the goal and what is off, using the measurements.`,
    },
    { type: 'input_image', image_url: input.after },
    { type: 'input_image', image_url: input.render },
  ]);
  return { verdict: value, usage: [usage] };
}
