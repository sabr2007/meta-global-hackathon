// The 3-minute demo, beat by beat: section 8 of the project concept ("Video script draft, 180 s"),
// in English. Each beat has a slot for a screen recording; drop the files in on recording day
// (see recordings.ts) and the skeleton plays them in place. Times are in seconds.

export interface DemoBeat {
  id: string;
  from: number;
  to: number;
  title: string;
  shot: string; // what the picture shows
  says: string; // voice-over or on-screen text
  record: string; // what to capture for the slot
  loopFrom?: number; // seconds into AynaLoop to show real material while the slot is empty
}

export const DEMO_BEATS: DemoBeat[] = [
  {
    id: 'open',
    from: 0,
    to: 8,
    title: 'Show your robot the after',
    shot: 'A phone over a cluttered desk. Voice: "Tidy up my desk." The photo develops into the tidy version.',
    says: 'Title: Ayna — show your robot the after.',
    record: 'Phone over the real desk, saying the request; then the develop reveal in the app.',
    loopFrom: 17,
  },
  {
    id: 'problem',
    from: 8,
    to: 25,
    title: 'The problem',
    shot: 'Robots arriving in homes; a cluttered surface.',
    says: 'Robots are coming into homes, but "tidy up" hides a hundred decisions, and nobody wants a robot touching their things blindly.',
    record: 'B-roll of the desk; the landing page problem section.',
    loopFrom: 3,
  },
  {
    id: 'scan',
    from: 25,
    to: 55,
    title: 'Scan: the Ayna iPhone app',
    shot: 'LiDAR scan with the Ayna app, then the world assembling in the browser: SAM 3.1 masks, SAM 3D meshes dropping into physics.',
    says: 'Every object becomes a SAM 3D body in a MuJoCo twin of the table, fitted to its LiDAR points.',
    record: 'iPhone screen recording of a full scan + hero shot; browser recording of the twin loading.',
  },
  {
    id: 'imagine',
    from: 55,
    to: 85,
    title: 'Imagine and check the after',
    shot: 'Voice -> Muse Spark instruction on screen -> Muse Image draws the after. SAM outlines on both pictures; one rejected version ("the case is missing, redrawing").',
    says: 'Every object kept: the check that rejects a version when something vanishes, appears or changes size.',
    record: 'App run with a rejected version visible in the film strip, and the corrected redraw.',
    loopFrom: 11,
  },
  {
    id: 'approve',
    from: 85,
    to: 125,
    title: 'Approve, then the robots move',
    shot: 'Before/after slider, "Yes, do it". The camera flies out of the photo into 3D. The arm moves the objects. An honest refusal: an object wider than the gripper.',
    says: 'The after photo is the plan you approve before a robot touches anything.',
    record: 'App: slider, approve, camera fly-out, arm execution, refusal card.',
    loopFrom: 19,
  },
  {
    id: 'verify',
    from: 125,
    to: 150,
    title: 'Verify against the photo',
    shot: 'The camera returns to the photo pose; the simulation render lies over the imagined photo and the outlines converge.',
    says: 'Score per object in centimetres, the total; the eval table across runs and scenes.',
    record: 'App: verifier overlay and receipt; the eval table.',
    loopFrom: 31,
  },
  {
    id: 'why',
    from: 150,
    to: 170,
    title: 'Why it matters',
    shot: 'Landing page: who it is for, why now.',
    says: 'Every scan + after photo + check is an evaluation episode in a real home. Meta’s goal-conditioned planners (V-JEPA 2-AC, RoboJEPA) need a goal image; Ayna makes it from the owner’s photo and checks it.',
    record: 'Landing page scroll through "Who it is for" and "Why now".',
  },
  {
    id: 'close',
    from: 170,
    to: 180,
    title: 'Ayna',
    shot: 'Name, repository, built this week.',
    says: 'github.com/sabr2007/meta-global-hackathon',
    record: 'Logo card (rendered here).',
  },
];

export const DEMO_SECONDS = 180;
