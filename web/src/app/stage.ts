// The stage: the real photo, the imagined photo and the 3D twin stacked in one frame, aligned
// pixel for pixel (the twin's camera is the photo's camera). Contours, the develop effect and the
// before/after slider are drawn here.

import { outline, type Rle } from '../ayna/rle';

export type InkStyle = 'found' | 'ghost' | 'match' | 'miss';
export type StageMode = 'photo' | 'twin';

const INK: Record<InkStyle, { color: string; size: number; step: number }> = {
  found: { color: 'rgba(255,255,255,0.9)', size: 1.6, step: 5 },
  ghost: { color: 'rgba(255,255,255,0.75)', size: 1.3, step: 9 },
  match: { color: '#b8ff5e', size: 2, step: 4 },
  miss: { color: '#ee7f35', size: 2, step: 4 },
};
const DEVELOP_MS = 2600;

export interface InkLayer {
  key: string;
  rle: Rle;
  style: InkStyle;
  label?: string;
}

export interface Stage {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement; // the twin renders here
  setMode(mode: StageMode): void;
  setCaption(text: string, tone?: 'lime' | 'orange' | null): void;
  showAfter(url: string | null, develop?: boolean): Promise<void>;
  setSlider(enabled: boolean): void;
  setInk(layers: InkLayer[]): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

export function createStage(photoUrl: string, size: { width: number; height: number }): Stage {
  const root = el('figure', 'stage');
  root.style.setProperty('--photo-aspect', `${size.width} / ${size.height}`);
  root.style.setProperty('--photo-ratio', String(size.width / size.height));
  const canvas = el('canvas', 'stage__twin', { 'aria-label': 'Physics twin of the scanned table' });
  const before = el('img', 'stage__photo stage__before', { alt: 'The real photo of the table', src: photoUrl, width: String(size.width), height: String(size.height) });
  const after = el('img', 'stage__photo stage__after', { alt: 'The imagined after photo', width: String(size.width), height: String(size.height) });
  const ink = el('canvas', 'stage__ink', { 'aria-hidden': 'true' });
  const slider = el('div', 'stage__slider', { role: 'slider', tabindex: '0', 'aria-label': 'Before and after', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '50' });
  slider.innerHTML = '<span class="stage__handle" aria-hidden="true"></span>';
  const caption = el('figcaption', 'stage__caption');
  root.append(canvas, before, after, ink, slider, caption);

  let layers: InkLayer[] = [];
  let split = 50;

  const rect = (): { x: number; y: number; width: number; height: number } => {
    const w = root.clientWidth;
    const h = root.clientHeight;
    const scale = Math.min(w / size.width, h / size.height);
    return { x: (w - size.width * scale) / 2, y: (h - size.height * scale) / 2, width: size.width * scale, height: size.height * scale };
  };

  const drawInk = (): void => {
    const ratio = Math.min(window.devicePixelRatio, 2);
    ink.width = Math.round(root.clientWidth * ratio);
    ink.height = Math.round(root.clientHeight * ratio);
    const context = ink.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, root.clientWidth, root.clientHeight);
    const r = rect();
    const sx = r.width / size.width;
    const sy = r.height / size.height;
    for (const layer of layers) {
      const style = INK[layer.style];
      context.fillStyle = style.color;
      for (const [x, y] of outline(layer.rle, style.step)) {
        context.beginPath();
        context.arc(r.x + x * sx, r.y + y * sy, style.size, 0, Math.PI * 2);
        context.fill();
      }
      if (layer.label) {
        const top = r.y + layer.rle.y * sy;
        const left = r.x + (layer.rle.x + layer.rle.w / 2) * sx;
        context.font = '600 11px ui-sans-serif, system-ui, sans-serif';
        context.textAlign = 'center';
        context.fillText(layer.label, left, Math.max(12, top - 6));
      }
    }
  };

  const applySplit = (value: number): void => {
    split = Math.min(100, Math.max(0, value));
    root.style.setProperty('--split', `${split}%`);
    slider.setAttribute('aria-valuenow', String(Math.round(split)));
  };
  applySplit(50);

  const fromPointer = (event: PointerEvent): void => {
    const box = root.getBoundingClientRect();
    applySplit(((event.clientX - box.left) / box.width) * 100);
  };
  slider.addEventListener('pointerdown', (event) => {
    slider.setPointerCapture(event.pointerId);
    fromPointer(event);
  });
  slider.addEventListener('pointermove', (event) => {
    if (slider.hasPointerCapture(event.pointerId)) fromPointer(event);
  });
  slider.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') applySplit(split - 5);
    else if (event.key === 'ArrowRight') applySplit(split + 5);
    else if (event.key === 'Home') applySplit(0);
    else if (event.key === 'End') applySplit(100);
    else return;
    event.preventDefault();
  });

  new ResizeObserver(drawInk).observe(root);

  return {
    root,
    canvas,
    setMode(mode) {
      root.dataset.mode = mode;
    },
    setCaption(text, tone = null) {
      caption.textContent = text;
      caption.dataset.tone = tone ?? '';
    },
    async showAfter(url, develop = true) {
      if (!url) {
        root.classList.remove('stage--after', 'stage--developing');
        return;
      }
      after.src = url;
      await after.decode().catch(() => undefined);
      root.classList.add('stage--after');
      if (!develop || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      root.classList.remove('stage--developing');
      void root.offsetWidth; // restart the animation
      root.classList.add('stage--developing');
      await new Promise((resolve) => setTimeout(resolve, DEVELOP_MS));
      root.classList.remove('stage--developing');
    },
    setSlider(enabled) {
      root.classList.toggle('stage--slider', enabled);
      if (enabled) applySplit(50);
    },
    setInk(next) {
      layers = next;
      drawInk();
    },
  };
}
