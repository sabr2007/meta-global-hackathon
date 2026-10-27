"""Command line: scan2sim build | perceive | objects <capture.zip | capture dir> ..."""

from __future__ import annotations

import argparse
import asyncio
import dataclasses
import sys
from pathlib import Path

import mujoco
import numpy as np

from scan2sim.capture import Capture, extract_zip, load_capture
from scan2sim.export import write_bundle
from scan2sim.lidar_mesh import read_lidar_mesh
from scan2sim.lift import lift_masks
from scan2sim.meta_client import load_settings
from scan2sim.objects import body_name, build_scanned_object
from scan2sim.perceive import perceive_photo, write_perception
from scan2sim.scene import build_scene
from scan2sim.stages import sam3d_objects, verified_objects
from scan2sim.views import views_of

SETTLE_SECONDS = 2.0


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
    candidates = [b for b in scene.boxes if (b.name == element_name if element_name else b.category == "table")]
    if not candidates:
        raise ValueError(f"no element named {element_name!r}" if element_name else "room has no table")
    target = max(candidates, key=lambda b: b.half_size[0] * b.half_size[2])
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


def _settle_distances(mjcf: Path, bodies: list[str]) -> dict[str, float]:
    """How far each body moves in the first seconds: a few mm means it rests where it was scanned."""
    model = mujoco.MjModel.from_xml_path(str(mjcf))
    data = mujoco.MjData(model)
    mujoco.mj_forward(model, data)
    start = {name: data.body(name).xpos.copy() for name in bodies}
    for _ in range(int(SETTLE_SECONDS / model.opt.timestep)):
        mujoco.mj_step(model, data)
    return {name: float(np.linalg.norm(data.body(name).xpos - start[name])) for name in bodies}


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

    image, verified = asyncio.run(verified_objects(load_settings(), photo, cache))
    scene = build_scene(room.room, probe_count=0)
    lifted = {id(o.mask): o for o in lift_masks(capture, view, image, [v.mask for v in verified], scene.frame)}
    kept = [v for v in verified if id(v.mask) in lifted]
    reconstructions = asyncio.run(sam3d_objects(image, [v.mask for v in kept], cache))

    bodies = []
    for i, (obj, reconstruction) in enumerate(zip(kept, reconstructions)):
        if reconstruction is None:
            print(f"  {obj.label}: SAM 3D returned no mesh, skipped")
            continue
        bodies.append(
            build_scanned_object(
                body_name(i, obj.label), obj.label, reconstruction, lifted[id(obj.mask)].points_world,
                image, view, scene.frame, scene.boxes,
            )
        )
    scene = dataclasses.replace(scene, objects=tuple(bodies))
    paths = write_bundle(capture, room, scene, read_lidar_mesh(room.mesh_ply, room.mesh_colors), Path(args.out))
    moved = _settle_distances(paths.mjcf, [b.name for b in bodies])

    print(f"{photo.name}: {len(verified)} verified objects, {len(kept)} with LiDAR points, {len(bodies)} SAM 3D bodies")
    for b in bodies:
        size = " x ".join(f"{v * 100:.1f}" for v in b.size)
        print(
            f"  {b.label:<22} {size} cm  depth x{b.depth_scale:.2f}  "
            f"fit {b.fit_error_m * 1000:.1f} mm  moves {moved[b.name] * 100:.1f} cm in {SETTLE_SECONDS:.0f} s"
        )
    print(f"wrote {paths.mjcf.parent}")
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
    objects_cmd.set_defaults(handler=objects)

    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
