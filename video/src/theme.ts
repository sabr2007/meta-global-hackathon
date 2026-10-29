// Ayna tokens, the same values as web/src/styles/ayna.css and the iOS app's AynaDesign.swift.
// Lime = done / verified / matches; orange = needs attention / refused / does not match.

export const C = {
  bg: '#1B1B1C',
  surface: '#252528',
  raised: '#3A3A3E',
  neutral: '#B5B5BA',
  text: '#FFFFFF',
  secondary: '#9A9AA0',
  reflection: '#55555A',
  lime: '#B8FF5E',
  onLime: '#173404',
  orange: '#EE7F35',
  limeSoft: 'rgba(184, 255, 94, 0.16)',
  orangeSoft: 'rgba(238, 127, 53, 0.18)',
  line: 'rgba(255, 255, 255, 0.10)',
} as const;

export const FONT = {
  title: 'Michroma, sans-serif',
  number: 'Doto, monospace',
  body: '-apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif',
} as const;

export const RADIUS = { card: 22, inner: 14 } as const;
