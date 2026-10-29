// Browser entry for MuJoCo: Vite serves the .wasm file and hands us its URL.
// (Kept apart from physics.ts so Node scripts and tests can use physicsFrom without Vite.)

import loadMujoco, { type MainModule } from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';
import { physicsFrom, type Physics } from './physics';

let modulePromise: Promise<MainModule> | null = null;

export function mujocoModule(): Promise<MainModule> {
  modulePromise ??= loadMujoco({ locateFile: () => wasmUrl });
  return modulePromise;
}

export async function createPhysics(mjcf: string): Promise<Physics> {
  return physicsFrom(await mujocoModule(), mjcf);
}
