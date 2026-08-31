/**
 * Camera rig — authored anchors, critically damped spring transitions
 * (never cumulative per-frame lerp), interruptible at any time, and a
 * low-amplitude event-tiered shake that never changes raycast truth.
 */

import * as THREE from 'three';

export const CAMERA_ANCHORS = {
  wide: { pos: [0, 7.6, 9.4], look: [0, 0, -0.4], fov: 38 },
  square: { pos: [0, 8.6, 8.2], look: [0, 0, -0.3], fov: 40 },
  portrait: { pos: [0, 10.8, 6.6], look: [0, -0.2, -0.6], fov: 44 },
  top: { pos: [0, 12.5, 2.2], look: [0, 0, -0.4], fov: 40 },
  low: { pos: [0, 4.2, 10.8], look: [0, 0.6, -0.6], fov: 36 },
  win: { pos: [0, 5.4, 7.0], look: [0, 0.4, 0], fov: 34 },
};

function dampedSpring(current, target, velocity, omega, dt) {
  // Critically damped: x'' = -2ζω v - ω² (x - target), ζ = 1.
  const f = 1 + omega * dt;
  const det = 1 + omega * dt * 2 + omega * omega * dt * dt;
  const newX = (current * f * f + target * omega * omega * dt * dt + velocity * dt * f) / det;
  const newV = (velocity - omega * omega * dt * (current - target) - omega * velocity * dt) / f;
  return [newX, newV];
}

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.anchor = 'wide';
    this.target = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 38 };
    this.current = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 38 };
    this.velocity = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 0 };
    this.omega = 3.2; // spring stiffness: quick but calm
    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.reducedMotion = false;
    this._shakeSeed = Math.random() * 1000;
    this._tmp = new THREE.Vector3();
    this.snap('wide');
  }

  setAnchor(name) {
    const a = CAMERA_ANCHORS[name];
    if (!a) return;
    this.anchor = name;
    this.target.pos.fromArray(a.pos);
    this.target.look.fromArray(a.look);
    this.target.fov = a.fov;
  }

  /** Instant placement (also used by reduced-motion and fast-forward). */
  snap(name = this.anchor) {
    this.setAnchor(name);
    this.current.pos.copy(this.target.pos);
    this.current.look.copy(this.target.look);
    this.current.fov = this.target.fov;
    this.velocity.pos.set(0, 0, 0);
    this.velocity.look.set(0, 0, 0);
    this.velocity.fov = 0;
    this._apply(0);
  }

  /** Event-tiered impulse: 0 = pick, 1 = triple, 2 = round end. */
  shake(tier) {
    if (this.reducedMotion) return;
    const amps = [0.02, 0.05, 0.09];
    this.shakeAmp = Math.max(this.shakeAmp, amps[tier] ?? 0.02);
    this.shakeTime = 0;
  }

  update(dt) {
    const w = this.omega;
    let vx = this.velocity.pos.x;
    let vy = this.velocity.pos.y;
    let vz = this.velocity.pos.z;
    [this.current.pos.x, vx] = dampedSpring(this.current.pos.x, this.target.pos.x, vx, w, dt);
    [this.current.pos.y, vy] = dampedSpring(this.current.pos.y, this.target.pos.y, vy, w, dt);
    [this.current.pos.z, vz] = dampedSpring(this.current.pos.z, this.target.pos.z, vz, w, dt);
    this.velocity.pos.set(vx, vy, vz);
    let lx = this.velocity.look.x;
    let ly = this.velocity.look.y;
    let lz = this.velocity.look.z;
    [this.current.look.x, lx] = dampedSpring(this.current.look.x, this.target.look.x, lx, w, dt);
    [this.current.look.y, ly] = dampedSpring(this.current.look.y, this.target.look.y, ly, w, dt);
    [this.current.look.z, lz] = dampedSpring(this.current.look.z, this.target.look.z, lz, w, dt);
    this.velocity.look.set(lx, ly, lz);
    let vf = this.velocity.fov;
    [this.current.fov, vf] = dampedSpring(this.current.fov, this.target.fov, vf, w, dt);
    this.velocity.fov = vf;
    this._apply(dt);
  }

  _apply(dt) {
    this.shakeTime += dt;
    this.shakeAmp = Math.max(0, this.shakeAmp - dt * 0.12);
    let ox = 0;
    let oy = 0;
    if (this.shakeAmp > 0.0005 && !this.reducedMotion) {
      const t = this._shakeSeed + this.shakeTime * 31;
      ox = Math.sin(t * 1.1) * this.shakeAmp;
      oy = Math.cos(t * 1.7) * this.shakeAmp * 0.6;
    }
    this.camera.position.set(this.current.pos.x + ox, this.current.pos.y + oy, this.current.pos.z);
    this._tmp.copy(this.current.look);
    this.camera.lookAt(this._tmp);
    if (Math.abs(this.camera.fov - this.current.fov) > 0.01) {
      this.camera.fov = this.current.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Fit anchor choice to the viewport aspect. */
  anchorForAspect(aspect, preference = 'default') {
    if (preference === 'top') return 'top';
    if (preference === 'low') return 'low';
    if (aspect >= 1.25) return 'wide';
    if (aspect >= 0.85) return 'square';
    return 'portrait';
  }
}
