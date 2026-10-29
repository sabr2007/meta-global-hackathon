# New work and pre-existing work

This file separates what was written during the hackathon (from October 26, 2026, 12:24 ET) from
the open-source code it builds on.

**In short:** `pipeline/`, `web/`, `docs/` and `video/` were written from scratch during the event.
The repository's first commit (ad1aa96, October 28, 03:07) holds the first day and a half of that work,
the scan-to-MuJoCo pipeline and its viewer, committed in one piece once it ran end to end; everything
after it is in small commits.
The only imported code is the iPhone capture engine in `ios/`, taken from the MIT-licensed
3D Model Anything app in one verbatim commit and changed since (details below). Libraries come
from package managers and are listed in the README.

## Scan to twin (`pipeline/`, Python, all new)

- Parsing the `house-capture/5` export (RoomPlan, LiDAR mesh, posed photos, depth) into one metric
  +Z-up world frame; RoomPlan walls and furniture as MuJoCo colliders.
- Object perception with Muse Spark (discovery, crop review, box grounding) and SAM 3.1 masks;
  LiDAR depth lifting; SAM 3D Objects meshes from fal, placed with conventions we measured
  (`placement.py`) and scaled to the LiDAR depth.
- The hero photo's pinhole camera in the world frame, the before masks, and a camera-alignment
  check (`hero.py`); the table top fitted to the LiDAR surface, stands under objects resting on
  unscanned trays, reduced colliders that never grow out of the mesh.
- Our robots: the 7-DoF arm (Panda modified-DH kinematics, our own shells, gripper and IK), the
  mobile manipulator (holonomic base, lift, wider gripper), the robot registry and placement
  (`arm.py`, `mobile.py`, `robots.py`, `mount.py`, `navgrid.py`).
- The scan quality report (`scan2sim report`).

## Ayna app and server (`web/`, TypeScript, all new)

- The loop shared by the browser and Node (`src/ayna/`): Spark's edit instruction, Muse Image
  versions, the SAM 3.1 conservation check, metric goals from masks, plan checking, execution,
  the verifier and the receipt; the headless eval (`scripts/eval.ts`) and the replay of saved runs
  as evaluation episodes for robot policies with different perception (`scripts/policies.ts`).
- The app (`src/app/`): mirrors, sign-in, the stage where the photo, the imagined photo and the
  twin share one camera, the develop effect, the before/after slider, the model timeline, robot
  placement with a live reach map, run history and replays, push-to-talk.
- Physics and robots in the browser (`src/sim/`, `src/render/`): MuJoCo WASM, IK, both robot
  controllers, A* navigation.
- The server (`server/`, `api/`): the Meta Model API proxy, accounts, per-user limits, private
  storage, iPhone pairing and uploads; the scan builder worker (`scripts/worker.ts`).
- The landing page and its Remotion video (`index.html`, `src/landing/`, `video/`).
- The design tokens follow the iOS app's `AynaDesign.swift` (both written during the hackathon).

## iOS scanner (`ios/`)

### Taken from upstream

The scanner starts from **3D Model Anything** by Wes Bos (MIT): `apps/house-capture` of
<https://github.com/wesbos/3d-model-anything> at commit `31b2dc9da3fb541e501f2f0936e55b32afb70ee8`.
The first commit that touches `ios/` (`chore: import 3D Model Anything house-capture (MIT)`)
copies it verbatim together with the upstream license (`ios/LICENSE-3d-model-anything`). The
upstream `data/` and `docs/images` files carry separate asset terms and are not included. To
see every change made since, run:

```sh
git diff 8bcd034 -- ios/
```

From upstream, kept as the engine of the app:

- **Capture engine** (`CaptureController`): one ARSession per capture with headless
  **RoomPlan** (walls, doors, windows, furniture boxes); LiDAR mesh and depth switched on inside
  RoomPlan's configuration; tracking recovery; white-balance lock; capture budgets under thermal
  or memory pressure; diagnostics.
- **Coverage scoring** (`CoverageEngine`): every LiDAR vertex is scored by how well the photos
  show it, the source of the photo-detail percentage and of the live mesh colours.
- **Automatic posed photos**: sharp frames kept where they add coverage, the full-resolution
  still path (`captureHighResolutionFrame`), the manual shutter, exact pose and intrinsics per photo.
- **Depth frames** (`DepthRecorder`): 256×192 Float16 depth, confidence and a 640×480 colour JPEG.
- **The bundle format** `house-capture/5` (`ScanBundle`: manifest, rooms, mesh PLY, photos,
  depth) and the single-room export and zip.
- **The 3D preview** (`PreviewScene`, `PreviewData`, `HouseViewer`, photo texturing and vertex
  colours), the house / zone / session model, relocalization, the importer, and the self-tests
  and autotests.

### Built during the hackathon

- **Rebrand to Ayna.** Bundle id `com.sabyrzhan.ayna`, target and folder `Ayna`, the
  `project.yml` for XcodeGen and the camera usage string. The Wes Bos privacy/support URLs and
  App Store release tooling are removed, and the offline help, privacy text and About screen
  are rewritten.
- **One scan = one mirror** (`MirrorLibrary`, `HomeScreen`, `MirrorScreen`). Home → New scan →
  Scan → Hero shot → Review → Share .zip. There is one implicit house. Every scan is a new
  session in its own tracking group, so it always starts fresh, never relocalizes, and has
  exactly one room. The multi-room house, areas, room history, Recently Deleted, doorway
  connection and relocalization screens are removed from the app; the model underneath stays.
- **Design system** (`AynaDesign`):
  - a dark graphite palette with lime for done and orange for needs attention;
  - Michroma for the logo and titles, Doto dot-matrix digits for numbers;
  - the mirrored AYNA logo, the overlapping-circle motif, pill buttons and rounded cards;
  - clay mesh thumbnails;
  - the app icon, generated by `ios/tools/make_app_icon.py`.
- **Scan screen** (`CaptureScreen`, `Coverage.CoverageMap`):
  - the live mesh in orange and lime at the existing `goodScore` threshold, with a short lime
    flash on triangles a new photo has just covered;
  - a round heading-up radar with rings, a sweeping beam, the camera's field of view, and
    walls and furniture as lime or orange dots;
  - a large Doto photo-detail percentage and photo count, RoomPlan coaching as pills, and a Done
    pill that turns lime when the scan reads complete;
  - a light haptic for every automatic photo;
  - an auto flow that starts the scan, finishes the session and opens the review.
- **Hero shot** (`HeroShotView`, hero section of `CaptureController`):
  - taken after Done, still in the same ARSession and before the room is finished, so its pose
    is in the scan's world frame;
  - a framing guide and a horizon level; it uses the existing full-resolution still path and
    falls back to the video frame;
  - saved as an ordinary posed photo with `"hero": true` in `photos.json`, with a depth frame at
    the same pose; Retake, Use it, Skip.
- **Review** (`MirrorScreen`): name and rename, the existing 3D preview, Doto counters for photos,
  depth frames and coverage, the hero shot, Send to Ayna and Share .zip (the existing export).
- **Send to Ayna** (`AynaServer`, `AynaUploader`, `SendToAyna`): uploads a mirror to the Ayna web
  app, which builds its twin.
  - pairing once per iPhone with the 6-character code from the web's Mirrors page; the token is
    kept in the Keychain, per server; a sheet to change the server (default
    `ayna-scan.vercel.app`) and unpair;
  - the Share .zip export, uploaded to the presigned URL the server hands out by a background
    `URLSession` that continues while the app is in the background or closed by iOS, then
    confirmed with `complete`; a confirmation the server missed is retried at the next launch;
  - the card shows idle → zipping → uploading NN% → queued, or the server's error with Retry;
    any 401 removes the token and asks to pair again;
  - the privacy manifest, privacy policy and in-app help now describe the upload.
- **Small, additive engine changes**:
  - `AnchorMesh.flash` (triangles one photo turned green);
  - `DepthRecorder.consider(force:)`;
  - `PhotoRecord.hero`;
  - `save` returns whether a write started;
  - automatic photos pause while framing the hero shot;
  - `CaptureController.restartMeshIfMissing`: restarts LiDAR reconstruction when RoomPlan's
    configuration lists the mesh but ARKit hands out no mesh anchors. On device, the first
    enable right after the automatic scan start produced none in both test scans.

  The bundle format is unchanged apart from the optional `hero` field. The saved PLY colours are
  unchanged.
- **Docs and tools**: `ios/README.md`, `ios/BUILD_NOTES.md`, `ios/tools/make_doto_static.py`
  (static Doto instances via fontTools), `ios/tools/make_app_icon.py` (Pillow).

### Third-party assets

- **Michroma** (Copyright 2011 The Michroma Project Authors) and **Doto** (Copyright 2024 The
  Doto Project Authors), from <https://github.com/google/fonts> (`ofl/michroma`, `ofl/doto`),
  SIL Open Font License 1.1. The licenses ship next to the fonts in `ios/Ayna/Fonts/`. The two
  Doto files are static instances generated from the variable font: `ROND=100`, `wght=700/900`.
