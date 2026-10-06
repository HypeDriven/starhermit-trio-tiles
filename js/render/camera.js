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
  // Critically damped: x'' = -2ζω v - ω² (x - target), ζ = 1, integrated
  // implicitly (stable at any dt). The previous closed form dropped the
  // -ω²dt²·x term, so the camera settled ~10 % past its target, by an amount
  // that depended on the frame rate.
  const det = 1 + omega * dt * 2 + omega * omega * dt * dt;
  const newV = (velocity - omega * omega * dt * (current - target)) / det;
  return [current + newV * dt, newV];
}

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.anchor = 'wide';
    // `frame` = lens shift + zoom (see setAnchor): {z, x, y}.
    this.target = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 38, frame: { z: 1, x: 0, y: 0 } };
    this.current = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 38, frame: { z: 1, x: 0, y: 0 } };
    this.velocity = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 0, frame: { z: 0, x: 0, y: 0 } };
    this._applied = { z: 1, x: 0, y: 0 };
    this.omega = 3.2; // spring stiffness: quick but calm
    this.shakeAmp = 0;
    this.shakeTime = 0;
    this.reducedMotion = false;
    this._shakeSeed = Math.random() * 1000;
    this._tmp = new THREE.Vector3();
    this.snap('wide');
  }

  /**
   * Aim at an authored anchor. `frame` frames the play area inside the
   * HUD-free part of the screen without moving the authored camera: the
   * rendered window is the anchor's view scaled by `z` around the
   * anchor-view NDC point (x, y) (an off-axis lens shift via setViewOffset).
   */
  setAnchor(name, frame = null) {
    const a = CAMERA_ANCHORS[name];
    if (!a) return;
    this.anchor = name;
    this.target.pos.fromArray(a.pos);
    this.target.look.fromArray(a.look);
    this.target.fov = a.fov;
    this.target.frame = frame ? { ...frame } : { z: 1, x: 0, y: 0 };
  }

  /** Instant placement (also used by reduced-motion and fast-forward). */
  snap(name = this.anchor, frame = null) {
    this.setAnchor(name, frame);
    this.current.pos.copy(this.target.pos);
    this.current.look.copy(this.target.look);
    this.current.fov = this.target.fov;
    this.current.frame = { ...this.target.frame };
    this.velocity.frame = { z: 0, x: 0, y: 0 };
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
    for (const k of ['z', 'x', 'y']) {
      [this.current.frame[k], this.velocity.frame[k]] = dampedSpring(
        this.current.frame[k],
        this.target.frame[k],
        this.velocity.frame[k],
        w,
        dt,
      );
    }
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
    const f = this.current.frame;
    const ap = this._applied;
    const frameMoved = Math.abs(f.z - ap.z) > 1e-4 || Math.abs(f.x - ap.x) > 1e-5 || Math.abs(f.y - ap.y) > 1e-5;
    if (frameMoved) {
      this._applied = { ...f };
      if (Math.abs(f.z - 1) < 1e-4 && Math.abs(f.x) < 1e-5 && Math.abs(f.y) < 1e-5) {
        this.camera.clearViewOffset();
      } else {
        // Virtual full frame = the anchor's view (2×2 NDC units, x scaled by
        // the aspect because setViewOffset derives the aspect from it);
        // render the window of size 2/z centred on (x, y).
        const s = 2 / f.z;
        const A = this.camera.aspect;
        this.camera.setViewOffset(2 * A, 2, (f.x + 1 - s / 2) * A, 1 - f.y - s / 2, s * A, s);
      }
    }
    if (Math.abs(this.camera.fov - this.current.fov) > 0.01) {
      this.camera.fov = this.current.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** NDC bounds of world points seen from anchor `name` at `aspect` (no lens frame). */
  static projectBounds(name, points, aspect, cam = new THREE.PerspectiveCamera()) {
    const a = CAMERA_ANCHORS[name];
    cam.fov = a.fov;
    cam.aspect = aspect;
    cam.near = 0.1;
    cam.far = 200;
    cam.clearViewOffset();
    cam.position.fromArray(a.pos);
    cam.lookAt(new THREE.Vector3().fromArray(a.look));
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const v = new THREE.Vector3();
    for (const p of points) {
      v.copy(p).project(cam);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
      y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    return { x0, x1, y0, y1 };
  }

  /**
   * Frame that maps the NDC rect `b` (from projectBounds) onto the NDC rect
   * `safe` ({x0, x1, y0, y1}), as large as fits. Zoom is clamped so tiny or
   * odd boxes never produce extreme views.
   */
  static frameFor(b, safe) {
    const hx = (b.x1 - b.x0) / 2, hy = (b.y1 - b.y0) / 2;
    const sw = (safe.x1 - safe.x0) / 2, sh = (safe.y1 - safe.y0) / 2;
    if (!(hx > 0 && hy > 0 && sw > 0 && sh > 0)) return { z: 1, x: 0, y: 0 };
    const z = Math.min(3, Math.max(0.3, Math.min(sw / hx, sh / hy)));
    // Content centre c must land on safe centre s: (c - window) · z = s.
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const sx = (safe.x0 + safe.x1) / 2, sy = (safe.y0 + safe.y1) / 2;
    return { z, x: cx - sx / z, y: cy - sy / z };
  }

  /** Screen NDC rect of anchor-NDC rect `b` under lens frame `f`. */
  static framed(b, f) {
    return { x0: (b.x0 - f.x) * f.z, x1: (b.x1 - f.x) * f.z, y0: (b.y0 - f.y) * f.z, y1: (b.y1 - f.y) * f.z };
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
