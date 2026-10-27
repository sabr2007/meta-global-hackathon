import './styles/tokens.css';
import './styles/app.css';

import * as THREE from 'three';
import { buildGeomLayer, GROUP, type GroupId } from './render/geoms';
import { loadObjects } from './render/objects';
import { loadRoomMesh } from './render/roomMesh';
import { createViewport } from './render/viewport';
import { BundleError, loadBundle, sceneIdFromUrl } from './scene/bundle';
import { createPhysics } from './sim/physics';
import { INITIAL_LAYERS, mountPanel, type LayerId } from './ui/panel';

const DEFAULT_SCENE = 'living-room';
const STATS_INTERVAL_MS = 250;
const OBJECTS_FRAME_MARGIN_M = 0.25; // context around scanned objects in the opening view

const LAYER_GROUPS: Partial<Record<LayerId, GroupId>> = {
  structure: GROUP.structure,
  furniture: GROUP.furniture,
  openings: GROUP.openings,
};

function showError(app: HTMLElement, error: unknown): void {
  const box = document.createElement('div');
  box.className = 'error';
  box.setAttribute('role', 'alert');
  const title = document.createElement('h1');
  title.textContent = 'Scene failed to load';
  const detail = document.createElement('p');
  detail.textContent = error instanceof Error ? error.message : String(error);
  const hint = document.createElement('p');
  hint.className = 'error__hint';
  hint.textContent =
    error instanceof BundleError
      ? 'Build a bundle first: cd pipeline && uv run scan2sim build <capture> --out ../web/public/scenes/<id>'
      : 'See the browser console for details.';
  box.append(title, detail, hint);
  app.replaceChildren(box);
  console.error(error);
}

async function start(app: HTMLElement): Promise<void> {
  const canvas = app.querySelector<HTMLCanvasElement>('canvas.viewport');
  if (!canvas) throw new Error('viewport canvas missing from index.html');

  const bundle = await loadBundle(sceneIdFromUrl(window.location.search, DEFAULT_SCENE));
  const viewport = createViewport(canvas);
  const [room, physics] = await Promise.all([
    loadRoomMesh(`${bundle.baseUrl}${bundle.meta.files.mesh}`),
    createPhysics(bundle.mjcf),
  ]);
  const geoms = buildGeomLayer(physics);
  const objects = await loadObjects(physics, bundle.baseUrl, bundle.meta.objects ?? []);
  viewport.scene.add(room.root, geoms.root, objects.root);
  // Open on the scanned objects when there are any: they are small next to the room.
  const objectBounds = new THREE.Box3().setFromObject(objects.root);
  viewport.frame(objectBounds.isEmpty() ? room.bounds() : objectBounds.expandByScalar(OBJECTS_FRAME_MARGIN_M));

  const setLayer = (layer: LayerId, visible: boolean): void => {
    if (layer === 'scan') room.setVisible(visible);
    else if (layer === 'ceiling') room.setCeilingVisible(visible);
    else if (layer === 'objects') objects.setVisible(visible);
    const group = LAYER_GROUPS[layer];
    if (group !== undefined) geoms.setGroupVisible(group, visible);
  };
  for (const [layer, visible] of Object.entries(INITIAL_LAYERS)) setLayer(layer as LayerId, visible);

  const sync = (): void => {
    geoms.sync();
    objects.sync();
  };
  const reset = (): void => {
    physics.reset();
    sync();
  };

  let playing = true;
  const panel = mountPanel(app, bundle.meta, {
    onLayerToggle: setLayer,
    onPlayToggle: () => {
      playing = !playing;
      panel.setPlaying(playing);
    },
    onReset: reset,
    onHover: (name) => {
      geoms.highlight(name);
      objects.highlight(name);
    },
  });
  panel.setPlaying(playing);

  if (import.meta.env.DEV) {
    Object.assign(window, { __scan2sim: { viewport, physics, geoms, objects, room } });
  }

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.code === 'Space') {
      event.preventDefault();
      playing = !playing;
      panel.setPlaying(playing);
    } else if (event.key === 'r') {
      reset();
    }
  });

  let last = performance.now();
  let statsAt = last;
  let simAtStats = physics.time();
  const frame = (now: number): void => {
    const elapsed = (now - last) / 1000;
    last = now;
    if (playing) {
      physics.advance(elapsed);
      sync();
    }
    if (now - statsAt >= STATS_INTERVAL_MS) {
      const wall = (now - statsAt) / 1000;
      const sim = physics.time() - simAtStats;
      panel.setStats({ time: physics.time(), realtime: playing ? Math.max(sim, 0) / wall : 0, contacts: physics.contactCount() });
      statsAt = now;
      simAtStats = physics.time();
    }
    viewport.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

const app = document.querySelector<HTMLElement>('#app');
if (app) {
  start(app).catch((error: unknown) => showError(app, error));
}
