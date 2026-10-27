# Scan → World

Walk through a room with an iPhone, get a physics world a robot can train in.

A LiDAR capture becomes a MuJoCo scene that runs in the browser: the scanned room as the visual
layer, walls and furniture as colliders, every small object as its own physical body with a
full SAM 3D mesh, and a 7-DoF robot arm placed where it can reach them (next: properties, tasks
and success checks produced by Meta models).

## Status

| Step | What | State |
|---|---|---|
| 1 | Capture: RoomPlan boxes, LiDAR mesh, posed photos, depth (iPhone app, see below) | done |
| 2 | Parse the capture into one metric, +Z-up world frame | done |
| 3 | MuJoCo scene from RoomPlan (walls, furniture) + scan mesh, live in the browser | done |
| 4 | Object discovery from photos (structured output, SAM-ready noun phrases) | working: Muse Spark |
| 5 | Object masks, reviewed (renamed, fragments dropped), lifted to 3D with LiDAR depth | working: SAM 3.1 + Muse Spark |
| 6 | Full meshes for movable objects, placed and scaled by LiDAR, simulated as convex hulls | working: SAM 3D Objects |
| 7 | Robot arm placed on the scanned table; IK pick and place in the browser | working: our arm |
| 8 | Physical properties, task suites and code verifiers | planned: Muse Spark |
| 9 | Voice commands, scene variations, dataset export | planned: Voice Transcribe, Muse Image |

## Run it

```sh
# 1. Build a scene bundle from an exported capture (.zip or unpacked folder)
cd pipeline
uv sync
uv run scan2sim build ~/Downloads/Scan.zip --out ../web/public/scenes/living-room

# Optional: find and segment the objects on the largest table (needs META_API_KEY in .env)
uv run scan2sim perceive ~/Downloads/Scan.zip --out ../data/perception

# Or the whole object pipeline: the photo's objects become SAM 3D bodies on the scanned table,
# with the robot arm standing where it reaches them (--no-arm leaves it out)
# (needs META_API_KEY and FAL_KEY; --cache keeps the paid results so rebuilds are free)
uv run scan2sim objects ~/Downloads/Scan.zip --photo 0019 --cache ../data/cache/desk-0019 \
  --out ../web/public/scenes/desk

# 2. View it
cd ../web
npm install
npm run dev   # http://localhost:5190/?scene=living-room (or ?scene=desk)
```

In a scene with the arm, every scanned object in the panel has an action: **Pick**, then
**Put on** another object or **Put back**. The status line says what the arm is doing, or why it
can't (out of reach, wider than the gripper).

`scan2sim build` writes `scene.xml` (MJCF), `room_mesh.glb` (scan surfaces, ceiling as its own
node) and `scene.json` (element list, confidence, dimensions, frame transform), and compiles the
MJCF with MuJoCo before it exits. `scan2sim objects` adds `objects/<name>.glb` (one light mesh per
object, in its body frame), a convex-hull collider per object in the MJCF, and prints how well each
mesh fits its LiDAR points and how far it moves when the simulation starts.

Secrets live in `.env` at the repo root (see `.env.example`); it is git-ignored.

### How an object gets into the world

1. Muse Spark lists the objects in a photo; SAM 3.1 segments each one; Muse Spark reviews the crops.
2. LiDAR depth frames recorded around the photo give each mask its metric 3D points.
3. SAM 3D Objects (one request, one mask per object) returns a canonical mesh and a pose in the
   photo's camera. Its depth is monocular, so the whole object is scaled about the camera centre
   until it matches the LiDAR depth (this keeps its image unchanged). On our desk capture the
   factor was 0.85-0.88 for all objects and the placed meshes sit 3.5-12.5 mm from the LiDAR points.
4. Objects are lifted out of the RoomPlan table they rest on, decimated for the browser and given a
   convex-hull collider.

fal's pose conventions are not documented; `pipeline/src/scan2sim/placement.py` records the ones we
measured (quaternion order, frames) and `tests/test_placement.py` pins them.

### The robot arm

`pipeline/src/scan2sim/arm.py` generates a 7-DoF arm with a parallel gripper as MJCF. Its joint
layout and link lengths follow the published kinematics of the Franka Emika Panda (modified DH
table), so it has the reach of a well-studied research arm (top-down grasps from 0.28 to 0.76 m).
The geometry is built in code: each shell is the convex hull of rounded drums and boxes
(`arm_shapes.py`), which also makes it a valid MuJoCo collider. Joints are position-controlled
with gravity compensation; the fingers are coupled by a tendon, open to 11 cm and squeeze with
20 N.

- **Placement** (`mount.py`): candidate spots on the table that holds the objects (and pedestal
  spots around it) are scored by how many objects fall in the reach band, keeping clear of every
  object. On our desk the arm stands on the table and reaches 6 of 7 objects; the yellow cylinder
  is 0.77 m away.
- **Control** (`web/src/sim/armController.ts`, `ik.ts`): damped least-squares IK on the grip
  point (the same algorithm as `pipeline/src/scan2sim/ik.py`), top-down grasps across the
  object's narrowest side, smooth joint-space moves, and a check that the object really left the
  table.
- **Physics choices:** elliptic friction cones, a no-slip pass, several contact points per convex
  pair and rubber-like rolling friction on the pads keep rounded objects from creeping or rolling
  out of the grip. The arm collides with walls, tables and objects, but not with RoomPlan's
  furniture boxes, which are bounding boxes (a chair's includes the air around its backrest).

Tests: `cd pipeline && uv run pytest` (synthetic fixtures; no personal scans needed) and
`cd web && npm test` (runs the arm on a scene bundle if one is present, otherwise skips).

## Layout

```
pipeline/   Python (scan2sim): capture parser, frames, RoomPlan -> boxes, perception, LiDAR lifting,
            SAM 3D placement, MJCF + GLB export
web/        TypeScript: three.js viewer + official MuJoCo WebAssembly bindings
data/       local captures (git-ignored)
```

World frame: meters, +Z up, floor at z = 0, origin at the centre of the RoomPlan floor. The
capture app records ARKit space (+Y up); `scene.json` stores the ARKit -> world transform so
later steps (SAM masks lifted with depth) land in the same frame.

## Pre-existing work and dependencies

All code in this repository was written during the hackathon. Pre-existing tools and libraries:

- **Capture app:** [3D Model Anything](https://github.com/wesbos/3d-model-anything) (MIT), used as
  an external tool to record the room. Its code is not part of this repo; we read its
  `house-capture/5` export.
- **Models:** Muse Spark and SAM 3.1 via the Meta Model API; SAM 3D Objects (Meta, open weights)
  hosted by [fal](https://fal.ai/models/fal-ai/sam-3/3d-objects).
- **Robot reference:** the arm's kinematics (modified DH parameters, joint limits) are the
  published Franka Emika Panda values. No robot model files (Franka, MuJoCo Menagerie or other)
  are used; the shells, gripper, masses, controllers and IK are written here.
- **Simulation and rendering:** MuJoCo (Python `mujoco`, npm `@mujoco/mujoco`), three.js.
- **Python:** numpy, scipy, trimesh, fast-simplification, Pillow, httpx, openai (SDK for the OpenAI-compatible Meta Model API), meta-sam-parser (Meta's official SAM output parser), fal-client (fal's SDK), python-dotenv, pytest. **Web tooling:** Vite, TypeScript, Vitest.

## Privacy

Captures are photos and geometry of a real home. They stay local: `data/` and
`web/public/scenes/` are git-ignored.
