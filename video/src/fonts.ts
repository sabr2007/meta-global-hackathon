// The landing's own font files (Michroma for titles, Doto dot-matrix for numbers only).
import { loadFont } from '@remotion/fonts';
import dotoBlack from '../../web/src/styles/fonts/Doto-Black.woff2';
import michroma from '../../web/src/styles/fonts/Michroma-Regular.woff2';

export function loadAynaFonts(): Promise<unknown> {
  return Promise.all([
    loadFont({ family: 'Michroma', url: michroma, weight: '400' }),
    loadFont({ family: 'Doto', url: dotoBlack, weight: '900' }),
  ]);
}
