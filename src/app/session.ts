import { Quaternion, Vector3, type Mesh } from 'three';
import type { FloorPlan, Vec2 } from '../data/schema';
import { CollisionWorld } from '../collision/world';
import { FIXED_DT, PlayerBody } from '../collision/capsule';
import { DoorController } from '../collision/doors';
import { Mannequin } from '../controls/avatar';
import { firstPersonPose, PITCH_LIMIT, type CameraPose } from '../controls/firstPerson';
import { ThirdPersonCamera } from '../controls/thirdPerson';
import { ModeTransition } from '../controls/transition';
import type { InputState } from '../controls/input';
import type { DoorObject } from '../geometry/merge';
import { floorSpawn, roomAt, startSpawn, type Spawn } from '../plan/navigation';
import type { Tour } from './tour';

export interface PlayerState {
  x: number;
  y: number;
  feet: number;
  yaw: number;
  pitch: number;
  floor: number;
  mode: 'first' | 'third';
}

export interface SessionEvents {
  room(name: string): void;
  floor(index: number): void;
  mode(mode: 'first' | 'third'): void;
}

/**
 * One walkthrough of one plan: player physics at a fixed 120 Hz with render interpolation,
 * auto doors, first/third person cameras with a smooth switch, room and floor tracking.
 */
export class TourSession {
  readonly world: CollisionWorld;
  readonly body: PlayerBody;
  readonly doors: DoorController;
  readonly avatar = new Mannequin();
  readonly transition = new ModeTransition();
  private third = new ThirdPersonCamera();
  private doorObjects: DoorObject[];
  private acc = 0;
  private room = '';
  private floor = -1;
  private pose: CameraPose = { position: new Vector3(), quaternion: new Quaternion() };
  /** Freezes movement (menus, fades) while still rendering. */
  paused = false;

  constructor(
    readonly tour: Tour,
    readonly plan: FloorPlan,
    private input: InputState,
    private events: SessionEvents,
  ) {
    this.world = new CollisionWorld(plan);
    this.doorObjects = tour.floors.flatMap((f) => (f ? f.objects.doors : []));
    this.doors = new DoorController(
      this.doorObjects.map((d) => d.def),
      (id) => plan.floors.find((f) => f.id === id)?.elevation ?? 0,
    );
    const spawn = startSpawn(plan);
    this.body = new PlayerBody(spawn.position, plan.floors[spawn.floorIndex].elevation, spawn.yaw);
    this.body.feet = this.world.heightAt(spawn.position, this.body.feet);
    this.body.body.snap(this.body.feet);
    tour.scene.add(this.avatar.root);
    tour.probeHidden = [this.avatar.root];
    this.avatar.root.visible = false;
    const colliders: Mesh[] = [];
    for (const f of tour.floors) {
      if (!f) continue;
      for (const group of [f.objects.shell, f.objects.furniture]) {
        for (const c of group.children) {
          const m = c as Mesh;
          if (m.isMesh && m.userData.materialKey !== 'rug') colliders.push(m);
        }
      }
    }
    this.third.setColliders(colliders);
    this.update(0);
  }

  get mode(): 'first' | 'third' {
    return this.transition.mode;
  }

  toggleMode(): void {
    this.setMode(this.mode === 'first' ? 'third' : 'first');
  }

  setMode(mode: 'first' | 'third', instant = false): void {
    if (mode === 'third' && this.mode === 'first') this.third.reset();
    this.transition.set(mode, instant);
    this.events.mode(mode);
  }

  /** Q7: put the player on another floor's stair landing, facing into the plan. */
  teleportToFloor(index: number): void {
    this.spawnAt(floorSpawn(this.plan, index));
  }

  spawnAt(s: Spawn): void {
    const e = this.plan.floors[s.floorIndex].elevation;
    const feet = this.world.heightAt(s.position, e);
    this.body.teleport(s.position, feet, s.yaw);
    this.body.pitch = 0;
    this.third.reset();
    this.acc = 0;
  }

  getState(): PlayerState {
    return {
      x: this.body.position.x,
      y: this.body.position.y,
      feet: this.body.feet,
      yaw: this.body.yaw,
      pitch: this.body.pitch,
      floor: this.floor,
      mode: this.mode,
    };
  }

  setState(s: Partial<PlayerState>): void {
    const p: Vec2 = { x: s.x ?? this.body.position.x, y: s.y ?? this.body.position.y };
    const feet = s.feet ?? this.body.feet;
    this.body.teleport(p, this.world.heightAt(p, feet), s.yaw ?? this.body.yaw);
    if (s.pitch !== undefined) this.body.pitch = s.pitch;
    if (s.mode) this.setMode(s.mode, true);
  }

  update(dt: number): void {
    const look = this.input.consumeLook();
    if (!this.paused) {
      this.body.yaw -= look.x;
      this.body.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.body.pitch + look.y));
      this.acc += dt;
      const move = this.input.move;
      let steps = 0;
      while (this.acc >= FIXED_DT && steps < 24) {
        this.doors.update(FIXED_DT, this.body.position, this.body.feet, this.world, 0.25);
        this.body.step({ x: move.x, y: move.y, run: this.input.run }, this.world, this.doors.segments());
        this.acc -= FIXED_DT;
        steps++;
      }
      if (steps >= 24) this.acc = 0;
    }
    for (let i = 0; i < this.doorObjects.length; i++) this.doorObjects[i].set(this.doors.doors[i].amount);

    const alpha = this.paused ? 1 : Math.min(1, this.acc / FIXED_DT);
    const { p, body } = this.body.interpolated(alpha);
    this.transition.update(dt);
    const fp = firstPersonPose(p, body, this.body.yaw, this.body.pitch);
    const blend = this.transition.blend;
    let camDistance = 0;
    if (blend > 0) {
      const tp = this.third.pose(p, body, this.body.yaw, this.body.pitch, dt);
      camDistance = tp.distance;
      this.transition.apply(fp, tp, this.pose);
    } else {
      this.pose.position.copy(fp.position);
      this.pose.quaternion.copy(fp.quaternion);
    }
    const cam = this.tour.camera;
    cam.position.copy(this.pose.position);
    cam.quaternion.copy(this.pose.quaternion);

    // Avatar: visible in third person, fading out when the camera is right behind its head.
    const show = blend > 0.02;
    this.avatar.root.visible = show;
    if (show) {
      this.avatar.root.position.set(p.x, body, -p.y);
      this.avatar.root.rotation.y = this.body.yaw + Math.PI;
      this.avatar.update(dt, this.body.speed, this.input.run);
      const fade = Math.min(1, Math.max(0, (camDistance * blend - 0.45) / 0.5));
      this.avatar.setOpacity(blend < 1 ? Math.min(fade, blend * 2) : fade);
    }

    // Floor and room tracking.
    const fi = this.tour.floorAtHeight(this.body.feet);
    if (fi !== this.floor) {
      this.floor = fi;
      this.tour.setFloor(fi);
      this.events.floor(fi);
    }
    const onStair = this.world.onStair(this.body.position, this.body.feet) && Math.abs(this.body.feet - this.plan.floors[fi].elevation) > 0.3;
    const name = onStair ? 'Stairs' : (roomAt(this.plan.floors[fi], this.body.position)?.name ?? '');
    if (name !== this.room) {
      this.room = name;
      this.events.room(name);
    }
  }

  get roomName(): string {
    return this.room;
  }

  dispose(): void {
    this.tour.scene.remove(this.avatar.root);
    this.avatar.dispose();
  }
}
