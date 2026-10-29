// A perception model for scripts/policies.ts, as a team would plug in their own:
//
//   npx tsx scripts/policies.ts --scan desk-sam3d --policy exact --perception scripts/perception-example.ts
//
// `locate` gets one scanned object (name, label, size, true start pose for reference only) and what the
// hero photo shows of it (the photo's camera and the object's SAM 3.1 mask), and returns where it thinks
// the object is on the table (world x, y in metres), or null to use the true pose. This one casts the
// mask's centre onto the plane through the object's middle, the same as the built-in `camera` policy.

import type { PhotoCamera } from '../src/ayna/camera';
import { placeOnPlane, type SceneObject } from '../src/ayna/goals';
import type { Rle } from '../src/ayna/rle';

export default {
  name: 'mask-centre',
  locate(object: SceneObject, photo: { camera: PhotoCamera; mask: Rle | null }): [number, number] | null {
    if (!photo.mask) return null;
    const centre = placeOnPlane(photo.camera, photo.mask, object.start[2]).center;
    return centre ? [centre[0], centre[1]] : null;
  },
};
