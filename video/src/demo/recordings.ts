// Screen recordings for AynaDemo, by beat id (see script.ts). On recording day:
//   1. put the file in video/recordings/ (git-ignored), e.g. video/recordings/scan.mp4
//   2. import it here and add it to RECORDINGS:
//        import scan from '../../recordings/scan.mp4';
//        export const RECORDINGS: Recordings = { scan };
//   3. `npm run studio`, trim with the `trim` field if needed, then render AynaDemo.
// Until a beat has a recording, its slot says "screen recording goes here" and, where the beat has
// real material in AynaLoop, plays that underneath.

export interface Recording {
  src: string;
  trimStartSeconds?: number;
}

export type Recordings = Partial<Record<string, string | Recording>>;

export const RECORDINGS: Recordings = {};
