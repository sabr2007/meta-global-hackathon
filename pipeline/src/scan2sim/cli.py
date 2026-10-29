"""Command line: scan2sim build | perceive | objects <capture.zip | capture dir> ..., scan2sim report <bundle>"""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
import sys
from pathlib import Path

import mujoco
import numpy as np

from scan2sim import arm
from scan2sim.capture import Capture, extract_zip, load_capture
from scan2sim.export import write_bundle
from scan2sim.hero import upright_camera, write_hero
from scan2sim.lidar_mesh import read_lidar_mesh
from scan2sim.lift import lift_masks
from scan2sim.meta_client import load_settings
from scan2sim.mount import choose_mount, footprint, reachable
from scan2sim.objects import body_name, build_scanned_object, fit_top, rests_on, stand_under, target_surface
from scan2sim.perceive import perceive_photo, write_perception
from scan2sim.quality import SETTLE_SECONDS, format_table, report, rows_json, settle_drift
from scan2sim.scene import build_scene
from scan2sim.stages import sam3d_objects, verified_objects
from scan2sim.views import views_of


def _resolve_capture(source: Path, workdir: Path | None) -> Path:
    if source.is_dir():
        return source
    if source.suffix.lower() == ".zip":
        target = workdir or source.with_suffix("")
        return extract_zip(source, target)
    raise FileNotFoundError(f"{source} is neither a capture folder nor a .zip export")


def build(args: argparse.Namespace) -> int:
    capture = load_capture(_resolve_capture(Path(args.capture), Path(args.workdir) if args.workdir else None))
    rooms = {r.index: r for r in capture.rooms}
    if args.room not in rooms:
        print(f"room {args.room} not in capture (available: {sorted(rooms)})", file=sys.stderr)
        return 2
    room = rooms[args.room]
    scene = build_scene(room.room, probe_count=args.probes)
    mesh = read_lidar_mesh(room.mesh_ply, room.mesh_colors)
    paths = write_bundle(capture, room, scene, mesh, Path(args.out))

    # Fail fast if MuJoCo cannot compile what we wrote.
    model = mujoco.MjModel.from_xml_path(str(paths.mjcf))
    print(f"room '{room.name}' ({scene.room_label}): {len(scene.boxes)} elements, {len(scene.probes)} probes")
    print(f"mujoco: {model.ngeom} geoms, {model.nbody} bodies")
    print(f"wrote {paths.mjcf}, {paths.mesh} ({paths.mesh.stat().st_size / 1e6:.1f} MB), {paths.metadata}")
    return 0


def _photo_looking_at(capture: Capture, room_index: int, element_name: str | None) -> Path:
    """Most central photo of a RoomPlan element (default: the largest table top)."""
    room = next(r for r in capture.rooms if r.index == room_index)
    scene = build_scene(room.room, probe_count=0)
    target = target_surface(scene.boxes, element_name)
    if target is None:
        raise ValueError(f"no element named {element_name!r}" if element_name else "room has no table")
    top_center_world = np.array([target.center[0], target.center[1], target.top_z, 1.0])
    point_arkit = (np.linalg.inv(scene.frame.matrix) @ top_center_world)[:3]
    hits = views_of(point_arkit, capture.photos)
    if not hits:
        raise ValueError(f"no photo sees {target.name}")
    print(f"looking at {target.name}: {hits[0].view.image.name} ({hits[0].distance_m:.2f} m away)")
    return hits[0].view.image


def perceive(args: argparse.Namespace) -> int:
    capture = load_capture(_resolve_capture(Path(args.capture), None))
    photo = capture.root / "photos" / f"{args.photo}.jpg" if args.photo else _photo_looking_at(capture, args.room, args.look_at)
    if not photo.exists():
        print(f"photo not found: {photo}", file=sys.stderr)
        return 2
    perception = asyncio.run(perceive_photo(load_settings(), photo))
    overlay, summary = write_perception(perception, Path(args.out))
    print(f"Muse Spark found {len(perception.objects)} objects in {perception.timings_s['discovery']} s")
    for obj in perception.objects:
        found = sum(1 for m in perception.masks if m.concept == obj.concept)
        print(f"  {obj.concept:<24} expected {obj.count}, SAM 3.1 found {found}")
    print(f"SAM 3.1: {len(perception.masks)} masks in {perception.timings_s['segmentation']} s")
    print(f"wrote {overlay} and {summary}")
    return 0


def objects(args: argparse.Namespace) -> int:
    capture = load_capture(_resolve_capture(Path(args.capture), None))
    rooms = {r.index: r for r in capture.rooms}
    if args.room not in rooms:
        print(f"room {args.room} not in capture (available: {sorted(rooms)})", file=sys.stderr)
        return 2
    room = rooms[args.room]
    photo = capture.root / "photos" / f"{args.photo}.jpg" if args.photo else _photo_looking_at(capture, args.room, args.look_at)
    view = next((v for v in capture.photos if v.image == photo), None)
    if view is None:
        print(f"photo not found: {photo}", file=sys.stderr)
        return 2
    cache = Path(args.cache) if args.cache else None

    scene = build_scene(room.room, probe_count=0)
    surface = target_surface(scene.boxes, args.look_at)
    if args.look_at and surface is None:
        print(f"no element named {args.look_at!r} in room {args.room}", file=sys.stderr)
        return 2
    image, verified = asyncio.run(verified_objects(load_settings(), photo, cache))
    lifted = {id(o.mask): o for o in lift_masks(capture, view, image, [v.mask for v in verified], scene.frame)}
    # Keep only what lies on the scanned surface (not a shelf above it) before the paid SAM 3D call.
    kept = []
    for v in verified:
        o = lifted.get(id(v.mask))
        if o is None:
            continue
        if surface is not None and not rests_on(surface, o.center[:2], o.bottom_z):
            print(f"  {v.label}: not on {surface.name} (starts {o.bottom_z - surface.top_z:+.2f} m from its top), skipped")
            continue
        kept.append(v)
    if surface is not None and kept:
        # Objects rest on the real (LiDAR) surface; RoomPlan's box top sits a little above it.
        lidar_top = float(np.median([lifted[id(v.mask)].bottom_z for v in kept]))
        fitted = fit_top(surface, lidar_top)
        print(f"{surface.name}: RoomPlan top {surface.top_z:.3f} m, LiDAR surface {lidar_top:.3f} m, using {fitted.top_z:.3f} m")
        scene = dataclasses.replace(scene, boxes=tuple(fitted if b.name == surface.name else b for b in scene.boxes))
        surface = fitted
    reconstructions = asyncio.run(sam3d_objects(image, [v.mask for v in kept], cache))

    bodies = []
    masks = {}
    for i, (obj, reconstruction) in enumerate(zip(kept, reconstructions)):
        if reconstruction is None:
            print(f"  {obj.label}: SAM 3D returned no mesh, skipped")
            continue
        body = build_scanned_object(
            body_name(i, obj.label), obj.label, reconstruction, lifted[id(obj.mask)].points_world,
            image, view, scene.frame, scene.boxes,
        )
        bodies.append(dataclasses.replace(body, concept=obj.mask.concept))
        masks[body.name] = obj.mask
    if surface is not None:
        stands = [box for box in (stand_under(b, surface) for b in bodies) if box is not None]
        for box in stands:
            print(f"  {box.name}: {box.half_size[1] * 200:.1f} cm stand under it (not in the scan's objects)")
        scene = dataclasses.replace(scene, boxes=scene.boxes + tuple(stands))
    items = [footprint(b.name, b.position + b.hull_vertices) for b in bodies]
    mount = None if args.no_arm else choose_mount(scene.boxes, items)
    scene = dataclasses.replace(scene, objects=tuple(bodies), arm=mount)
    camera = upright_camera(view, image, scene.frame)
    concepts = {b.name: b.concept for b in bodies}
    paths = write_bundle(
        capture, room, scene, read_lidar_mesh(room.mesh_ply, room.mesh_colors), Path(args.out),
        hero=lambda out: write_hero(out, image, camera, scene.objects, masks, concepts),
    )
    moved = settle_drift(paths.mjcf, [b.name for b in bodies] + ([arm.LINK_NAMES[-1]] if mount else []))

    where = f" on {surface.name}" if surface is not None else ""
    print(
        f"{photo.name}: {len(verified)} verified objects, {len(lifted)} with LiDAR points, "
        f"{len(kept)}{where}, {len(bodies)} SAM 3D bodies"
    )
    for b in bodies:
        size = " x ".join(f"{v * 100:.1f}" for v in b.size)
        print(
            f"  {b.label:<22} {size} cm  depth x{b.depth_scale:.2f}  levelled {b.level_deg:.1f} deg  "
            f"fit {b.fit_error_m * 1000:.1f} mm  moves {moved[b.name] * 100:.1f} cm in {SETTLE_SECONDS:.0f} s"
        )
    if mount:
        where = f"on a {mount.pedestal_height:.2f} m pedestal by" if mount.pedestal_height else "on"
        print(
            f"arm {where} {mount.support} at ({mount.position[0]:.2f}, {mount.position[1]:.2f}), "
            f"reaches {len(reachable(mount, items))}/{len(items)} objects, "
            f"hand moves {moved[arm.LINK_NAMES[-1]] * 1000:.1f} mm in {SETTLE_SECONDS:.0f} s"
        )
    elif not args.no_arm:
        print("arm: no free spot within reach of the objects, left out")
    checks = json.loads(paths.metadata.read_text())["camera"]["alignment"]
    if checks:
        ious = [c["iou"] for c in checks.values()]
        offsets = [c["centroid_offset_px"] for c in checks.values()]
        print(
            f"photo camera vs placed meshes: mask IoU {min(ious):.2f}-{max(ious):.2f} (median {float(np.median(ious)):.2f}), "
            f"centroid offset median {float(np.median(offsets)):.1f} px"
        )
    print(f"wrote {paths.mjcf.parent}")
    return 0


def quality_report(args: argparse.Namespace) -> int:
    bundle = Path(args.bundle)
    if not (bundle / "scene.json").exists():
        print(f"not a scene bundle: {bundle}", file=sys.stderr)
        return 2
    if bool(args.capture) != bool(args.photo):
        print("--capture and --photo go together", file=sys.stderr)
        return 2
    capture = _resolve_capture(Path(args.capture), None) if args.capture else None
    rows = report(bundle, capture, args.photo)
    print(format_table(rows))
    if args.json:
        Path(args.json).write_text(rows_json(rows))
        print(f"wrote {args.json}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="scan2sim")
    commands = parser.add_subparsers(dest="command", required=True)
    build_cmd = commands.add_parser("build", help="capture -> MuJoCo scene bundle")
    build_cmd.add_argument("capture", help="exported .zip or unpacked capture folder")
    build_cmd.add_argument("--out", required=True, help="output bundle directory")
    build_cmd.add_argument("--room", type=int, default=0, help="room index inside the capture")
    build_cmd.add_argument("--probes", type=int, default=6, help="dynamic test objects to drop")
    build_cmd.add_argument("--workdir", help="where to unpack a .zip (default: next to it)")
    build_cmd.set_defaults(handler=build)

    perceive_cmd = commands.add_parser("perceive", help="Muse Spark + SAM 3.1 object discovery on a photo")
    perceive_cmd.add_argument("capture", help="exported .zip or unpacked capture folder")
    perceive_cmd.add_argument("--out", required=True, help="where to write the overlay and JSON")
    perceive_cmd.add_argument("--photo", help="photo stem, e.g. 0019 (default: best view of --look-at)")
    perceive_cmd.add_argument("--look-at", help="RoomPlan element name, e.g. table_0 (default: largest table)")
    perceive_cmd.add_argument("--room", type=int, default=0)
    perceive_cmd.set_defaults(handler=perceive)

    objects_cmd = commands.add_parser(
        "objects", help="scene with the photo's objects as SAM 3D bodies (Muse Spark, SAM 3.1, LiDAR, fal)"
    )
    objects_cmd.add_argument("capture", help="exported .zip or unpacked capture folder")
    objects_cmd.add_argument("--out", required=True, help="output bundle directory")
    objects_cmd.add_argument("--photo", help="photo stem, e.g. 0019 (default: best view of --look-at)")
    objects_cmd.add_argument("--look-at", help="RoomPlan element name, e.g. table_0 (default: largest table)")
    objects_cmd.add_argument("--room", type=int, default=0)
    objects_cmd.add_argument("--cache", help="keep paid results (masks, SAM 3D meshes) here and reuse them")
    objects_cmd.add_argument("--no-arm", action="store_true", help="leave the robot arm out of the scene")
    objects_cmd.set_defaults(handler=objects)

    report_cmd = commands.add_parser("report", help="per-object quality of a scene bundle against its capture")
    report_cmd.add_argument("bundle", help="bundle directory written by `scan2sim objects`")
    report_cmd.add_argument("--capture", help="the capture it was built from (adds the LiDAR fit and size columns)")
    report_cmd.add_argument("--photo", help="hero photo stem used for the bundle, e.g. 0019 (with --capture)")
    report_cmd.add_argument("--json", help="also write the rows to this JSON file")
    report_cmd.set_defaults(handler=quality_report)

    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
