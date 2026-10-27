import * as THREE from 'three';

// The pipeline stores photo colours as sRGB bytes in COLOR_0, but glTF defines
// COLOR_0 as linear. Convert once so scanned surfaces do not look washed out.
export function linearizeVertexColors(geometry: THREE.BufferGeometry): void {
  const source = geometry.getAttribute('color');
  if (!source) return;
  const linear = new Float32Array(source.count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < source.count; i += 1) {
    color.setRGB(source.getX(i), source.getY(i), source.getZ(i), THREE.SRGBColorSpace);
    linear[i * 3] = color.r;
    linear[i * 3 + 1] = color.g;
    linear[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(linear, 3));
}
