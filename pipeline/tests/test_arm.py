import dataclasses
import xml.etree.ElementTree as ET

import mujoco
import numpy as np
import pytest
import trimesh

from fixtures import TABLE_H, room_document
from scan2sim import arm
from scan2sim.ik import ArmIk, top_down
from scan2sim.mjcf import FURNITURE_CONTYPE, scene_to_mjcf
from scan2sim.mount import BASE_RADIUS, OBJECT_CLEARANCE, REACH_MAX, REACH_MIN, choose_mount, footprint, reachable
from scan2sim.roomplan import parse_room
from scan2sim.scene import ScannedObject, build_scene

BOX_HALF = np.array([0.025, 0.03, 0.025])
CUP_SIZE = np.array([0.07, 0.06, 0.09])


def _arm_world(box_at: np.ndarray | None = None) -> mujoco.MjModel:
    """The arm alone at the origin on a floor, optionally with a small box to grasp."""
    root = ET.Element("mujoco")
    ET.SubElement(root, "compiler", angle="radian", autolimits="true")
    option = ET.SubElement(root, "option", timestep="0.002", integrator="implicitfast", cone="elliptic", noslip_iterations="4")
    ET.SubElement(option, "flag", multiccd="enable")
    asset = ET.SubElement(root, "asset")
    world = ET.SubElement(root, "worldbody")
    ET.SubElement(world, "geom", name="floor", type="plane", size="2 2 0.1")
    if box_at is not None:
        body = ET.SubElement(world, "body", name="box", pos=" ".join(map(str, box_at)))
        ET.SubElement(body, "freejoint")
        ET.SubElement(body, "geom", type="box", size=" ".join(map(str, BOX_HALF)), density="600")
    arm.add_arm(root, asset, world, arm.ArmMount(np.zeros(3), 0.0))
    return mujoco.MjModel.from_xml_string(ET.tostring(root, encoding="unicode"))


def _dh_flange(q: np.ndarray) -> np.ndarray:
    """Flange pose from the modified DH table, independently of the MJCF."""
    transform = np.eye(4)
    for joint, angle in zip(arm.JOINTS, q):
        ca, sa, ct, st = np.cos(joint.alpha), np.sin(joint.alpha), np.cos(angle), np.sin(angle)
        transform = transform @ np.array(
            [
                [ct, -st, 0.0, joint.a],
                [st * ca, ct * ca, -sa, -sa * joint.d],
                [st * sa, ct * sa, ca, ca * joint.d],
                [0.0, 0.0, 0.0, 1.0],
            ]
        )
    return transform @ np.array([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, arm.FLANGE_OFFSET], [0, 0, 0, 1.0]])


def _drive(model, data, q, grip, seconds):
    """Ramp the position targets to (q, grip) and step the simulation."""
    start = data.ctrl.copy()
    goal = np.array([*q, grip])
    steps = int(seconds / model.opt.timestep)
    for k in range(steps):
        s = (k + 1) / steps
        data.ctrl[:] = start + (goal - start) * s * s * (3 - 2 * s)
        mujoco.mj_step(model, data)


def test_forward_kinematics_matches_the_dh_table():
    model = _arm_world()
    data = mujoco.MjData(model)
    ik = ArmIk(model)
    rng = np.random.default_rng(7)
    site = model.site(arm.FLANGE_SITE).id
    for _ in range(5):
        q = rng.uniform(ik.lower, ik.upper)
        data.qpos[ik.qpos] = q
        mujoco.mj_kinematics(model, data)
        expected = _dh_flange(q)
        assert np.allclose(data.site_xpos[site], expected[:3, 3], atol=1e-6)
        assert np.allclose(data.site_xmat[site].reshape(3, 3), expected[:3, :3], atol=1e-6)


def test_every_shell_is_a_closed_convex_hull():
    for part in arm.arm_parts():
        assert part.mesh.is_watertight, part.name
        assert part.mesh.is_convex, part.name


def test_top_down_grasps_cover_the_reach_band():
    ik = ArmIk(_arm_world())
    for r in (REACH_MIN, (REACH_MIN + REACH_MAX) / 2, REACH_MAX):
        for heading in np.radians([-90, -45, 0, 45, 90]):
            for dz in (0.0, 0.15):
                target = np.array([r * np.cos(heading), r * np.sin(heading), dz])
                # The gripper is symmetric, so a grasp yaw and yaw + 180 degrees are the same grasp.
                assert any(ik.solve(target, top_down(heading + yaw)).ok for yaw in (np.pi / 2, -np.pi / 2)), (r, heading, dz)


def test_arm_picks_up_a_box():
    box_at = np.array([0.5, 0.1, BOX_HALF[2]])
    model = _arm_world(box_at)
    data = mujoco.MjData(model)
    ik = ArmIk(model)
    data.qpos[ik.qpos] = arm.HOME
    data.ctrl[:] = arm.home_ctrl()
    mujoco.mj_forward(model, data)
    grasp = top_down(-np.pi / 2)  # close along y, across the 6 cm side (+90 degrees hits joint 7's limit)
    above = ik.solve(box_at + [0, 0, 0.12], grasp)
    at = ik.solve(box_at, grasp, above.q)
    lift = ik.solve(box_at + [0, 0, 0.2], grasp, at.q)
    assert above.ok and at.ok and lift.ok
    _drive(model, data, above.q, arm.GRIPPER_OPEN, 1.5)
    _drive(model, data, at.q, arm.GRIPPER_OPEN, 1.0)
    _drive(model, data, at.q, 0.0, 0.8)
    _drive(model, data, lift.q, 0.0, 1.5)
    assert data.body("box").xpos[2] > box_at[2] + 0.15
    # The fingers stop at the box faces instead of sinking into them.
    assert data.joint(arm.FINGER_JOINTS[0]).qpos[0] == pytest.approx(BOX_HALF[1], abs=0.002)


def _cup(scene, name, offset) -> ScannedObject:
    (table,) = [b for b in scene.boxes if b.category == "table"]
    hull = trimesh.creation.box(extents=CUP_SIZE)
    xy = table.center[:2] + offset
    return ScannedObject(
        name=name,
        label="cup",
        position=np.array([xy[0], xy[1], TABLE_H + CUP_SIZE[2] / 2 + 0.003]),
        visual_glb=hull.export(file_type="glb"),
        hull_vertices=np.asarray(hull.vertices),
        hull_faces=np.asarray(hull.faces),
        size=CUP_SIZE,
        rgba=(0.9, 0.5, 0.2, 1.0),
        depth_scale=0.86,
        fit_error_m=0.005,
    )


@pytest.fixture
def scene_with_arm():
    scene = build_scene(parse_room(room_document()), probe_count=0)
    cups = (_cup(scene, "obj_0_cup", np.array([0.3, 0.1])), _cup(scene, "obj_1_cup", np.array([0.15, -0.2])))
    items = [footprint(c.name, c.position + c.hull_vertices) for c in cups]
    mount = choose_mount(scene.boxes, items)
    return dataclasses.replace(scene, objects=cups, arm=mount), items


def test_arm_stands_on_the_table_within_reach_of_every_object(scene_with_arm):
    scene, items = scene_with_arm
    mount = scene.arm
    assert mount is not None and mount.support == "table_0" and mount.pedestal_height == 0
    assert mount.position[2] == pytest.approx(TABLE_H, abs=1e-6)
    assert reachable(mount, items) == [i.name for i in items]
    for item in items:
        assert np.linalg.norm(item.center - mount.position[:2]) >= BASE_RADIUS + item.radius + OBJECT_CLEARANCE


def test_no_mount_without_a_supporting_table():
    floating = [footprint("obj_0_cup", np.array([[0, 0, 2.0], [0.05, 0.05, 2.1]]))]
    scene = build_scene(parse_room(room_document()), probe_count=0)
    assert choose_mount(scene.boxes, floating) is None


def test_arm_holds_its_home_pose_among_the_objects(scene_with_arm):
    scene, _ = scene_with_arm
    model = mujoco.MjModel.from_xml_string(scene_to_mjcf(scene))
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, model.key("home").id)
    mujoco.mj_forward(model, data)
    qpos = [model.jnt_qposadr[model.joint(n).id] for n in arm.JOINT_NAMES]
    assert np.allclose(data.qpos[qpos], arm.HOME)
    start = {name: data.body(name).xpos.copy() for name in ("obj_0_cup", "obj_1_cup")}
    for _ in range(int(2.0 / model.opt.timestep)):
        mujoco.mj_step(model, data)
    assert np.abs(data.qpos[qpos] - arm.HOME).max() < 1e-3
    for name, position in start.items():
        assert np.linalg.norm(data.body(name).xpos - position) < 0.01, name


def test_arm_meets_tables_but_not_furniture_bounding_boxes(scene_with_arm):
    scene, _ = scene_with_arm
    model = mujoco.MjModel.from_xml_string(scene_to_mjcf(scene))

    def collide(a: int, b: int) -> bool:
        return bool(model.geom_contype[a] & model.geom_conaffinity[b] or model.geom_contype[b] & model.geom_conaffinity[a])

    hand = model.geom(f"{arm.LINK_NAMES[-1]}_shell").id
    link = model.geom(f"{arm.LINK_NAMES[3]}_shell").id
    cup = model.geom("obj_0_cup_geom").id
    assert collide(hand, model.geom("table_0").id)
    assert collide(hand, cup)
    assert not collide(hand, link)
    for box in scene.boxes:
        if box.kind == "object" and box.category != "table":
            assert model.geom_contype[model.geom(box.name).id] == FURNITURE_CONTYPE
            assert not collide(hand, model.geom(box.name).id)
            assert collide(cup, model.geom(box.name).id)
