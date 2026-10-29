// Minimal reader for the object meshes scan2sim writes (one binary glTF mesh per object, body frame):
// positions and triangle indices, enough to draw a silhouette without WebGL.

export interface TriangleMesh {
  positions: Float32Array; // x, y, z per vertex
  indices: Uint32Array; // three per triangle
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const FLOAT = 5126;
const COMPONENT_ARRAYS: Record<number, (buffer: ArrayBuffer, offset: number, length: number) => ArrayLike<number>> = {
  5121: (b, o, n) => new Uint8Array(b, o, n),
  5123: (b, o, n) => new Uint16Array(b, o, n),
  5125: (b, o, n) => new Uint32Array(b, o, n),
};

interface Accessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
}

export function parseGlb(buffer: ArrayBuffer): TriangleMesh {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a binary glTF file');
  let offset = 12;
  let json: { accessors: Accessor[]; bufferViews: { byteOffset?: number; byteLength: number }[]; meshes: { primitives: { attributes: { POSITION: number }; indices?: number }[] }[] } | null = null;
  let bin: ArrayBuffer | null = null;
  while (offset < view.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)));
    else if (type === CHUNK_BIN) bin = buffer.slice(start, start + length);
    offset = start + length;
  }
  if (!json || !bin) throw new Error('glTF file without JSON or binary chunk');
  const primitive = json.meshes[0].primitives[0];
  const read = (index: number): { accessor: Accessor; offset: number } => {
    const accessor = json!.accessors[index];
    const bufferView = json!.bufferViews[accessor.bufferView];
    return { accessor, offset: (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0) };
  };
  const position = read(primitive.attributes.POSITION);
  if (position.accessor.componentType !== FLOAT || position.accessor.type !== 'VEC3') throw new Error('unsupported POSITION layout');
  const positions = new Float32Array(bin.slice(position.offset, position.offset + position.accessor.count * 12));
  let indices: Uint32Array;
  if (primitive.indices === undefined) {
    indices = Uint32Array.from({ length: position.accessor.count }, (_, i) => i);
  } else {
    const index = read(primitive.indices);
    const make = COMPONENT_ARRAYS[index.accessor.componentType];
    if (!make) throw new Error('unsupported index type');
    const bytes = index.accessor.componentType === 5121 ? 1 : index.accessor.componentType === 5123 ? 2 : 4;
    indices = Uint32Array.from(make(bin.slice(index.offset, index.offset + index.accessor.count * bytes), 0, index.accessor.count));
  }
  return { positions, indices };
}
