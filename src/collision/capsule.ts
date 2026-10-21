import type { Vec2 } from '../data/schema';
import { add, len, scale, sub } from '../util/math2d';
import { HeightSpring } from './stairs';
import { PLAYER_RADIUS, type CollisionWorld, type Segment } from './world';

export const EYE_HEIGHT = 1.65;
export const WALK_SPEED = 1.45;
export const RUN_SPEED = 3.1;
export const FIXED_DT = 1 / 120;

export interface MoveInput {
  /** Strafe (-1 left, +1 right) and forward (+1) in the player's frame. */
  x: number;
  y: number;
  run: boolean;
}

/**
 * The player body: plan position, yaw, feet height (raw, from the plan) and a smoothed body
 * height. Physics runs at a fixed 120 Hz so 60 and 120 Hz displays move identically.
 */
export class PlayerBody {
  position: Vec2;
  prevPosition: Vec2;
  /** Raw walking height under the player. */
  feet: number;
  readonly body: HeightSpring;
  prevBody: number;
  velocity: Vec2 = { x: 0, y: 0 };
  yaw: number;
  pitch = 0;
  /** Horizontal speed after collision, for animation. */
  speed = 0;

  constructor(position: Vec2, feet: number, yaw: number) {
    this.position = { ...position };
    this.prevPosition = { ...position };
    this.feet = feet;
    this.body = new HeightSpring(feet);
    this.prevBody = feet;
    this.yaw = yaw;
  }

  /** Forward unit vector in plan for the current yaw (yaw 0 looks north, counterclockwise). */
  forward(): Vec2 {
    return { x: -Math.sin(this.yaw), y: Math.cos(this.yaw) };
  }

  teleport(p: Vec2, feet: number, yaw: number): void {
    this.position = { ...p };
    this.prevPosition = { ...p };
    this.feet = feet;
    this.body.snap(feet);
    this.prevBody = feet;
    this.yaw = yaw;
    this.velocity = { x: 0, y: 0 };
  }

  step(input: MoveInput, world: CollisionWorld, dynamic: Segment[]): void {
    this.prevPosition = { ...this.position };
    this.prevBody = this.body.value;
    const f = this.forward();
    const r = { x: f.y, y: -f.x };
    let wish = add(scale(f, input.y), scale(r, input.x));
    const wl = len(wish);
    if (wl > 1) wish = scale(wish, 1 / wl);
    const target = scale(wish, input.run ? RUN_SPEED : WALK_SPEED);
    // Quick acceleration, slightly softer stop.
    const k = 1 - Math.exp(-(wl > 0.01 ? 12 : 9) * FIXED_DT);
    this.velocity = add(this.velocity, scale(sub(target, this.velocity), k));
    const next = add(this.position, scale(this.velocity, FIXED_DT));
    // Height first at the new point, so stairs and floors pick the right collision span.
    const h = world.heightAt(next, this.feet);
    const resolved = world.resolve(next, h, dynamic, PLAYER_RADIUS);
    this.feet = world.heightAt(resolved, h);
    this.position = resolved;
    const moved = sub(this.position, this.prevPosition);
    this.speed = len(moved) / FIXED_DT;
    // Keep velocity in line with what actually happened (wall sliding).
    this.velocity = scale(moved, 1 / FIXED_DT);
    this.body.step(this.feet, FIXED_DT);
  }

  /** Interpolated render state between the last two physics steps. */
  interpolated(alpha: number): { p: Vec2; body: number } {
    return {
      p: { x: this.prevPosition.x + (this.position.x - this.prevPosition.x) * alpha, y: this.prevPosition.y + (this.position.y - this.prevPosition.y) * alpha },
      body: this.prevBody + (this.body.value - this.prevBody) * alpha,
    };
  }
}
