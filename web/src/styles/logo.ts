// The AYNA logo for the web, as in the iOS app: the word in Michroma over its mirror in Doto dots.
// Each dotted letter sits under its solid one (column widths = Michroma advances, in em).

const LETTERS: [string, number][] = [
  ['A', 1.062],
  ['Y', 1.062],
  ['N', 1.133],
  ['A', 1.062],
];

export function logo(size = 22, href: string | null = '/'): HTMLElement {
  const root = document.createElement(href ? 'a' : 'span');
  root.className = 'logo';
  root.style.setProperty('--size', `${size}px`);
  if (href && root instanceof HTMLAnchorElement) root.href = href;
  root.setAttribute('aria-label', 'Ayna');
  for (const kind of ['solid', 'mirror'] as const) {
    const row = document.createElement('span');
    row.className = `logo__row logo__${kind}`;
    row.setAttribute('aria-hidden', 'true');
    for (const [letter, width] of LETTERS) {
      const cell = document.createElement('span');
      cell.textContent = letter;
      cell.style.width = `${width * size}px`;
      row.append(cell);
    }
    root.append(row);
  }
  return root;
}
