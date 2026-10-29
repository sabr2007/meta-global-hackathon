// "Mirrors": every scan, open to everyone, the featured one large; signed in, also pairing the iPhone scanner.

import { account, scans, type ScanCard, type Session, type User } from '../ayna/client';
import { h } from './panel';

const STATUS_TEXT: Record<ScanCard['status'], string> = {
  queued: 'Waiting for the builder',
  processing: 'Building the twin',
  ready: 'Ready',
  failed: 'Failed',
};

async function heroUrl(session: Session, scan: ScanCard): Promise<string | null> {
  if (scan.status !== 'ready') return null;
  const { files } = await scans.open(session, scan.owner, scan.id);
  return files['hero.jpg'] ?? null;
}

function figures(scan: ScanCard): HTMLElement {
  const row = h('dl', 'mirror__figures');
  for (const [value, label] of [
    [scan.objects, 'objects'],
    [scan.robots || 1, scan.robots > 1 ? 'robots' : 'robot'],
    [scan.runs ?? 0, scan.runs === 1 ? 'run' : 'runs'],
  ] as const) {
    const item = h('div', 'metric');
    item.append(h('dd', 'num', String(value)), h('dt', 'eyebrow', label));
    row.append(item);
  }
  return row;
}

function statusTag(scan: ScanCard): HTMLElement {
  const tone = scan.status === 'ready' ? 'tag--lime' : scan.status === 'failed' ? 'tag--orange' : '';
  return h('span', `tag ${tone}`, scan.error ? `${STATUS_TEXT[scan.status]} · ${scan.error}` : STATUS_TEXT[scan.status]);
}

function pairingPanel(session: Session): HTMLElement {
  const panel = h('section', 'pairing card');
  panel.setAttribute('aria-labelledby', 'pair-title');
  const title = h('h2', 'title pairing__title', 'Scan a new mirror');
  title.id = 'pair-title';
  const text = h('p', 'pairing__text', 'Record a table with the Ayna iPhone app, then tap “Send to Ayna” and enter this code. The twin is built on our scan worker and appears here.');
  const code = h('p', 'num pairing__code', '······');
  code.setAttribute('aria-live', 'polite');
  const button = h('button', 'pill pill--outline', 'Show a pairing code');
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const pair = await account.pairCode(session);
      code.textContent = pair.code;
      button.textContent = `Valid until ${new Date(pair.expires).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    } catch (error) {
      code.textContent = '—';
      button.textContent = error instanceof Error ? error.message : 'Could not make a code';
      button.disabled = false;
    }
  });
  panel.append(h('span', 'eyebrow', 'iPhone · LiDAR'), title, text, code, button);
  return panel;
}

export async function mirrorsPage(root: HTMLElement, session: Session, user: User | null): Promise<void> {
  const { scans: list } = await scans.list(session);
  const page = h('section', 'mirrors');
  page.setAttribute('aria-labelledby', 'mirrors-title');
  const intro = h('header', 'mirrors__intro');
  const title = h('h1', 'title mirrors__title', 'Mirrors');
  title.id = 'mirrors-title';
  const lede = 'Each mirror is a real table scanned with an iPhone, and its physics twin. Open one, say what it should look like, and watch the robots try.';
  intro.append(
    h('span', 'eyebrow', user ? `${user.email}` : 'Scanned with an iPhone · open to everyone'),
    title,
    h('p', 'mirrors__lede', user ? lede : `${lede} Replays are free; live runs call Meta models, five a day for each visitor.`),
  );
  page.append(intro);
  if (!list.length) {
    page.append(h('p', 'mirrors__empty', 'No mirrors yet.'));
  }
  const [first, ...rest] = list;
  if (first) {
    const feature = h('a', 'mirror mirror--feature card');
    feature.href = `#/scan/${first.owner}/${first.id}`;
    const media = h('div', 'mirror__media');
    const body = h('div', 'mirror__body');
    body.append(h('span', 'eyebrow', new Date(first.created).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })), h('h2', 'title mirror__name', first.name), statusTag(first), figures(first), h('span', 'pill pill--lime mirror__open', first.status === 'ready' ? 'Open the mirror' : 'Not ready yet'));
    feature.append(media, body);
    page.append(feature);
    void heroUrl(session, first).then((url) => {
      if (!url) return;
      const img = h('img');
      img.src = url;
      img.alt = `Hero photo of ${first.name}`;
      media.append(img);
    });
  }
  if (rest.length) {
    const strip = h('div', 'mirrors__strip');
    for (const scan of rest) {
      const card = h('a', 'mirror mirror--small card');
      card.href = `#/scan/${scan.owner}/${scan.id}`;
      const media = h('div', 'mirror__media');
      const body = h('div', 'mirror__body');
      body.append(h('h2', 'title mirror__name', scan.name), statusTag(scan), figures(scan));
      card.append(media, body);
      strip.append(card);
      void heroUrl(session, scan).then((url) => {
        if (!url) return;
        const img = h('img');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        media.append(img);
      });
    }
    page.append(strip);
  }
  if (user) page.append(pairingPanel(session));
  root.replaceChildren(page);
}

export function loginPage(root: HTMLElement, session: Session, onSignedIn: (user: User) => void): void {
  const page = h('section', 'login');
  const form = h('form', 'login__form card');
  form.setAttribute('aria-labelledby', 'login-title');
  const title = h('h1', 'title login__title', 'Sign in');
  title.id = 'login-title';
  const email = h('input', 'field');
  Object.assign(email, { type: 'email', name: 'email', autocomplete: 'username', required: true, placeholder: 'Email' });
  email.setAttribute('aria-label', 'Email');
  const password = h('input', 'field');
  Object.assign(password, { type: 'password', name: 'password', autocomplete: 'current-password', required: true, placeholder: 'Password' });
  password.setAttribute('aria-label', 'Password');
  const error = h('p', 'login__error');
  error.setAttribute('role', 'alert');
  const submit = h('button', 'pill pill--lime', 'Sign in');
  submit.type = 'submit';
  form.append(h('span', 'eyebrow', 'For pairing the iPhone scanner'), title, email, password, error, submit, h('p', 'login__note', 'Every mirror, its replays and live runs are open without an account.'));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = '';
    try {
      const { user } = await account.login(session, email.value, password.value);
      onSignedIn(user);
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : 'Sign in failed';
      submit.disabled = false;
    }
  });
  page.append(form);
  root.replaceChildren(page);
  email.focus();
}
