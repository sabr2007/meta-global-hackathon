import type { MainModule, MjData, MjModel } from '@mujoco/mujoco';

// Never try to catch up more than this much wall-clock time in one frame
// (e.g. after the tab was in the background).
const MAX_FRAME_SECONDS = 1 / 20;

export interface Physics {
  readonly mujoco: MainModule;
  readonly model: MjModel;
  readonly data: MjData;
  /** Advance simulated time by up to `seconds` of wall-clock time, calling `control` before
   * every step. Returns steps taken. */
  advance(seconds: number, control?: () => void): number;
  reset(): void;
  time(): number;
  contactCount(): number;
  dispose(): void;
}

/** Physics for an already loaded MuJoCo module (tests load it themselves in Node). */
export function physicsFrom(mujoco: MainModule, mjcf: string): Physics {
  let model: MjModel;
  try {
    model = mujoco.MjModel.from_xml_string(mjcf);
  } catch (error) {
    throw new Error(`MuJoCo could not compile the scene: ${String(error)}`);
  }
  const data = new mujoco.MjData(model);
  // Keyframe 0 (when the scene has one) is the start state: arm at home, gripper open.
  const resetState = (): void => {
    if (model.nkey > 0) mujoco.mj_resetDataKeyframe(model, data, 0);
    else mujoco.mj_resetData(model, data);
    mujoco.mj_forward(model, data);
  };
  resetState();
  const timestep: number = model.opt.timestep;

  return {
    mujoco,
    model,
    data,
    advance(seconds: number, control?: () => void): number {
      const target = data.time + Math.min(seconds, MAX_FRAME_SECONDS);
      let steps = 0;
      while (data.time + timestep / 2 < target) {
        control?.();
        mujoco.mj_step(model, data);
        steps += 1;
      }
      return steps;
    },
    reset: resetState,
    time: () => data.time,
    contactCount: () => data.ncon,
    dispose(): void {
      data.delete();
      model.delete();
    },
  };
}
