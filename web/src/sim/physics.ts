import loadMujoco, { type MainModule, type MjData, type MjModel } from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';

// Never try to catch up more than this much wall-clock time in one frame
// (e.g. after the tab was in the background).
const MAX_FRAME_SECONDS = 1 / 20;

export interface Physics {
  readonly mujoco: MainModule;
  readonly model: MjModel;
  readonly data: MjData;
  /** Advance simulated time by up to `seconds` of wall-clock time. Returns steps taken. */
  advance(seconds: number): number;
  reset(): void;
  time(): number;
  contactCount(): number;
  dispose(): void;
}

let modulePromise: Promise<MainModule> | null = null;

function mujocoModule(): Promise<MainModule> {
  modulePromise ??= loadMujoco({ locateFile: () => wasmUrl });
  return modulePromise;
}

export async function createPhysics(mjcf: string): Promise<Physics> {
  const mujoco = await mujocoModule();
  let model: MjModel;
  try {
    model = mujoco.MjModel.from_xml_string(mjcf);
  } catch (error) {
    throw new Error(`MuJoCo could not compile the scene: ${String(error)}`);
  }
  const data = new mujoco.MjData(model);
  mujoco.mj_forward(model, data);
  const timestep: number = model.opt.timestep;

  return {
    mujoco,
    model,
    data,
    advance(seconds: number): number {
      const target = data.time + Math.min(seconds, MAX_FRAME_SECONDS);
      let steps = 0;
      while (data.time + timestep / 2 < target) {
        mujoco.mj_step(model, data);
        steps += 1;
      }
      return steps;
    },
    reset(): void {
      mujoco.mj_resetData(model, data);
      mujoco.mj_forward(model, data);
    },
    time: () => data.time,
    contactCount: () => data.ncon,
    dispose(): void {
      data.delete();
      model.delete();
    },
  };
}
