import dataclasses
import xml.etree.ElementTree as ET

import mujoco
import numpy as np
import pytest

from fixtures import ROOM_D, ROOM_W, TABLE_H, room_document
from scan2sim import arm, mobile, navgrid, robots
from scan2sim.ik import ArmIk, top_down
from scan2sim.mjcf import scene_to_mjcf
from scan2sim.roomplan import parse_room
from scan2sim.scene import build_scene

DESK_HEIGHT = 0.784  # the scanned desk (RoomPlan top fitted to LiDAR)
SAFE_TABLE_HEIGHTS = (0.45, 0.70, DESK_HEIGHT, 0.95)  # coffee table .. counter


def _world_with(add) -> mujoco.MjModel:
    root = ET.Element("mujoco")
    ET.SubElement(root, "compiler", angle="radian", autolimits="true")
    option = ET.SubElement(root, "option", timestep="0.002", integrator="implicitfast", cone="elliptic", noslip_iterations="4")
    ET.SubElement(option, "flag", multiccd="enable")
    asset = ET.SubElement(root, "asset")
    world = ET.SubElement(root, "worldbody")
    ET.SubElement(world, "geom", name="floor", type="plane", size="3 3 0.1")
    add(root, asset, world)
    return mujoco.MjModel.from_xml_string(ET.tostring(root, encoding="unicode"))


START = mobile.MobileMount(np.array([0.3, -0.2, 0.0]), 0.4)


@pytest.fixture
def rover():
    model = _world_with(lambda root, asset, world: mobile.add_mobile(root, asset, world, START))
    data = mujoco.MjData(model)
    qpos, ctrl = mobile.rest_state(START)
    for name, value in qpos.items():
        data.qpos[model.jnt_qposadr[model.joint(name).id]] = value
    for name, value in ctrl.items():
        data.ctrl[model.actuator(name).id] = value
    mujoco.mj_forward(model, data)
    return model, data


def _step(model, data, seconds):
    for _ in range(int(seconds / model.opt.timestep)):
        mujoco.mj_step(model, data)


def test_mobile_manipulator_compiles_with_its_joints_and_actuators(rover):
    model, _ = rover
    names = {mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_JOINT, j) for j in range(model.njnt)}
    assert names == {*mobile.BASE_JOINTS, mobile.LIFT_JOINT, *mobile.ARM.joint_names, *mobile.ARM.finger_joints}
    assert model.njnt == 3 + 1 + 7 + 2
    assert model.nu == 3 + 1 + 7 + 1  # base x, y, yaw, lift, 7 arm joints, gripper
    assert model.nmocap == 0


def test_base_joints_are_world_coordinates(rover):
    model, data = rover
    base = data.body(mobile.BASE_BODY)
    assert base.xpos[:2] == pytest.approx(START.position[:2], abs=1e-9)
    heading = base.xmat.reshape(3, 3)[:2, 0]
    assert np.arctan2(heading[1], heading[0]) == pytest.approx(START.yaw, abs=1e-9)
    # The arm stands in front of the base centre, on the lift.
    arm_base = data.body(mobile.ARM.link_names[0]).xpos
    expected = START.position[:2] + mobile.ARM_OFFSET * np.array([np.cos(START.yaw), np.sin(START.yaw)])
    assert arm_base[:2] == pytest.approx(expected, abs=1e-9)
    assert arm_base[2] == pytest.approx(mobile.LIFT_BASE_Z + mobile.LIFT_HOME, abs=1e-9)


def test_lift_range_covers_the_desk_height():
    low, high = mobile.LIFT_BASE_Z, mobile.LIFT_BASE_Z + mobile.LIFT_TRAVEL
    for table in SAFE_TABLE_HEIGHTS:
        # Top-down grasps reach furthest when the grasp point (~3 cm above the top) is ~8 cm above
        # the arm base: the planner puts the base 5 cm below the table top.
        assert low <= table - 0.05 <= high, table


def test_lift_raises_the_arm_to_the_desk_and_holds_it(rover):
    model, data = rover
    target = mobile.lift_for_arm_base(DESK_HEIGHT - 0.05)
    data.ctrl[model.actuator(mobile.LIFT_JOINT).id] = target
    _step(model, data, 2.0)
    assert data.body(mobile.ARM.link_names[0]).xpos[2] == pytest.approx(DESK_HEIGHT - 0.05, abs=0.003)
    arm_q = [data.joint(n).qpos[0] for n in mobile.ARM.joint_names]
    assert np.abs(np.array(arm_q) - arm.STOW).max() < 2e-3  # gravity compensated: nothing sags


def test_base_drives_to_planar_targets(rover):
    model, data = rover
    goal = np.array([0.9, 0.35, -0.6])
    for name, value in zip(mobile.BASE_JOINTS, goal):
        data.ctrl[model.actuator(name).id] = value
    _step(model, data, 3.0)
    reached = np.array([data.joint(n).qpos[0] for n in mobile.BASE_JOINTS])
    assert reached == pytest.approx(goal, abs=2e-3)


def test_wide_gripper_opens_to_16_cm(rover):
    model, data = rover
    assert mobile.ARM.max_width == pytest.approx(0.16)
    assert arm.STATIONARY.max_width == pytest.approx(0.11)
    _step(model, data, 0.5)
    left, right = (data.joint(f).qpos[0] for f in mobile.ARM.finger_joints)
    assert left + right == pytest.approx(0.16, abs=2e-3)


def test_mobile_arm_reaches_a_desk_top_from_the_lift():
    model = _world_with(lambda root, asset, world: mobile.add_mobile(root, asset, world, START))
    ik = ArmIk(model, mobile.ARM)
    data = ik.data
    data.qpos[model.jnt_qposadr[model.joint(mobile.LIFT_JOINT).id]] = mobile.lift_for_arm_base(DESK_HEIGHT - 0.05)
    data.qpos[model.jnt_qposadr[model.joint(mobile.BASE_JOINTS[0]).id]] = 0.0
    data.qpos[model.jnt_qposadr[model.joint(mobile.BASE_JOINTS[1]).id]] = 0.0
    mujoco.mj_kinematics(model, data)
    base = data.body(mobile.ARM.link_names[0]).xpos.copy()
    for reach in (0.35, 0.55, 0.70):
        target = base + np.array([reach, 0.0, 0.08])
        assert any(ik.solve(target, top_down(yaw)).ok for yaw in (np.pi / 2, -np.pi / 2)), reach


def test_stationary_arm_base_is_a_mocap_body():
    model = _world_with(lambda root, asset, world: arm.add_arm(root, asset, world, arm.ArmMount(np.zeros(3), 0.0)))
    data = mujoco.MjData(model)
    data.qpos[[model.jnt_qposadr[model.joint(n).id] for n in arm.JOINT_NAMES]] = arm.HOME
    mujoco.mj_forward(model, data)
    grip = data.site(arm.GRIP_SITE).xpos.copy()
    assert model.nmocap == 1 and model.body_mocapid[model.body(arm.LINK_NAMES[0]).id] == 0
    data.mocap_pos[0] = [0.4, -0.3, 0.75]
    mujoco.mj_forward(model, data)
    assert data.site(arm.GRIP_SITE).xpos == pytest.approx(grip + [0.4, -0.3, 0.75], abs=1e-9)


@pytest.fixture
def scene():
    return build_scene(parse_room(room_document()), probe_count=0)


def test_start_spot_is_open_floor_facing_the_table(scene):
    (table,) = [b for b in scene.boxes if b.category == "table"]
    floor = navgrid.floor_outline(scene.floor)
    start = mobile.choose_start(scene.boxes, floor, table)
    assert start is not None and start.near == table.name
    point = start.position[None, :2]
    assert navgrid.inside_polygon(point, floor)[0]
    clearance = navgrid.clearance(point, navgrid.obstacles(scene.boxes), floor)[0]
    assert clearance >= mobile.FOOTPRINT_RADIUS + mobile.NAV_MARGIN
    heading = np.array([np.cos(start.yaw), np.sin(start.yaw)])
    to_table = table.center[:2] - start.position[:2]
    assert heading @ to_table / np.linalg.norm(to_table) == pytest.approx(1.0, abs=1e-6)
    assert navgrid.footprint_distance(navgrid.box_footprint(table), point)[0] < 1.0


def test_floor_outline_comes_from_roomplan_polygon_corners():
    doc = room_document()
    half_w, half_d = ROOM_W / 2, ROOM_D / 2
    # RoomPlan floors list their outline in the floor's own frame (x, y in the floor plane).
    doc["floors"][0]["polygonCorners"] = [[-half_w, -half_d, 0], [half_w, -half_d, 0], [half_w, half_d, 0], [-half_w, half_d, 0]]
    scene = build_scene(parse_room(doc), probe_count=0)
    assert scene.floor_polygon is not None and scene.floor_polygon.shape == (4, 2)
    expected = navgrid.floor_outline(scene.floor)
    for corner in scene.floor_polygon:
        assert np.min(np.linalg.norm(expected - corner, axis=1)) < 1e-6
    assert build_scene(parse_room(room_document()), probe_count=0).floor_polygon is None


def test_scene_with_both_robots_starts_at_rest(scene):
    (table,) = [b for b in scene.boxes if b.category == "table"]
    mount = arm.ArmMount(np.array([table.center[0], table.center[1], TABLE_H]), 0.3, support=table.name)
    rover_start = mobile.choose_start(scene.boxes, navgrid.floor_outline(scene.floor), table)
    scene = dataclasses.replace(scene, arm=mount, mobile=rover_start)
    model = mujoco.MjModel.from_xml_string(scene_to_mjcf(scene))
    data = mujoco.MjData(model)
    mujoco.mj_resetDataKeyframe(model, data, model.key(robots.KEYFRAME).id)
    mujoco.mj_forward(model, data)
    hands = {name: data.body(name).xpos.copy() for name in (arm.LINK_NAMES[-1], mobile.ARM.link_names[-1])}
    base = data.body(mobile.BASE_BODY).xpos.copy()
    _step(model, data, 2.0)
    for name, position in hands.items():
        assert np.linalg.norm(data.body(name).xpos - position) < 1e-3, name
    assert data.body(mobile.BASE_BODY).xpos == pytest.approx(base, abs=1e-6)
    assert base[:2] == pytest.approx(rover_start.position[:2], abs=1e-6)


def test_robot_registry_describes_every_robot(scene):
    (table,) = [b for b in scene.boxes if b.category == "table"]
    mount = arm.ArmMount(np.array([table.center[0], table.center[1], TABLE_H]), 0.3, support=table.name)
    rover_start = mobile.choose_start(scene.boxes, navgrid.floor_outline(scene.floor), table)
    entries = robots.metadata(dataclasses.replace(scene, arm=mount, mobile=rover_start))
    assert [(e["id"], e["kind"]) for e in entries] == [("arm", "arm"), ("mobile", "mobile")]
    stationary, rover_entry = entries
    for entry in entries:
        assert {"id", "kind", "label", "base", "position", "yaw", "reach_m", "gripper", "status_lights"} <= entry.keys()
    assert stationary["mocap"] is True and stationary["gripper"]["max_width"] == pytest.approx(0.11)
    assert stationary == {"id": "arm", "kind": "arm", "label": "Arm", **robots.arm_info(mount)}
    assert rover_entry["gripper"]["max_width"] == pytest.approx(0.16)
    assert rover_entry["arm"]["joints"] == list(mobile.ARM.joint_names)
    assert rover_entry["lift"]["arm_base_z"] == pytest.approx([mobile.LIFT_BASE_Z, mobile.LIFT_BASE_Z + mobile.LIFT_TRAVEL])
    model = mujoco.MjModel.from_xml_string(scene_to_mjcf(dataclasses.replace(scene, arm=mount, mobile=rover_start)))
    for entry in entries:
        for light in entry["status_lights"]:
            assert model.geom(light).id >= 0
    assert model.body(rover_entry["base"]).id >= 0 and model.body(stationary["base"]).id >= 0
