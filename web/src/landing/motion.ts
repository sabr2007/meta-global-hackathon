// Everything that moves: the hero film, the before/after slider and reveal-on-scroll. Motion is
// transform, opacity and clip-path only; prefers-reduced-motion keeps the film still until asked.

const FILM_SRC = '/landing/ayna-loop.mp4';
const REVEAL_MARGIN = '0px 0px -8% 0px';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type IdleCallback = (task: () => void, options?: { timeout: number }) => number;

function whenIdle(task: () => void): void {
  const idle = (window as { requestIdleCallback?: IdleCallback }).requestIdleCallback;
  const run = () => (idle ? idle.call(window, task, { timeout: 2000 }) : window.setTimeout(task, 200));
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}

/** The poster paints first; the film loads only after the page has loaded and while it is on screen. */
export function setupFilm(startAt: number): void {
  const film = document.querySelector<HTMLElement>('.film');
  const video = film?.querySelector('video');
  const toggle = film?.querySelector<HTMLButtonElement>('.film__toggle');
  const label = toggle?.querySelector('.film__toggle-label');
  if (!film || !video || !toggle || !label) return;

  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  let wanted = !reducedMotion() && !connection?.saveData;
  let visible = false;
  let loaded = false;

  const render = () => {
    film.classList.toggle('is-playing', !video.paused && !video.ended);
    film.classList.toggle('is-wanted', wanted);
    label.textContent = wanted ? 'Pause the film' : 'Play the film';
  };

  const load = () => {
    if (loaded) return;
    loaded = true;
    video.addEventListener(
      'loadedmetadata',
      () => {
        if (Number.isFinite(video.duration) && startAt < video.duration) video.currentTime = startAt;
      },
      { once: true },
    );
    video.preload = 'auto';
    video.src = FILM_SRC;
  };

  const sync = () => {
    if (wanted && visible) {
      load();
      video.play().catch(() => {
        wanted = false;
        render();
      });
    } else if (!video.paused) {
      video.pause();
    }
    render();
  };

  for (const event of ['playing', 'pause', 'ended']) video.addEventListener(event, render);
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    wanted = !wanted;
    if (wanted) visible = true;
    sync();
  });
  render();

  whenIdle(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        sync();
      },
      { threshold: 0.35 },
    );
    observer.observe(film);
  });
}

/** Drag, click or use the arrow keys: the range input drives a clip-path and a transform. */
export function setupCompare(range: HTMLInputElement | null): void {
  const compare = range?.closest<HTMLElement>('.compare');
  if (!range || !compare) return;
  const apply = (value: number) => {
    compare.style.setProperty('--pos', `${value}%`);
    range.setAttribute('aria-valuetext', `${Math.round(value)}% before, ${Math.round(100 - value)}% after`);
  };
  range.addEventListener('input', () => {
    compare.classList.add('is-dragging');
    apply(Number(range.value));
  });
  range.addEventListener('change', () => compare.classList.remove('is-dragging'));
  range.addEventListener('pointerup', () => compare.classList.remove('is-dragging'));

  // the after photo develops in from the right the first time the comparison comes into view
  if (reducedMotion() || !('IntersectionObserver' in window)) {
    apply(Number(range.value));
    return;
  }
  compare.classList.add('is-dragging');
  apply(100);
  const observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      requestAnimationFrame(() => {
        compare.classList.remove('is-dragging');
        apply(Number(range.value));
      });
    },
    { threshold: 0.45 },
  );
  observer.observe(compare);
}

/** Things below the fold rise in once; anything already on screen at load is never hidden. */
export function setupReveal(): void {
  if (reducedMotion() || !('IntersectionObserver' in window)) return;
  const fold = window.innerHeight;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove('is-hidden');
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: REVEAL_MARGIN },
  );
  for (const el of document.querySelectorAll<HTMLElement>('[data-reveal]')) {
    if (el.getBoundingClientRect().top < fold) continue;
    el.classList.add('is-hidden');
    observer.observe(el);
  }
}
