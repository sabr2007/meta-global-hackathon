# Eval log

Every round of the night's evaluation, as it ran: the full loop against the deployed app with live Meta
models, robots in MuJoCo and the app's verifier (`web/scripts/eval.ts`, one JSON line per run). Failures
stay in the tables; under each round is what it taught us and what changed before the next one. The
final round is the one the README and the landing quote.

Harness: `web/scripts/eval.ts` — live Meta models through the deployed API (https://ayna-brown.vercel.app),
robots in MuJoCo (WASM, in Node), the app's own verifier. 3 versions of the after photo per round, at most
2 rounds. An object matches when it rests within 3 cm of its goal (15° for elongated objects); the score
is the share of the scene's objects that match, so refusals and failed grasps count as misses.

How the measure changed along the way: v1–v2 scored the share of matching objects; from v3 the score is
requested moves done × objects left in place (so a refused or failed move always costs points); from v6
the median error is over the requested moves only; from v8 a move Spark declined before drawing the
edit counts as asked and refused. After v8 a run has up to three rounds, and Muse Spark decides between
them.

## Eval v1 — production, one stationary arm, before fixes (07:13–07:25)

| # | Scene | Request | Approved after? | Rejected versions | Failed steps | Refused | Score (matching) | Median error, cm | Time, s | Cost, $ |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | desk-sam3d | Tidy up the table | yes | 4/6 | 0 | 1 | 86 (6/7) | 0.1 | 92 | 0.134 |
| 2 | desk-sam3d | Make room for a laptop in the middle of the table | yes | 2/3 | 0 | 3 | 57 (4/7) | 0.2 | 51 | 0.059 |
| 3 | desk-sam3d | Put the small things together in one group | yes | 2/3 | 0 | 3 | 57 (4/7) | 0.4 | 55 | 0.060 |
| 4 | desk-sam3d | Move everything a bit closer to me | no, all rejected | 5/5 | - | - | - | - | 66 | 0.100 |
| 5 | desk-sam3d | Spoken in Russian: “tidy up the table” | yes | 5/6 | 1 | 1 | 43 (3/7) | 3.1 | 109 | 0.114 |
| 6 | mirror02-sam3d | Tidy up the table | no, all rejected | 6/6 | - | - | - | - | 63 | 0.092 |
| 7 | mirror02-sam3d | Make room for a laptop in the middle of the table | yes | 2/3 | 1 | 4 | 17 (1/6) | 25.2 | 58 | 0.059 |
| 8 | mirror02-sam3d | Put the small things together in one group | yes | 2/3 | 1 | 0 | 83 (5/6) | 0.3 | 48 | 0.056 |
| 9 | mirror02-sam3d | Move everything a bit closer to me | yes | 2/3 | 1 | 1 | 50 (3/6) | 9.4 | 48 | 0.059 |
| 10 | mirror02-sam3d | Spoken in Russian: “tidy up the table” | yes | 0/3 | 1 | 1 | 50 (3/6) | 7.0 | 57 | 0.077 |

- Runs with an approved after photo: **8/10**; versions rejected by the SAM 3.1 check: **30/41**.
- Mean score over finished runs: **55/100**; median of per-run median errors: **1.76 cm**; runs where every object matches: **0/10**.
- Requested moves that ended within 3 cm of the goal: **17/38**; failed robot steps: **5**; refusals: **14**.
- Total cost: **$0.81**, mean time per run **65 s**.

Where the points went (each miss carries its reason in the run record):
- refusals: Muse Image puts objects where the single stationary arm cannot reach (closer than 0.28 m or
  past 0.76 m), and two objects are wider than the 11 cm gripper (yellow cylinder, plastic bottle);
- over-cautious planning: footprints projected from masks were too large, so Spark refused reachable
  moves as "blocked";
- slipping grasps on the 1.2 cm pen and the tall pink perfume bottle;
- mirror-02 physics: the clear plastic bottle tips over by itself (LiDAR sees through it).
Objects the robots actually moved landed 0.0–0.4 cm from their goals.

## Eval v2 — production, arm + mobile manipulator, honest score, second pass (bundles from before the scan-quality fixes)

| # | Scene | Request | Approved after? | Rejected versions | Failed steps | Refused | Score (matching) | Median error, cm | Time, s | Cost, $ |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | desk-sam3d | Tidy up the table | no | 6/6 | - | - | - | - | 81 | 0.096 |
| 2 | desk-sam3d | Clear the front half of the table | yes | 1/3 | 0 | 1 | 80 (6/7) | 0.3 | 65 | 0.080 |
| 3 | desk-sam3d | Put all the small things together in one corner | no | 6/6 | - | - | - | - | 73 | 0.103 |
| 4 | desk-sam3d | Line the small objects up along the back edge | yes | 2/3 | 4 | 1 | 40 (4/7) | 1.3 | 64 | 0.075 |
| 5 | desk-sam3d | Spoken in Russian: “tidy up the table” | yes | 4/6 | 8 | 0 | 33 (3/7) | 8.0 | 117 | 0.125 |
| 6 | mirror02-sam3d | Tidy up the table | no | 1/3 | - | - | 33 (2/6) | 11.8 | 98 | 0.085 |
| 7 | mirror02-sam3d | Clear the front half of the table | no | 6/6 | - | - | - | - | 73 | 0.106 |
| 8 | mirror02-sam3d | Put all the small things together in one corner | no | 6/6 | - | - | - | - | 97 | 0.095 |
| 9 | mirror02-sam3d | Line the small objects up along the back edge | no | 6/6 | - | - | - | - | 81 | 0.097 |
| 10 | mirror02-sam3d | Spoken in Russian: “tidy up the table” | no | 2/3 | - | - | 60 (4/6) | 1.1 | 49 | 0.057 |

- Runs with an approved after photo: **3/10**; versions rejected by the SAM 3.1 check: **40/48**.
- Mean score over finished runs: **51/100**; median of per-run median errors: **1.31 cm**; runs where every object matches: **0/10**.
- Requested moves that ended within 3 cm of the goal: **8/16**; failed robot steps: **12**; refusals: **2**.
- Total cost: **$0.92**, mean time per run **80 s**.

What v2 taught us (all fixed before v3):
- the mobile manipulator kept holding an object after a refused placement (table edge, too close to a
  chair), so every later step failed with "Holding …: put it down first" — robots now put the object
  back, and the mobile robot's target check includes the surface test, so such moves are refused or
  given to the arm when the plan is made;
- the second pass re-ran placements that had been refused, doubling the failures — it now retries only
  objects a robot moved or dropped;
- one run hit production before the verdict endpoint accepted runs without a render (fixed and
  redeployed);
- the earbud case is segmented by the scan's phrase "white mouse": when an edited photo showed fewer
  white instances, the case looked missing — objects sharing a phrase are now boxed by Spark by their
  own label; the size band was calibrated to ±20% (SAM alone varies ±8% on the unedited photo).

## Eval v3 — final bundles (scan-quality fixes), stopped after 6 runs to fix placement refusals

| # | Scene | Request | Approved after? | Rejected versions | Failed steps | Refused | Score (matching) | Median error, cm | Time, s | Cost, $ |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | desk-sam3d | Tidy up the table | yes | 1/3 | 0 | 1 | 80 (6/7) | 0.2 | 66 | 0.098 |
| 2 | desk-sam3d | Clear the front half of the table | yes | 1/3 | 4 | 1 | 17 (2/7) | 8.5 | 71 | 0.102 |
| 3 | desk-sam3d | Put all the small things together in one corner | yes | 2/3 | 2 | 1 | 40 (4/7) | 0.6 | 64 | 0.074 |
| 4 | desk-sam3d | Line the small objects up along the back edge | yes | 4/6 | 2 | 1 | 10 (2/7) | 6.8 | 139 | 0.160 |
| 5 | desk-sam3d | Move the yellow cylinder to the front right corner of the table | yes | 0/3 | 0 | 1 | 0 (6/7) | 0.0 | 45 | 0.077 |
| 6 | desk-sam3d | tidy up my desk desk and put the mouse next to the keyboard. | yes | 0/3 | 0 | 1 | 0 (6/7) | 0.0 | 65 | 0.081 |

- Runs with an approved after photo: **6/6**; versions rejected by the SAM 3.1 check: **8/21**.
- Mean score over finished runs: **24/100**; median of per-run median errors: **0.41 cm**; runs where every object matches: **0/6**.
- Requested moves that ended within 3 cm of the goal: **8/23**; failed robot steps: **8**; refusals: **6**.
- Total cost: **$0.59**, mean time per run **75 s**.

What v3 taught us (fixed before v4): both robots refused goals whose footprint rim touched a neighbour
(goals like "group the small things" put objects close together) or sat 1–3 cm past the arm's 0.76 m
band; Spark sometimes gave the mobile robot moves the arm could do. Now the arm takes every move it
can, both robots check half the footprint, and the arm reaches 2 cm past its comfortable band (as the
original controller did).

## Eval v4 — arm-first dispatch and relaxed placement checks (stopped after the 6 desk runs to add the edge nudge)

| # | Scene | Request | Approved after? | Rejected versions | Failed steps | Refused | Score (matching) | Median error, cm | Time, s | Cost, $ |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | desk-sam3d | Tidy up the table | yes | 1/3 | 1 | 1 | 67 (5/7) | 0.8 | 79 | 0.085 |
| 2 | desk-sam3d | Clear the front half of the table | yes | 2/3 | 0 | 2 | 67 (5/7) | 0.3 | 76 | 0.085 |
| 3 | desk-sam3d | Put all the small things together in one corner | yes | 1/3 | 1 | 0 | 60 (5/7) | 1.5 | 59 | 0.089 |
| 4 | desk-sam3d | Line the small objects up along the back edge | yes | 2/3 | 0 | 5 | 0 (2/7) | 12.6 | 65 | 0.084 |
| 5 | desk-sam3d | Move the yellow cylinder to the front right corner of the table | yes | 0/3 | 1 | 0 | 0 (6/7) | 0.0 | 46 | 0.077 |
| 6 | desk-sam3d | tidy up my desk and put the mouse next to the keyboard. | yes | 0/3 | 1 | 0 | 80 (6/7) | 0.3 | 64 | 0.085 |

- Runs with an approved after photo: **6/6**; versions rejected by the SAM 3.1 check: **6/18**.
- Mean score over finished runs: **46/100**; median of per-run median errors: **0.54 cm**; runs where every object matches: **0/6**.
- Requested moves that ended within 3 cm of the goal: **15/28**; failed robot steps: **4**; refusals: **8**.
- Total cost: **$0.50**, mean time per run **65 s**.

What v4 taught us: the two remaining failed steps were goals a centimetre or two past the table's front
edge ("at the edge of table_0"); goals are now nudged onto the nearest valid spot within 6 cm, and the
receipt still measures against the original goal. The "back edge" request scores 0 honestly: every
target on the back edge is out of the arm's reach and the mobile robot cannot park behind the desk.

## Eval v5 — scan quality fixes, honest score, second pass, voice EN/RU (desk before the feasibility check; second table after it)

| # | Scene | Request | Approved after? | Rejected versions | Failed steps | Refused | Score (matching) | Median error, cm | Time, s | Cost, $ |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | desk-sam3d | Tidy up the table | yes | 2/3 | 0 | 1 | 83 (6/7) | 0.1 | 68 | 0.076 |
| 2 | desk-sam3d | Clear the front half of the table | yes | 4/6 | 1 | 0 | 75 (6/7) | 0.2 | 116 | 0.146 |
| 3 | desk-sam3d | Put all the small things together in one corner | yes | 4/6 | 0 | 0 | 100 (7/7) | 0.4 | 93 | 0.149 |
| 4 | desk-sam3d | Line the small objects up along the back edge | yes | 1/3 | 0 | 1 | 40 (4/7) | 1.7 | 84 | 0.111 |
| 5 | desk-sam3d | Move the yellow cylinder to the front right corner of the table | yes | 0/3 | 1 | 0 | 0 (6/7) | 0.0 | 52 | 0.076 |
| 6 | desk-sam3d | tidy up my desk and put the mouse next to the keyboard.. | yes | 2/3 | 0 | 0 | 100 (7/7) | 0.1 | 73 | 0.082 |
| 7 | desk-sam3d | Spoken in Russian: “tidy up the table and put the mouse next to the keyboard” | yes | 2/3 | 0 | 0 | 100 (7/7) | 0.1 | 59 | 0.068 |
| 8 | mirror02-sam3d | Tidy up the table | yes | 5/6 | 0 | 0 | 100 (6/6) | 0.7 | 81 | 0.115 |
| 9 | mirror02-sam3d | Clear the front half of the table | no, all rejected | 5/5 | - | - | - | - | 82 | 0.113 |
| 10 | mirror02-sam3d | Put all the small things together in one corner | no, all rejected | 6/6 | - | - | - | - | 105 | 0.102 |
| 11 | mirror02-sam3d | Line the small objects up along the back edge | no, all rejected | 6/6 | - | - | - | - | 80 | 0.107 |
| 12 | mirror02-sam3d | Spoken in Russian: “gather the pen, the spoon and the calculator on one side of the table” | yes | 6/6 | 1 | 1 | 33 (4/6) | 21.7 | 105 | 0.112 |

- Runs with an approved after photo: **9/12**; versions rejected by the SAM 3.1 check: **43/56**.
- Mean score over finished runs: **70/100**; median of per-run median errors: **0.17 cm**; runs where every object matches: **4/12**.
- Requested moves that ended within 3 cm of the goal: **28/36**; failed robot steps: **3**; refusals: **3**.
- Total cost: **$1.26**, mean time per run **83 s**.

What v5 taught us: on the desk the quality fixes and the honest score held up (three runs at 100; the
five-move "one corner" run is now the landing's showcase). The low desk scores were goals no robot
could reach (a back-edge target 0.79 m from the arm, a corner past the table edge that the mobile robot
tried to put on the floor); the hard feasibility check (from run 8 on) now rejects such versions
before any robot moves, and run 12 shows its fallback (every version had an impossible move, so the one
with the fewest went ahead and the receipt counts the refusal). On the second table 3 of 5 requests
ended with every version rejected, mostly "black calculator changed size" after a move to the back of
the table: the size check corrected only for distance, while a flat object further back is also seen
at a lower angle and the lens stretches the image towards its edges, so faithful moves read ×0.8–1.3,
as wide as the whole ±20% band. The check now projects each object's box through the photo's camera at
the old and the new spot (within 5% of the rasterized silhouette in the unit test).

## Eval v6 — projected-box size check, feasibility as a hard check, median over requested moves

| # | Scene | Request | Approved after? | Rejected versions | Failed steps | Refused | Score (matching) | Median error, cm | Time, s | Cost, $ |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | desk-sam3d | Tidy up the table | yes | 2/3 | 1 | 0 | 83 (6/7) | 1.0 | 64 | 0.081 |
| 2 | desk-sam3d | Clear the front half of the table | yes | 6/6 | 1 | 0 | 80 (6/7) | 0.3 | 118 | 0.133 |
| 3 | desk-sam3d | Put all the small things together in one corner | yes | 2/3 | 0 | 0 | 100 (7/7) | 0.9 | 48 | 0.073 |
| 4 | desk-sam3d | Line the small objects up along the back edge | yes | 3/6 | 0 | 0 | 100 (7/7) | 0.8 | 94 | 0.142 |
| 5 | desk-sam3d | Move the yellow cylinder to the front right corner of the table | yes | 1/3 | 1 | 0 | 0 (6/7) | 52.1 | 45 | 0.071 |
| 6 | desk-sam3d | Tidy up my desk and put the mouse next to the keyboard. | yes | 5/6 | 0 | 1 | 0 (6/7) | 17.3 | 105 | 0.111 |
| 7 | desk-sam3d | A request spoken in Russian | yes | 2/3 | 2 | 1 | 60 (5/7) | 0.2 | 82 | 0.100 |
| 8 | mirror02-sam3d | Tidy up the table | yes | 6/6 | 1 | 1 | 50 (4/6) | 4.4 | 89 | 0.110 |
| 9 | mirror02-sam3d | Clear the front half of the table | yes | 6/6 | 0 | 1 | 0 (5/6) | 55.5 | 85 | 0.111 |
| 10 | mirror02-sam3d | Put all the small things together in one corner | yes | 6/6 | 2 | 2 | 0 (0/6) | 9.1 | 114 | 0.120 |
| 11 | mirror02-sam3d | Line the small objects up along the back edge | yes | 6/6 | 0 | 5 | 0 (1/6) | 34.3 | 82 | 0.113 |
| 12 | mirror02-sam3d | A request spoken in Russian | yes | 2/3 | 1 | 0 | 33 (4/6) | 4.6 | 68 | 0.065 |

- Runs with an approved after photo: **12/12**; versions rejected by the SAM 3.1 check: **47/57**.
- Mean score over finished runs: **42/100**; median of per-run median errors: **4.50 cm**; runs where every object matches: **2/12**.
- Requested moves that ended within 3 cm of the goal: **23/44**; failed robot steps: **9**; refusals: **11**.
- Total cost: **$1.23**, mean time per run **83 s**.

What v6 taught us: the projected-box size check held on the desk (the "back edge" request went from
40 and 0 to 100, and "one corner" scored 100 again), but four kinds of failure were left, each fixed
before v7. (1) A corner goal past the desk edge passed the feasibility check, which tested the body
origin on any surface, then failed at the floor: the check now tests where the gripped footprint
lands, on the object's own surface, and a goal that needs more than 2 cm of nudging makes the version
infeasible so it is redrawn. (2) Spark refused a mouse move as overlapping the keyboard although the
version had passed the landing check (run 6 scored 0): Spark's refusals are now checked, and a move a
robot can do is kept. (3) The mobile robot dropped the 27 cm keyboard on every drive: it now refuses
long thin objects with that reason. (4) On Mirror 02 a RoomPlan wall shelf hangs over the back of the
desk; the surface query, cast from 3 m, found the shelf's top, so every goal under it read as off the
desk (runs 8–11 fell back to versions with impossible moves): surface queries for a put-down now start
30 cm above the object's own surface.

## Robot policies on the saved episodes (desk, 37 episodes, no model calls)

`web/scripts/policies.ts` replays every saved desk run with an approved after photo as an evaluation
episode: same robots, same deterministic plan, different perception of where each object is when the
robot reaches for it; scored by the app's verifier.

| Policy | Episodes | Requested moves done | Objects left in place | Mean score | Median error of moved objects, cm | Slipped grasps |
|---|---|---|---|---|---|---|
| exact (simulator poses) | 37 | 106/148 | 110/111 | 70 | 0.7 | 0 |
| camera (SAM 3.1 mask centres on the photo) | 37 | 105/148 | 110/111 | 70 | 0.8 | 0 |
| noise-1cm | 37 | 99/148 | 110/111 | 67 | 1.6 | 3 |
| noise-2cm | 37 | 64/148 | 110/111 | 44 | 4.7 | 30 |

What it shows: what the hero photo alone tells the robots (mask centres cast onto the table) is as
good as the simulator's exact poses on this desk, and the scripted top-down grasp tolerates about 1 cm
of error; at 2 cm it loses 40% of the moves, mostly to grasps that slip.

## Eval v7 — landing-point feasibility on the object's own surface, Spark's refusals checked, carry rule, shelf-aware surfaces

| # | Scene | Request | Approved after? | Rejected versions | Failed steps | Refused | Score (matching) | Median error, cm | Time, s | Cost, $ |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | desk-sam3d | Tidy up the table | yes | 6/6 | 0 | 0 | 100 (7/7) | 0.1 | 116 | 0.141 |
| 2 | desk-sam3d | Clear the front half of the table | yes | 2/3 | 0 | 0 | 60 (5/7) | 1.5 | 65 | 0.073 |
| 3 | desk-sam3d | Put all the small things together in one corner | yes | 0/3 | 0 | 0 | 100 (7/7) | 0.9 | 70 | 0.085 |
| 4 | desk-sam3d | Line the small objects up along the back edge | yes | 6/6 | 0 | 1 | 60 (5/7) | 1.7 | 124 | 0.142 |
| 5 | desk-sam3d | Move the yellow cylinder to the front right corner of the table | yes | 6/6 | 0 | 1 | 0 (6/7) | 51.4 | 60 | 0.097 |
| 6 | desk-sam3d | tidy up my my desk and put the mouse next to the keyboard.. | yes | 2/3 | 0 | 0 | 100 (7/7) | 0.2 | 57 | 0.080 |
| 7 | desk-sam3d | Spoken in Russian: “tidy up the table and put the mouse next to the keyboard” | yes | 2/3 | 0 | 0 | 100 (7/7) | 0.1 | 55 | 0.075 |
| 8 | mirror02-sam3d | Tidy up the table | yes | 2/3 | 1 | 0 | 38 (4/6) | 0.2 | 59 | 0.059 |
| 9 | mirror02-sam3d | Clear the front half of the table | yes | 6/6 | 0 | 1 | 75 (5/6) | 0.2 | 109 | 0.128 |
| 10 | mirror02-sam3d | Put all the small things together in one corner | yes | 6/6 | 2 | 1 | 25 (3/6) | 35.9 | 114 | 0.125 |
| 11 | mirror02-sam3d | Line the small objects up along the back edge | yes | 5/6 | 2 | 0 | 0 (2/6) | 5.4 | 93 | 0.122 |
| 12 | mirror02-sam3d | A request spoken in Russian | yes | 6/6 | 2 | 1 | 33 (4/6) | 42.1 | 103 | 0.110 |

- Runs with an approved after photo: **12/12**; versions rejected by the SAM 3.1 check: **49/57**.
- Mean score over finished runs: **58/100**; median of per-run median errors: **1.20 cm**; runs where every object matches: **4/12**.
- Requested moves that ended within 3 cm of the goal: **36/50**; failed robot steps: **7**; refusals: **5**.
- Total cost: **$1.24**, mean time per run **85 s**.

What v7 taught us: the desk held at 74 on average (three 100s), and the second table recovered from v6
once goals under its wall shelf counted as on the desk (75 and 38 instead of 0s). What was left there is
physical: objects carried under the shelf sometimes fall (the shelf's RoomPlan box hangs over the desk),
a pen slips from the gripper. And one honesty bug, found by the third judge: when Spark declined a move
before drawing the edit ("no robot can reach the back edge, stays in place"), the receipt did not count
it as asked, so a run could read 3 of 3 and 100. From v8 on, those moves count as asked and refused.

## Eval v8 — the final code: moves refused before the edit count as asked, tidy transcripts, snapshot store from run 3 on

| # | Scene | Request | Approved after? | Rejected versions | Failed steps | Refused | Score (matching) | Median error, cm | Time, s | Cost, $ |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | desk-sam3d | Tidy up the table | yes | 5/6 | 0 | 0 | 71 (5/7) | 0.2 | 102 | 0.129 |
| 2 | desk-sam3d | Clear the front half of the table | yes | 2/3 | 0 | 0 | 80 (6/7) | 1.1 | 73 | 0.087 |
| 3 | desk-sam3d | Put all the small things together in one corner | yes | 0/3 | 0 | 0 | 83 (6/7) | 0.2 | 64 | 0.099 |
| 4 | desk-sam3d | Line the small objects up along the back edge | yes | 2/3 | 0 | 0 | 100 (7/7) | 0.3 | 59 | 0.082 |
| 5 | desk-sam3d | Move the yellow cylinder to the front right corner of the table | yes | 2/3 | 0 | 0 | 100 (7/7) | 0.8 | 34 | 0.059 |
| 6 | desk-sam3d | tidy up my desk and put the mouse next to the keyboard. | yes | 2/3 | 0 | 0 | 100 (7/7) | 0.8 | 61 | 0.068 |
| 7 | desk-sam3d | A request spoken in Russian | yes | 2/3 | 0 | 0 | 100 (7/7) | 0.2 | 45 | 0.068 |
| 8 | mirror02-sam3d | Tidy up the table | yes | 3/6 | 0 | 0 | 50 (5/6) | 0.1 | 87 | 0.134 |
| 9 | mirror02-sam3d | Clear the front half of the table | yes | 0/3 | 0 | 0 | 80 (5/6) | 0.6 | 45 | 0.083 |
| 10 | mirror02-sam3d | Put all the small things together in one corner | yes | 4/5 | 0 | 0 | 50 (5/6) | 0.1 | 102 | 0.124 |
| 11 | mirror02-sam3d | Line the small objects up along the back edge | yes | 6/6 | 1 | 0 | 0 (3/6) | 1.7 | 76 | 0.116 |
| 12 | mirror02-sam3d | A request spoken in Russian | yes | 1/3 | 1 | 0 | 67 (5/6) | 0.3 | 60 | 0.080 |

- Runs with an approved after photo: **12/12**; versions rejected by the SAM 3.1 check: **29/47**.
- Mean score over finished runs: **73/100**; median of per-run median errors: **0.26 cm**; runs where every object matches: **4/12**.
- Requested moves that ended within 3 cm of the goal: **43/50**; failed robot steps: **2**; refusals: **0**.
- Total cost: **$1.13**, mean time per run **67 s**.

What v8 shows: the desk at 91 on average (five 100s, including the front-right-corner request that
scored 0 in every earlier round: the feasibility check now makes the editor redraw a corner the robots
can reach), with every refused move counted. The second table is still the hard one (50, 80, 50, 0, 67):
moves are done, but an object that should stay gets nudged. During this round production lost its Blob
store (the free plan's operations quota) and moved to the snapshot store after run 2; the loop itself did
not change.

A note on v8's "refusals: 0": the log counted refusals in the robots' plans only. Moves Spark left out of
the edit before drawing (no robot could do them) were counted as asked and not done in the score, but were
not listed in the log until after v8 (`refusedBeforeEdit` in later lines).

After v8, one more step went in: when every version of a round is rejected, Muse Spark decides what to do
next (redraw with its own note to the editor, narrow the request, or stop) instead of a fixed second
round. Verified live once on the desk ("Line the small objects up along the back edge", run ...-ekwl):
round 1's three versions all shrank the mouse; Spark: "Draw again: The moved mouse and figurine were
shrunk too small, so I will have the editor redraw them at their correct size"; version 2b passed.
