// Picture helpers that work in the browser and in Node: size from the file header, data URLs.

function bytesOf(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (typeof atob === 'function') return Uint8Array.from(atob(base64.slice(0, 65536 - (65536 % 4))), (c) => c.charCodeAt(0));
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

/** Width and height of a JPEG, PNG or WebP data URL, read from its header. */
export async function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  const b = bytesOf(dataUrl);
  const u16 = (o: number): number => b[o] | (b[o + 1] << 8);
  const u24 = (o: number): number => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  if (b[0] === 0x89 && b[1] === 0x50) {
    const dv = new DataView(b.buffer, b.byteOffset);
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (b[0] === 0x52 && b[8] === 0x57) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8 ') return { width: u16(26) & 0x3fff, height: u16(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1 };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) break;
      const marker = b[o + 1];
      const length = (b[o + 2] << 8) | b[o + 3];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b[o + 5] << 8) | b[o + 6], width: (b[o + 7] << 8) | b[o + 8] };
      }
      o += 2 + length;
    }
  }
  throw new Error('unknown image format');
}
