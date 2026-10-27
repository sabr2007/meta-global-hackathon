import numpy as np
import pytest

from scan2sim.frames import ARKIT_TO_ZUP, WorldFrame, mat4_from_column_major, quat_from_matrix


def test_arkit_up_becomes_z_up_without_mirroring():
    assert np.allclose(ARKIT_TO_ZUP @ [0, 1, 0], [0, 0, 1])
    assert np.isclose(np.linalg.det(ARKIT_TO_ZUP), 1.0)


def test_column_major_translation_lands_in_last_column():
    values = list(np.eye(4).ravel())
    values[12:15] = [1.0, 2.0, 3.0]
    assert np.allclose(mat4_from_column_major(values)[:3, 3], [1.0, 2.0, 3.0])


def test_column_major_rejects_wrong_length():
    with pytest.raises(ValueError):
        mat4_from_column_major([0.0] * 15)


def test_quat_for_quarter_turn_about_z():
    rotation = np.array([[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]])
    assert np.allclose(quat_from_matrix(rotation), [np.sqrt(0.5), 0.0, 0.0, np.sqrt(0.5)])


def test_quat_for_half_turn_is_unit_and_positive_w():
    rotation = np.diag([1.0, -1.0, -1.0])
    quat = quat_from_matrix(rotation)
    assert np.isclose(np.linalg.norm(quat), 1.0)
    assert np.allclose(np.abs(quat), [0.0, 1.0, 0.0, 0.0])


def test_world_frame_puts_origin_at_zero_and_lifts_points_above_floor():
    frame = WorldFrame(origin_arkit=np.array([1.0, -1.2, -2.0]))
    assert np.allclose(frame.points(np.array([[1.0, -1.2, -2.0]])), 0.0)
    one_meter_up = frame.points(np.array([[1.0, -0.2, -2.0]]))[0]
    assert np.allclose(one_meter_up, [0.0, 0.0, 1.0])
    assert np.allclose(frame.matrix @ [1.0, -0.2, -2.0, 1.0], [0.0, 0.0, 1.0, 1.0])
