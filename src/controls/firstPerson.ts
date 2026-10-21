import { Euler, Quaternion, Vector3 } from 'three';
import { EYE_HEIGHT } from '../collision/capsule';
import type { Vec2 } from '../data/schema';

export interface CameraPose {
  position: Vector3;
  quaternion: Quaternion;
}

export const PITCH_LIMIT = 1.45;

/** Camera orientation for a yaw (0 looks north, counterclockwise) and pitch (up positive). */
export function lookQuaternion(yaw: number, pitch: number): Quaternion {
  return new Quaternion().setFromEuler(new Euler(pitch, yaw, 0, 'YXZ'));
}

/** First person: eyes at 1.65 m above the smoothed body height. */
export function firstPersonPose(p: Vec2, body: number, yaw: number, pitch: number): CameraPose {
  return {
    position: new Vector3(p.x, body + EYE_HEIGHT, -p.y),
    quaternion: lookQuaternion(yaw, pitch),
  };
}
