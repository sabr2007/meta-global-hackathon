import '../styles/ayna.css';
import './app.css';

import { account, scans, type Session, type User } from '../ayna/client';
import { logo } from '../styles/logo';
import { loginPage, mirrorsPage } from './mirrors';
import { h } from './panel';
import { scanPage } from './scanPage';

// Routes (hash, so the static host needs no rewrites):
//   #/                      mirrors (the guest sees the demo mirror)
//   #/login                 sign in
//   #/scan/<owner>/<id>[/run/<run>]   one mirror; ?autoplay replays that run (or its best) in one take
//   ?autoplay alone         the demo mirror's featured run (AYNA_DEMO_RUN), for the video

const session: Session = { base: '' };
let user: User | null = null;
let teardown: (() => void) | null = null;

function header(): HTMLElement {
  const bar = h('header', 'topbar');
  const nav = h('nav', 'topbar__nav');
  nav.setAttribute('aria-label', 'Main');
  const mirrors = h('a', 'topbar__link', 'Mirrors');
  mirrors.href = '#/';
  nav.append(mirrors);
  if (user) {
    const out = h('button', 'pill pill--small pill--outline', 'Sign out');
    out.type = 'button';
    out.addEventListener('click', async () => {
      await account.logout(session);
      user = null;
      location.hash = '#/';
      render();
    });
    nav.append(h('span', 'topbar__user', user.email), out);
  } else {
    const signIn = h('a', 'pill pill--small pill--lime', 'Sign in');
    signIn.href = '#/login';
    nav.append(signIn);
  }
  bar.append(logo(20, '/'), nav);
  return bar;
}

function errorView(main: HTMLElement, error: unknown): void {
  const box = h('div', 'app-error card');
  box.setAttribute('role', 'alert');
  box.append(h('h1', 'title', 'Something went wrong'), h('p', '', error instanceof Error ? error.message : String(error)));
  const back = h('a', 'pill pill--outline', 'Back to mirrors');
  back.href = '#/';
  box.append(back);
  main.replaceChildren(box);
  console.error(error);
}

async function render(): Promise<void> {
  teardown?.();
  teardown = null;
  const app = document.querySelector<HTMLElement>('#app')!;
  const main = h('main', 'page');
  main.id = 'main';
  app.replaceChildren(header(), main);
  const route = location.hash.replace(/^#/, '') || '/';
  const autoplay = new URLSearchParams(location.search).has('autoplay');
  document.body.dataset.autoplay = autoplay ? 'running' : '';
  try {
    if (route === '/login') {
      loginPage(main, session, (signedIn) => {
        user = signedIn;
        location.hash = '#/';
      });
      return;
    }
    const scan = route.match(/^\/scan\/([a-f0-9]{12})\/([a-z0-9-]+)(?:\/run\/([a-z0-9-]+))?$/);
    if (scan) {
      teardown = await scanPage(main, session, scan[1], scan[2], { user, autoplay, runId: scan[3] });
      return;
    }
    if (autoplay) {
      // One take for the video: straight into the demo mirror.
      const { demo } = await scans.list(session);
      if (demo) {
        location.hash = `#/scan/${demo.owner}/${demo.id}${demo.run ? `/run/${demo.run}` : ''}`;
        return;
      }
    }
    await mirrorsPage(main, session, user);
  } catch (error) {
    errorView(main, error);
  }
}

window.addEventListener('hashchange', () => void render());
account
  .me(session)
  .then((me) => {
    user = me.user;
  })
  .catch(() => undefined)
  .finally(() => void render());
