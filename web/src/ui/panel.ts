import type { Confidence, ElementInfo, ScannedObjectInfo, SceneMeta } from '../scene/bundle';

export type LayerId = 'scan' | 'objects' | 'ceiling' | 'structure' | 'furniture' | 'openings';

export interface PanelCallbacks {
  onLayerToggle(layer: LayerId, visible: boolean): void;
  onPlayToggle(): void;
  onReset(): void;
  onHover(name: string | null): void;
}

export interface SimStats {
  time: number;
  realtime: number;
  contacts: number;
}

export interface Panel {
  setStats(stats: SimStats): void;
  setPlaying(playing: boolean): void;
}

const LAYERS: { id: LayerId; label: string; initial: boolean }[] = [
  { id: 'scan', label: 'LiDAR scan', initial: true },
  { id: 'objects', label: 'Scanned objects', initial: true },
  { id: 'furniture', label: 'Furniture colliders', initial: true },
  { id: 'structure', label: 'Walls', initial: false },
  { id: 'openings', label: 'Windows & doors', initial: false },
  { id: 'ceiling', label: 'Ceiling', initial: false },
];

export const INITIAL_LAYERS: Record<LayerId, boolean> = Object.fromEntries(
  LAYERS.map((l) => [l.id, l.initial]),
) as Record<LayerId, boolean>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function humanize(camel: string): string {
  const spaced = camel.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatDims(e: ElementInfo): string {
  const { width, depth, height } = e.dimensions_m;
  return `${width.toFixed(2)} × ${depth.toFixed(2)} × ${height.toFixed(2)} m`;
}

function section(title: string, aside?: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('section', 'panel-section');
  const header = el('header', 'panel-section__header');
  header.append(el('h2', 'panel-section__title', title));
  if (aside) header.append(el('span', 'panel-section__aside', aside));
  const body = el('div', 'panel-section__body');
  root.append(header, body);
  return { root, body };
}

function sourceFacts(meta: SceneMeta): HTMLElement {
  const facts = el('dl', 'facts');
  const captured = new Date(meta.source.captured_at);
  const rows: [string, string][] = [
    ['Floor', `${meta.room.floor_m[0].toFixed(1)} × ${meta.room.floor_m[1].toFixed(1)} m`],
    ['Captured', Number.isNaN(captured.getTime()) ? '—' : captured.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })],
    ['Device', meta.source.device],
    ['Evidence', `${meta.source.photos} photos · ${meta.source.depth_frames} depth frames`],
  ];
  for (const [term, value] of rows) {
    facts.append(el('dt', undefined, term), el('dd', undefined, value));
  }
  return facts;
}

function layerToggles(callbacks: PanelCallbacks): HTMLElement {
  const list = el('div', 'toggles');
  for (const layer of LAYERS) {
    const label = el('label', 'toggle');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = layer.initial;
    input.addEventListener('change', () => callbacks.onLayerToggle(layer.id, input.checked));
    label.append(input, el('span', 'toggle__label', layer.label));
    list.append(label);
  }
  return list;
}

function hoverable(name: string, callbacks: PanelCallbacks): HTMLButtonElement {
  const button = el('button', 'object');
  button.type = 'button';
  const enter = (): void => callbacks.onHover(name);
  const leave = (): void => callbacks.onHover(null);
  button.addEventListener('pointerenter', enter);
  button.addEventListener('pointerleave', leave);
  button.addEventListener('focus', enter);
  button.addEventListener('blur', leave);
  return button;
}

function objectList(elements: ElementInfo[], callbacks: PanelCallbacks): HTMLElement {
  const list = el('ul', 'objects');
  for (const element of elements) {
    const item = el('li');
    const button = hoverable(element.name, callbacks);
    const pill = el('span', `pill pill--${element.confidence satisfies Confidence}`, element.confidence);
    button.append(
      el('span', 'object__category', humanize(element.category)),
      pill,
      el('span', 'object__name', element.name),
      el('span', 'object__dims', formatDims(element)),
    );
    item.append(button);
    list.append(item);
  }
  return list;
}

function scannedList(objects: ScannedObjectInfo[], callbacks: PanelCallbacks): HTMLElement {
  const list = el('ul', 'objects');
  for (const object of objects) {
    const item = el('li');
    const button = hoverable(object.name, callbacks);
    const size = object.size_m.map((v) => (v * 100).toFixed(1)).join(' × ');
    button.append(
      el('span', 'object__category', humanize(object.label)),
      el('span', 'pill pill--model', 'SAM 3D'),
      el('span', 'object__name', `LiDAR fit ${object.fit_error_mm.toFixed(1)} mm`),
      el('span', 'object__dims', `${size} cm`),
    );
    item.append(button);
    list.append(item);
  }
  return list;
}

export function mountPanel(container: HTMLElement, meta: SceneMeta, callbacks: PanelCallbacks): Panel {
  const panel = el('aside', 'panel');
  panel.setAttribute('aria-label', 'Scene controls');

  const masthead = el('header', 'masthead');
  masthead.append(
    el('p', 'masthead__kicker', 'Scan → World'),
    el('h1', 'masthead__title', humanize(meta.room.label ?? meta.source.room_name)),
    sourceFacts(meta),
  );

  const layers = section('Layers');
  layers.body.append(layerToggles(callbacks));

  const sim = section('Physics', 'MuJoCo');
  const controls = el('div', 'sim-controls');
  const play = el('button', 'button button--primary', 'Pause');
  play.type = 'button';
  play.addEventListener('click', () => callbacks.onPlayToggle());
  const reset = el('button', 'button', 'Drop again');
  reset.type = 'button';
  reset.addEventListener('click', () => callbacks.onReset());
  controls.append(play, reset);
  const stats = el('p', 'sim-stats', '—');
  stats.setAttribute('aria-live', 'off');
  sim.body.append(controls, stats);

  const scanned = meta.objects ?? [];
  const sections = [masthead, layers.root, sim.root];
  if (scanned.length > 0) {
    const objects = section('Scanned objects', `${scanned.length} · SAM 3D + LiDAR`);
    objects.body.append(scannedList(scanned, callbacks));
    sections.push(objects.root);
  }
  const furniture = meta.elements.filter((e) => e.kind === 'object');
  const things = section('Furniture', `${furniture.length} from RoomPlan`);
  things.body.append(objectList(furniture, callbacks));
  sections.push(things.root);

  panel.append(...sections);
  container.append(panel);

  return {
    setStats({ time, realtime, contacts }: SimStats): void {
      stats.textContent = `t ${time.toFixed(1)} s · ${realtime.toFixed(2)}× real time · ${contacts} contacts`;
    },
    setPlaying(playing: boolean): void {
      play.textContent = playing ? 'Pause' : 'Play';
      play.setAttribute('aria-pressed', String(!playing));
    },
  };
}
