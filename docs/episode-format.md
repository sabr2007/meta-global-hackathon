# Evaluation episodes (`ayna/episode@1`)

Every saved run with an approved after photo exports as an evaluation episode for a goal-conditioned robot
policy: a real home's twin, the start state, the goal image a person approved, metric goals read off it, and
the success rule Ayna's own receipt uses. In the app: a run's receipt → **Export as an evaluation episode**
(or `GET /api/scans/<owner>/<scan>/runs/<run>/episode`).

```jsonc
{
  "format": "ayna/episode@1",
  "scan": "<owner>/<scan>",
  "run": "20261029-031253-lok1",
  "request": "Put all the small things together in one corner",
  "links_expire_at": "…",            // the file links below are signed; export again for fresh ones
  "scene": {                          // the twin, as built by scan2sim
    "scene.json": "…",                // hero camera (intrinsics + pose), objects (size, start pose), robots
    "scene.xml": "…",                 // MuJoCo model: room colliders, objects, robots
    "objects/<name>.glb": "…",        // SAM 3D mesh per object
    "hero.jpg": "…", "masks.json": "…", "room_mesh.glb": "…"
  },
  "start_image": "…",                 // the real photo
  "goal_image": "…",                  // the after photo the person approved
  "goals": [                          // one per scanned object, in the MuJoCo world frame
    { "object": "obj_2_white_mouse", "label": "white mouse", "moves": true,
      "position_m": [-1.26, 2.33, 0.80], "yaw_delta_rad": 0.0 }
  ],
  "success": {
    "position_tolerance_m": 0.03,
    "heading_tolerance_deg": 15,
    "score": "requested moves within tolerance / requested moves × objects left in place / objects that should stay"
  },
  "reference": {                      // how Ayna's own robots did on this episode
    "robots": "Ayna arm + mobile manipulator (MuJoCo)",
    "score": 100, "moved": { "done": 5, "asked": 5 }, "stayed": { "kept": 2, "total": 2 }, "median_error_cm": 0.4
  }
}
```

**Scoring a policy.** Load `scene.xml` in MuJoCo, let the policy act from the start state toward
`goal_image` (or toward `goals`, for a policy that takes metric targets), then compare each object's final
pose with its goal using `success`. `web/scripts/policies.ts` does exactly this for Ayna's own robots under
four kinds of perception, with the app's verifier (`web/src/ayna/verify.ts`), and is the place to plug in
another controller: `replay()` builds the twin, runs the plan and measures it.

**Scoring your own perception.** `--perception my-model.ts` loads a module whose default export has a
`name` and `locate(object, { camera, mask })`, returning where it thinks the object is on the table (world
x, y in metres). The robots then reach for that spot, and the run is scored like the built-in policies.
`web/scripts/perception-example.ts` is a working example (the mask centre, which reproduces the `camera`
row exactly):

```sh
cd web && npx tsx scripts/policies.ts --scan desk-sam3d --policy exact --perception scripts/perception-example.ts
```
