// The floating tea table on starhermit:scene, as the browser build's
// js/render/scene.js, camera.js, geometry.js and materials.js drew it with
// three.js r164: the gradient sky dome, fog, the wooden table slab (wood
// grain canvas, bump and roughness grain at Detailed) on its floating rock,
// the teapot and cups, distant bobbing islands and drifting clouds, the mist
// ring, falling petals and teapot steam; the carved tiles (rounded bevelled
// slabs with per-symbol face art and a bump map, Lambert / Standard /
// clear-coated Physical by preset), the seven-slot tray with its fullness
// tint and insertion preview, the focus and hint rings, pooled triple bursts
// and ring pulses, the pick flight, the invalid wiggle, the win and lose
// camera beats, and the authored camera anchors on critically damped
// springs with a lens shift (setViewOffset) that frames board + tray in the
// part of the window the HUD leaves free.
//
// Engine minor 23 follows three.js r185's light units and shadows. The page
// was r164 (physically correct lights), so its intensities are used as
// written (no ÷ π) with its own shadow camera fitted around the table, bias
// −0.0004, normal bias 0.02 and radius 3. Reflections as the page set them:
// at Reflections on, RoomEnvironment(renderer) through PMREM (sigma 0.04) as
// scene.environment at environmentIntensity 0.35, else the small generated
// sky-and-glow room at 1 (r164 ignores per-material envMapIntensity with a
// scene environment, as the engine does). The old composer (RenderPass →
// GTAO → UnrealBloom 0.4 / 0.4 / 1.25 → OutputPass (ACES) → the display-space
// grade and vignette → SMAA / FXAA, or the target's MSAA) is the runtime's
// renderer.ao / bloom / grade / antialias.
//
// Differences: the sky's GLSL is WGSL; the steam's point shader (per-point
// size and alpha by life) is additive soft points whose colour fades with
// life (Points take no shader); the grain roughness map is baked
// (tools/bake-grain.mjs). Texture canvases are OffscreenCanvas.
import {
  ACESFilmicToneMapping, AdditiveBlending, AmbientLight, BackSide, BufferAttribute, BufferGeometry, CanvasTexture, Color,
  ConeGeometry, CylinderGeometry, DirectionalLight, DoubleSide, Euler, ExtrudeGeometry, Fog, Group, HemisphereLight, InstancedMesh,
  LatheGeometry, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  PCFSoftShadowMap, PMREMGenerator, PerspectiveCamera, PlaneGeometry, Points, PointsMaterial, Quaternion, Raycaster,
  RepeatWrapping, RingGeometry, RoomEnvironment, SRGBColorSpace, ShaderMaterial, Shape, SphereGeometry, TextureLoader,
  TorusGeometry, Vector2, Vector3, pointerToNdc, renderer, scene, type Material, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { Content, Engine, Rng, type Level, type RulesEvent, type State, type Stream, type Theme } from "./game.ts";
import { PARTICLES, PARTICLE_POOL, particleCounts, type Look } from "./quality.ts";
import * as Paint from "./paint.js";

const P = Paint as unknown as {
  symbolColor(sym: string, palette: string): string;
  drawSymbolGlyph(ctx: unknown, sym: string, o: { ink: string; accent: string; x?: number; y?: number }): void;
  drawNotches(ctx: unknown, i: number, color: string): void;
  roundRectPath(ctx: unknown, x: number, y: number, w: number, h: number, r: number): void;
};
export const symbolColor = (sym: string, palette: string): string => P.symbolColor(sym, palette);

// ---------------------------------------------------------------- geometry.js
export const TILE_SIZE = 0.92, TILE_THICK = 0.22, LAYER_HEIGHT = 0.26;
function roundedRectShape(w: number, h: number, r: number): Shape {
  const s = new Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function createTileGeometry(seg: [number, number]): BufferGeometry {
  const geo = new ExtrudeGeometry(roundedRectShape(TILE_SIZE, TILE_SIZE, 0.14), {
    depth: TILE_THICK - 0.06, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: seg[0], curveSegments: seg[1],
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, TILE_THICK / 2 + 0.015, 0);
  const uv = geo.getAttribute("uv") as BufferAttribute, pos = geo.getAttribute("position") as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (pos.getX(i) + TILE_SIZE / 2) / TILE_SIZE, 1 - (pos.getZ(i) + TILE_SIZE / 2) / TILE_SIZE);
  }
  uv.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}
function createTableGeometry(rx = 6.4, rz = 4.6, thick = 0.5): BufferGeometry {
  const geo = new ExtrudeGeometry(roundedRectShape(rx * 2, rz * 2, 1.1), {
    depth: thick, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelSegments: 3, curveSegments: 12,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -(thick + 0.12), 0);
  return geo;
}
function createRockGeometry(radius = 4.6, depth = 4.2): BufferGeometry {
  const geo = new ConeGeometry(radius, depth, 28, 6, false);
  const pos = geo.getAttribute("position") as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), z = pos.getZ(i);
    const y = pos.getY(i);
    const t = (y + depth / 2) / depth;
    if (t > 0.02 && t < 0.98) {
      const a = Math.atan2(z, x);
      const bump = Math.sin(a * 3.1 + 1.7) * 0.5 + Math.sin(a * 7.3 + y * 1.9) * 0.35 + Math.sin(y * 4.7 + a) * 0.25;
      const scale = 1 + bump * 0.16 * (0.4 + t);
      x *= scale; z *= scale;
    }
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}
function createTeapotGeometry(k: number): BufferGeometry {
  const n = (v: number, min: number): number => Math.max(min, Math.round(v * k));
  const profile = [[0, 0], [0.34, 0], [0.5, 0.06], [0.58, 0.22], [0.52, 0.42], [0.34, 0.52], [0.16, 0.55], [0.14, 0.6], [0.2, 0.64], [0.1, 0.7], [0, 0.72]];
  const body = new LatheGeometry(profile.map(([x, y]) => new Vector2(x!, y!)), n(24, 12));
  const spout = new CylinderGeometry(0.05, 0.085, 0.5, n(10, 6), 4);
  spout.translate(0, 0.25, 0); spout.rotateZ(-0.7); spout.translate(0.52, 0.28, 0);
  const handle = new TorusGeometry(0.22, 0.045, n(8, 5), n(16, 8), Math.PI);
  handle.rotateZ(Math.PI / 2); handle.rotateY(Math.PI / 2); handle.translate(-0.52, 0.36, 0);
  return mergeGeometries([body, spout, handle]);
}
function createCupGeometry(k: number): BufferGeometry {
  const profile = [[0, 0], [0.16, 0], [0.2, 0.04], [0.23, 0.16], [0.22, 0.22], [0.18, 0.22], [0.19, 0.16], [0.16, 0.06], [0, 0.05]];
  return new LatheGeometry(profile.map(([x, y]) => new Vector2(x!, y!)), Math.max(10, Math.round(20 * k)));
}
/** geometry.js mergeGeometries (positions, normals, uvs, index). */
function mergeGeometries(geos: BufferGeometry[]): BufferGeometry {
  let vCount = 0, iCount = 0;
  for (const g of geos) { const p = g.getAttribute("position") as BufferAttribute; vCount += p.count; iCount += g.index ? g.index.count : p.count; }
  const pos = new Float32Array(vCount * 3), norm = new Float32Array(vCount * 3), uv = new Float32Array(vCount * 2), idx = new Uint32Array(iCount);
  let vOff = 0, iOff = 0;
  for (const g of geos) {
    const p = g.getAttribute("position") as BufferAttribute, nAttr = g.getAttribute("normal") as BufferAttribute | undefined, u = g.getAttribute("uv") as BufferAttribute | undefined;
    for (let i = 0; i < p.count; i++) {
      pos[(vOff + i) * 3] = p.getX(i); pos[(vOff + i) * 3 + 1] = p.getY(i); pos[(vOff + i) * 3 + 2] = p.getZ(i);
      if (nAttr) { norm[(vOff + i) * 3] = nAttr.getX(i); norm[(vOff + i) * 3 + 1] = nAttr.getY(i); norm[(vOff + i) * 3 + 2] = nAttr.getZ(i); }
      if (u) { uv[(vOff + i) * 2] = u.getX(i); uv[(vOff + i) * 2 + 1] = u.getY(i); }
    }
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[iOff + i] = g.index.getX(i) + vOff; iOff += g.index.count; }
    else { for (let i = 0; i < p.count; i++) idx[iOff + i] = vOff + i; iOff += p.count; }
    vOff += p.count;
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(pos, 3));
  out.setAttribute("normal", new BufferAttribute(norm, 3));
  out.setAttribute("uv", new BufferAttribute(uv, 2));
  out.setIndex(new BufferAttribute(idx, 1));
  return out;
}
function createIslandGeometry(r: number): BufferGeometry {
  const top = new SphereGeometry(r, 14, 10);
  top.scale(1, 0.45, 1);
  const pos = top.getAttribute("position") as BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const bump = Math.sin(x * 2.1 + z * 1.3) * 0.08 + Math.sin(z * 3.7) * 0.05;
    pos.setXYZ(i, x * (1 + bump), y, z * (1 + bump));
  }
  top.computeVertexNormals();
  const spike = new ConeGeometry(r * 0.7, r * 1.6, 12, 3);
  spike.rotateX(Math.PI);
  spike.translate(0, -r * 0.75, 0);
  return mergeGeometries([top, spike]);
}
function createRingGeometry(inner: number, outer: number): BufferGeometry {
  const g = new RingGeometry(inner, outer, 40);
  g.rotateX(-Math.PI / 2);
  return g;
}
function createTrayBaseGeometry(slots = 7): BufferGeometry {
  const geo = new ExtrudeGeometry(roundedRectShape(slots * 1.06 + 0.5, 1.35, 0.5), {
    depth: 0.12, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, curveSegments: 8,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}
function createSlotGeometry(): BufferGeometry {
  const geo = new ExtrudeGeometry(roundedRectShape(1, 1, 0.16), { depth: 0.05, bevelEnabled: false, curveSegments: 6 });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

// ---------------------------------------------------------------- materials.js textures
const T = 256;
type Ctx = ReturnType<OffscreenCanvas["getContext"]> & object;
function cellCanvas(px = T): { cv: OffscreenCanvas; ctx: Ctx } {
  const cv = new OffscreenCanvas(px, px);
  const ctx = cv.getContext("2d")! as Ctx;
  if (px !== T) (ctx as unknown as { scale(a: number, b: number): void }).scale(px / T, px / T);
  return { cv, ctx };
}
type C2D = {
  fillStyle: unknown; strokeStyle: unknown; lineWidth: number; globalAlpha: number;
  fillRect(x: number, y: number, w: number, h: number): void; clearRect(x: number, y: number, w: number, h: number): void;
  createRadialGradient(a: number, b: number, c: number, d: number, e: number, f: number): { addColorStop(o: number, c: string): void };
  beginPath(): void; moveTo(x: number, y: number): void; lineTo(x: number, y: number): void; stroke(): void; fill(): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
};
interface TexSet { map: Texture; bumpMap: Texture; color: Color }
/** materials.js buildTileTextures. */
function buildTileTextures(symbolIds: string[], palette: string, px: number): Map<string, TexSet> {
  const out = new Map<string, TexSet>();
  symbolIds.forEach((sym, i) => {
    const col = P.symbolColor(sym, palette);
    const face = cellCanvas(px);
    const f = face.ctx as unknown as C2D;
    const dish = f.createRadialGradient(T / 2, T / 2, T * 0.1, T / 2, T / 2, T * 0.72);
    dish.addColorStop(0, "#ffffff");
    dish.addColorStop(1, "#ece6dc");
    f.fillStyle = dish;
    f.fillRect(0, 0, T, T);
    f.strokeStyle = col;
    f.lineWidth = 6;
    f.globalAlpha = 0.85;
    P.roundRectPath(f, 18, 18, T - 36, T - 36, 34);
    f.stroke();
    f.globalAlpha = 1;
    P.drawNotches(f, i, col);
    f.globalAlpha = 0.55;
    P.drawSymbolGlyph(f, sym, { ink: "#2a1a10", accent: "#2a1a10", x: 3, y: 5 });
    f.globalAlpha = 1;
    P.drawSymbolGlyph(f, sym, { ink: col, accent: col });
    const bump = cellCanvas(px);
    const b = bump.ctx as unknown as C2D;
    b.fillStyle = "#808080";
    b.fillRect(0, 0, T, T);
    b.globalAlpha = 0.9;
    P.drawSymbolGlyph(b, sym, { ink: "#303030", accent: "#303030", x: 3, y: 4 });
    b.globalAlpha = 0.5;
    P.drawSymbolGlyph(b, sym, { ink: "#e0e0e0", accent: "#e0e0e0", x: -2, y: -3 });
    b.globalAlpha = 1;
    const map = new CanvasTexture(face.cv);
    map.colorSpace = SRGBColorSpace;
    map.anisotropy = 4;
    const bumpMap = new CanvasTexture(bump.cv);
    out.set(sym, { map, bumpMap, color: new Color(col) });
  });
  return out;
}
function buildWoodTexture(base: string, dark: string, rand: Stream): CanvasTexture {
  const { cv, ctx: c0 } = cellCanvas();
  const ctx = c0 as unknown as C2D;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, T, T);
  const lines = 46;
  for (let i = 0; i < lines; i++) {
    const y = (i / lines) * T + rand.range(-2, 2);
    ctx.strokeStyle = dark;
    ctx.globalAlpha = rand.range(0.05, 0.22);
    ctx.lineWidth = rand.range(0.6, 2.4);
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= T; x += 16) ctx.lineTo(x, y + Math.sin((x / T) * Math.PI * 2 * rand.range(0.5, 2) + i) * rand.range(1, 4));
    ctx.stroke();
  }
  for (let k = 0; k < 3; k++) {
    const x = rand.range(30, T - 30), y = rand.range(30, T - 30);
    const g = ctx.createRadialGradient(x, y, 1, x, y, rand.range(8, 22));
    g.addColorStop(0, "rgba(0,0,0,0.35)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 1;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, T, T);
  }
  const tex = new CanvasTexture(cv);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
function buildSoftCircleTexture(): CanvasTexture {
  const { cv, ctx: c0 } = cellCanvas();
  const ctx = c0 as unknown as C2D;
  const g = ctx.createRadialGradient(T / 2, T / 2, 1, T / 2, T / 2, T / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, T, T);
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
function buildPetalTexture(color: string): CanvasTexture {
  const { cv, ctx: c0 } = cellCanvas();
  const ctx = c0 as unknown as C2D;
  ctx.clearRect(0, 0, T, T);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(T / 2, T / 2, T * 0.18, T * 0.34, 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.beginPath();
  ctx.ellipse(T / 2 - 12, T / 2 - 16, T * 0.07, T * 0.16, 0.5, 0, Math.PI * 2);
  ctx.fill();
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
const hexStr = (n: number | string): string => typeof n === "string" ? n : "#" + n.toString(16).padStart(6, "0");

// ---------------------------------------------------------------- camera.js
export const CAMERA_ANCHORS: Record<string, { pos: [number, number, number]; look: [number, number, number]; fov: number }> = {
  wide: { pos: [0, 7.6, 9.4], look: [0, 0, -0.4], fov: 38 },
  square: { pos: [0, 8.6, 8.2], look: [0, 0, -0.3], fov: 40 },
  portrait: { pos: [0, 10.8, 6.6], look: [0, -0.2, -0.6], fov: 44 },
  top: { pos: [0, 12.5, 2.2], look: [0, 0, -0.4], fov: 40 },
  low: { pos: [0, 4.2, 10.8], look: [0, 0.6, -0.6], fov: 36 },
  win: { pos: [0, 5.4, 7.0], look: [0, 0.4, 0], fov: 34 },
};
interface Frame { z: number; x: number; y: number }
function dampedSpring(current: number, target: number, velocity: number, omega: number, dt: number): [number, number] {
  const det = 1 + omega * dt * 2 + omega * omega * dt * dt;
  const v = (velocity - omega * omega * dt * (current - target)) / det;
  return [current + v * dt, v];
}
const camera = new PerspectiveCamera(38, 1, 0.1, 200);
const rig = {
  anchor: "wide",
  target: { pos: new Vector3(), look: new Vector3(), fov: 38, frame: { z: 1, x: 0, y: 0 } as Frame },
  current: { pos: new Vector3(), look: new Vector3(), fov: 38, frame: { z: 1, x: 0, y: 0 } as Frame },
  vel: { pos: new Vector3(), look: new Vector3(), fov: 0, frame: { z: 0, x: 0, y: 0 } as Frame },
  applied: { z: 1, x: 0, y: 0 } as Frame,
  omega: 3.2, shakeAmp: 0, shakeTime: 0, shakeSeed: 0,
};
function setAnchor(name: string, frame: Frame | null = null): void {
  const a = CAMERA_ANCHORS[name];
  if (!a) return;
  rig.anchor = name;
  rig.target.pos.fromArray(a.pos);
  rig.target.look.fromArray(a.look);
  rig.target.fov = a.fov;
  rig.target.frame = frame ? { ...frame } : { z: 1, x: 0, y: 0 };
}
function snap(name: string, frame: Frame | null = null): void {
  setAnchor(name, frame);
  rig.current.pos.copy(rig.target.pos);
  rig.current.look.copy(rig.target.look);
  rig.current.fov = rig.target.fov;
  rig.current.frame = { ...rig.target.frame };
  rig.vel.pos.set(0, 0, 0); rig.vel.look.set(0, 0, 0); rig.vel.fov = 0; rig.vel.frame = { z: 0, x: 0, y: 0 };
  rig.applied = { z: -1, x: 0, y: 0 };
  applyRig(0);
}
/** camera.js shake: 0 pick, 1 triple, 2 round end. */
function shake(tier: number): void {
  if (reducedMotion) return;
  rig.shakeAmp = Math.max(rig.shakeAmp, [0.02, 0.05, 0.09][tier] ?? 0.02);
  rig.shakeTime = 0;
}
function springVec(cur: Vector3, tgt: Vector3, vel: Vector3, dt: number): void {
  let v: number;
  [cur.x, v] = dampedSpring(cur.x, tgt.x, vel.x, rig.omega, dt); vel.x = v;
  [cur.y, v] = dampedSpring(cur.y, tgt.y, vel.y, rig.omega, dt); vel.y = v;
  [cur.z, v] = dampedSpring(cur.z, tgt.z, vel.z, rig.omega, dt); vel.z = v;
}
function updateRig(dt: number): void {
  springVec(rig.current.pos, rig.target.pos, rig.vel.pos, dt);
  springVec(rig.current.look, rig.target.look, rig.vel.look, dt);
  [rig.current.fov, rig.vel.fov] = dampedSpring(rig.current.fov, rig.target.fov, rig.vel.fov, rig.omega, dt);
  for (const k of ["z", "x", "y"] as const) {
    [rig.current.frame[k], rig.vel.frame[k]] = dampedSpring(rig.current.frame[k], rig.target.frame[k], rig.vel.frame[k], rig.omega, dt);
  }
  applyRig(dt);
}
const lookTmp = new Vector3();
function applyRig(dt: number): void {
  rig.shakeTime += dt;
  rig.shakeAmp = Math.max(0, rig.shakeAmp - dt * 0.12);
  let ox = 0, oy = 0;
  if (rig.shakeAmp > 0.0005 && !reducedMotion) {
    const t = rig.shakeSeed + rig.shakeTime * 31;
    ox = Math.sin(t * 1.1) * rig.shakeAmp;
    oy = Math.cos(t * 1.7) * rig.shakeAmp * 0.6;
  }
  camera.position.set(rig.current.pos.x + ox, rig.current.pos.y + oy, rig.current.pos.z);
  lookTmp.copy(rig.current.look);
  camera.lookAt(lookTmp);
  const f = rig.current.frame, ap = rig.applied;
  const moved = Math.abs(f.z - ap.z) > 1e-4 || Math.abs(f.x - ap.x) > 1e-5 || Math.abs(f.y - ap.y) > 1e-5;
  if (moved) {
    rig.applied = { ...f };
    if (Math.abs(f.z - 1) < 1e-4 && Math.abs(f.x) < 1e-5 && Math.abs(f.y) < 1e-5) camera.clearViewOffset();
    else {
      const s = 2 / f.z, A = camera.aspect;
      camera.setViewOffset(2 * A, 2, (f.x + 1 - s / 2) * A, 1 - f.y - s / 2, s * A, s);
    }
  }
  if (Math.abs(camera.fov - rig.current.fov) > 0.01) { camera.fov = rig.current.fov; camera.updateProjectionMatrix(); }
}
const probe = new PerspectiveCamera(38, 1, 0.1, 200);
interface Box { x0: number; x1: number; y0: number; y1: number }
function projectBounds(name: string, points: Vector3[], aspect: number): Box {
  const a = CAMERA_ANCHORS[name]!;
  probe.fov = a.fov; probe.aspect = aspect; probe.near = 0.1; probe.far = 200;
  probe.clearViewOffset();
  probe.position.fromArray(a.pos);
  probe.lookAt(new Vector3().fromArray(a.look));
  probe.updateMatrixWorld();
  probe.updateProjectionMatrix();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const v = new Vector3();
  for (const p of points) {
    v.copy(p).project(probe);
    x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
  }
  return { x0, x1, y0, y1 };
}
function frameFor(b: Box, safe: Box): Frame {
  const hx = (b.x1 - b.x0) / 2, hy = (b.y1 - b.y0) / 2, sw = (safe.x1 - safe.x0) / 2, sh = (safe.y1 - safe.y0) / 2;
  if (!(hx > 0 && hy > 0 && sw > 0 && sh > 0)) return { z: 1, x: 0, y: 0 };
  const z = Math.min(3, Math.max(0.3, Math.min(sw / hx, sh / hy)));
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, sx = (safe.x0 + safe.x1) / 2, sy = (safe.y0 + safe.y1) / 2;
  return { z, x: cx - sx / z, y: cy - sy / z };
}
const framed = (b: Box, f: Frame): Box => ({ x0: (b.x0 - f.x) * f.z, x1: (b.x1 - f.x) * f.z, y0: (b.y0 - f.y) * f.z, y1: (b.y1 - f.y) * f.z });
function anchorForAspect(aspect: number, pref: string): string {
  if (pref === "top") return "top";
  if (pref === "low") return "low";
  if (aspect >= 1.25) return "wide";
  if (aspect >= 0.85) return "square";
  return "portrait";
}

// ---------------------------------------------------------------- state
export interface Rect { x: number; y: number; width: number; height: number }
let look: Look | null = null;
let reducedMotion = false;
let palette = "default";
let theme: Theme = Content.THEMES.dawn!;
let time = 0;
let built = false;
let win = { w: 0, h: 0 };
let chrome: Rect[] | null = null;
let cameraPref = "default";
let anchorLocked = false;
let fitGroups: Vector3[][] | null = null;

interface TileRec { mesh: Mesh; home: Vector3; sym: string; exposed: boolean; inTray: boolean; cleared: boolean; own: boolean }
const tiles = new Map<string, TileRec>();
let level: Level | null = null;
let lastState: State | null = null;
let boardOffset = { x: 0, y: 0 };
let tileGeometry: BufferGeometry | null = null;
let tileSegKey = "";
let textureSets = new Map<string, TexSet>();
const materialCache = new Map<string, Material>();
let tileDetail = false;
let tileKey = "";
let fxRand: Stream = Rng.decorStream("fx");
let hovered: string | null = null;
let focused: string | null = null;
type Tween = { t: number; dur: number; fn: (k: number) => void };
const tweens: Tween[] = [];

const EASE = {
  outCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t: number): number => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
  outQuad: (t: number): number => 1 - (1 - t) * (1 - t),
};

// scene objects (built once in build())
const MAX_PETALS = PARTICLES.high.petals * PARTICLE_POOL;
const MAX_MIST = PARTICLES.high.mist * PARTICLE_POOL;
const MAX_STEAM = PARTICLES.high.steam * PARTICLE_POOL;
const BURST_BASE = 140;
const MAX_BURST = BURST_BASE * PARTICLE_POOL;
const MAX_ISLANDS = 6;
const STEAM_ORIGIN = new Vector3(-3.42, 0.95, -2.2);
let keyLight!: DirectionalLight;
let fillLight!: HemisphereLight;
let keyBase = 2.6;
let sky!: Mesh;
let skyUniforms!: { top: { value: Color }; mid: { value: Color }; bottom: { value: Color } };
let table!: Mesh;
let tableMaterial!: Material;
let woodTexture!: Texture;
let grainTexture: Texture | null = null;
let rock!: Mesh;
let teapot!: Mesh;
let cups!: Group;
let islands!: Group;
let clouds!: Group;
let mist!: Points;
let mistSeeds!: Float32Array;
let petals!: InstancedMesh;
let petalData: { x: number; y: number; z: number; phase: number; speed: number; spin: number }[] = [];
let petalMat!: MeshBasicMaterial;
let steam!: Points;
let steamLife!: Float32Array;
let steamSeeds!: Float32Array;
let steamCount = 0;
let mistCount = 0;
let envRoom: Texture | null = null;
let envSimple: Texture | null = null;
let boardGroup!: Group;
let trayGroup!: Group;
let trayBase!: Mesh;
let slotMeshes: Mesh[] = [];
let slotPreview!: Mesh;
let focusRing!: Mesh;
let hintRing!: Mesh;
interface Burst { points: Points; vel: Float32Array; life: number; maxLife: number; active: boolean; count: number }
const bursts: Burst[] = [];
let burstIndex = 0;
let burstCount = MAX_BURST;
let propKind = "";
type Surf = [Record<string, unknown>, Record<string, unknown> | null];

function skyColor(hex: number | string): Color { return new Color(hex).multiplyScalar(0.62); }
function mistColor(t: Theme): Color { return new Color(0xffffff).lerp(new Color(t.fog), 0.35); }

/** scene.js _surface: Lambert (Low), Standard (Balanced), Physical extras (High/Ultra). Colours are always fresh copies. */
function surface(params: Record<string, unknown>, extras: Record<string, unknown> | null): Material {
  const kind = look!.budget.material;
  const p: Record<string, unknown> = { ...params };
  if (p.color !== undefined) p.color = new Color(p.color as number);
  if (kind === "lambert") {
    delete p.roughness; delete p.metalness; delete p.roughnessMap; delete p.envMapIntensity;
    return new MeshLambertMaterial(p);
  }
  if (kind === "physical" && extras) return new MeshPhysicalMaterial({ ...p, ...extras });
  return new MeshStandardMaterial(p);
}

// ---------------------------------------------------------------- building the world (scene.js _initGL / _buildEnvironment)
function build(): void {
  built = true;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.type = PCFSoftShadowMap;
  rig.shakeSeed = 437.1;
  keyLight = new DirectionalLight(0xffe3c0, 2.6);
  keyLight.position.set(6, 10, 4);
  keyLight.shadow.bias = -0.0004;
  keyLight.shadow.normalBias = 0.02;
  keyLight.shadow.radius = 3;
  fitShadowFrustum();
  scene.add(keyLight);
  scene.add(keyLight.target);
  fillLight = new HemisphereLight(0x88a0b9, 0x3a2e28, 0.55);
  scene.add(fillLight);
  scene.add(new AmbientLight(0xffffff, 0.12));

  const t = theme;
  const decor = Rng.decorStream("env");
  skyUniforms = { top: { value: skyColor(t.sky[0]) }, mid: { value: skyColor(t.sky[1]) }, bottom: { value: skyColor(t.sky[2]) } };
  sky = new Mesh(new SphereGeometry(90, 24, 16), new ShaderMaterial({
    side: BackSide, depthWrite: false, fog: false, toneMapped: false, uniforms: skyUniforms,
    fragmentShader: `
fn fragment(f: Fragment) -> vec4f {
  let h = normalize(f.world - camera_position()).y;
  var c = mix(uniforms.mid, uniforms.bottom, smoothstep(0.0, 0.5, -h));
  if (h > 0.0) { c = mix(uniforms.mid, uniforms.top, smoothstep(0.0, 0.6, h)); }
  return vec4f(c, 1.0);
}`,
  }));
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);
  scene.fog = new Fog(t.fog, 22, 70);

  // the cheap image-based fill: a sky sphere and a key-coloured glow card
  const pmrem = new PMREMGenerator(renderer);
  const envScene = new Group();
  const envSky = new Mesh(new SphereGeometry(10, 16, 12), new MeshBasicMaterial({ color: new Color(t.sky[1]), side: BackSide }));
  const envGlow = new Mesh(new PlaneGeometry(6, 3), new MeshBasicMaterial({ color: new Color(t.key.color) }));
  envGlow.position.set(4, 6, -6);
  envGlow.lookAt(new Vector3(0, 0, 0));
  envScene.add(envSky, envGlow);
  try { envSimple = pmrem.fromScene(envScene, 0.04).texture; } catch (e) { console.warn(`environment: ${String(e)}`); }
  pmrem.dispose();
  scene.environment = envSimple;
  new TextureLoader().load("assets/grain.png", (tex) => {
    tex.wrapS = tex.wrapT = RepeatWrapping;
    grainTexture = tex;
    tileKey = "";
    applyDetail();
  }, undefined, (e: unknown) => console.warn(`grain: ${e instanceof Error ? e.message : String(e)}`));

  woodTexture = buildWoodTexture("#8a5a3b", "#5e3a24", decor);
  woodTexture.repeat.set(0.16, 0.16);
  woodTexture.anisotropy = 8;
  table = new Mesh(createTableGeometry(), new MeshBasicMaterial());
  table.receiveShadow = true;
  scene.add(table);

  rock = new Mesh(createRockGeometry(), new MeshBasicMaterial());
  rock.userData.surface = [{ color: 0x5a4a42, roughness: 0.95, flatShading: true }, null] as Surf;
  rock.position.y = -2.6;
  scene.add(rock);

  teapot = new Mesh(createTeapotGeometry(look!.budget.propSeg), new MeshBasicMaterial());
  teapot.userData.surface = [{ color: 0x7a4a3a, roughness: 0.38, metalness: 0.05 }, { clearcoat: 0.6, clearcoatRoughness: 0.2 }] as Surf;
  teapot.position.set(-4.6, 0.02, -2.2);
  teapot.scale.setScalar(1.4);
  teapot.castShadow = true;
  scene.add(teapot);
  const cupSurface: Surf = [{ color: 0xe8dcc8, roughness: 0.35 }, { clearcoat: 0.7, clearcoatRoughness: 0.15 }];
  cups = new Group();
  for (let i = 0; i < 2; i++) {
    const cup = new Mesh(createCupGeometry(look!.budget.propSeg), new MeshBasicMaterial());
    cup.userData.surface = cupSurface;
    cup.position.set(-3.4 + i * 0.8, 0.02, -2.9 + i * 0.35);
    cup.castShadow = true;
    cups.add(cup);
  }
  scene.add(cups);

  islands = new Group();
  const islandSurface: Surf = [{ color: 0x6a7a5e, roughness: 0.9, flatShading: true }, null];
  for (let i = 0; i < MAX_ISLANDS; i++) {
    const isl = new Mesh(createIslandGeometry(decor.range(1.2, 2.4)), new MeshBasicMaterial());
    isl.userData.surface = islandSurface;
    const a = decor.range(0, Math.PI * 2), r = decor.range(16, 30);
    isl.position.set(Math.cos(a) * r, decor.range(-4, 3), Math.sin(a) * r - 8);
    isl.userData.bobPhase = decor.range(0, Math.PI * 2);
    islands.add(isl);
  }
  scene.add(islands);

  const cloudMat = new MeshBasicMaterial({ color: new Color(0xffffff), transparent: true, opacity: 0.16, depthWrite: false });
  clouds = new Group();
  const ps = look!.budget.propSeg;
  for (let i = 0; i < 4; i++) {
    const puff = new Mesh(new SphereGeometry(decor.range(2, 4), Math.max(6, Math.round(10 * ps)), Math.max(5, Math.round(8 * ps))), cloudMat);
    puff.scale.y = 0.35;
    puff.position.set(decor.range(-30, 30), decor.range(6, 12), decor.range(-34, -16));
    puff.userData.speed = decor.range(0.05, 0.16);
    clouds.add(puff);
  }
  scene.add(clouds);

  const mistGeo = new BufferGeometry();
  const mp = new Float32Array(MAX_MIST * 3);
  mistSeeds = new Float32Array(MAX_MIST * 2);
  for (let i = 0; i < MAX_MIST; i++) {
    const a = decor.range(0, Math.PI * 2), r = decor.range(4, 10);
    mp[i * 3] = Math.cos(a) * r; mp[i * 3 + 1] = decor.range(-4.5, -1); mp[i * 3 + 2] = Math.sin(a) * r;
    mistSeeds[i * 2] = decor.range(0, Math.PI * 2); mistSeeds[i * 2 + 1] = decor.range(0.1, 0.5);
  }
  mistGeo.setAttribute("position", new BufferAttribute(mp, 3));
  const soft = buildSoftCircleTexture();
  mist = new Points(mistGeo, new PointsMaterial({ map: soft, color: mistColor(t), size: 2.4, transparent: true, opacity: 0.12, depthWrite: false, sizeAttenuation: true }));
  scene.add(mist);

  petalMat = new MeshBasicMaterial({ map: buildPetalTexture("#e8a4b8"), transparent: true, alphaTest: 0.1, side: DoubleSide, depthWrite: false });
  petals = new InstancedMesh(new PlaneGeometry(0.22, 0.22), petalMat, MAX_PETALS);
  petalData = [];
  for (let i = 0; i < MAX_PETALS; i++) {
    petalData.push({ x: decor.range(-14, 14), y: decor.range(0, 10), z: decor.range(-14, 10), phase: decor.range(0, Math.PI * 2), speed: decor.range(0.15, 0.5), spin: decor.range(0.4, 1.6) });
  }
  scene.add(petals);

  const steamGeo = new BufferGeometry();
  steamLife = new Float32Array(MAX_STEAM);
  steamSeeds = new Float32Array(MAX_STEAM * 2);
  for (let i = 0; i < MAX_STEAM; i++) {
    steamLife[i] = i / MAX_STEAM;
    steamSeeds[i * 2] = decor.range(0, Math.PI * 2); steamSeeds[i * 2 + 1] = decor.range(0.7, 1.3);
  }
  steamGeo.setAttribute("position", new BufferAttribute(new Float32Array(MAX_STEAM * 3), 3));
  steamGeo.setAttribute("color", new BufferAttribute(new Float32Array(MAX_STEAM * 3), 3));
  steam = new Points(steamGeo, new PointsMaterial({ map: soft, size: 0.3, vertexColors: true, transparent: true, depthWrite: false, blending: AdditiveBlending, sizeAttenuation: true }));
  steam.frustumCulled = false;
  scene.add(steam);

  boardGroup = new Group();
  boardGroup.position.set(0, 0.02, -0.55);
  scene.add(boardGroup);
  trayGroup = new Group();
  scene.add(trayGroup);
  buildTray();
  focusRing = new Mesh(createRingGeometry(0.56, 0.7), new MeshBasicMaterial({ color: new Color(0xfff0c8), transparent: true, opacity: 0, depthWrite: false }));
  scene.add(focusRing);
  hintRing = new Mesh(createRingGeometry(0.6, 0.74), new MeshBasicMaterial({ color: new Color(0x8ad0ff), transparent: true, opacity: 0, depthWrite: false }));
  scene.add(hintRing);
  for (let b = 0; b < 4; b++) {
    const geo = new BufferGeometry();
    geo.setAttribute("position", new BufferAttribute(new Float32Array(MAX_BURST * 3), 3));
    geo.setAttribute("color", new BufferAttribute(new Float32Array(MAX_BURST * 3), 3));
    const points = new Points(geo, new PointsMaterial({ size: 0.16, map: soft, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: AdditiveBlending }));
    points.visible = false;
    points.frustumCulled = false;
    scene.add(points);
    bursts.push({ points, vel: new Float32Array(MAX_BURST * 3), life: 0, maxLife: 1, active: false, count: MAX_BURST });
  }
  snap("wide");
  renderer.camera = camera;
  setTheme(theme.id, true);
}
function buildTray(): void {
  trayBase = new Mesh(createTrayBaseGeometry(7), new MeshStandardMaterial({ color: new Color(theme.tableTrim), roughness: 0.6 }));
  trayBase.position.set(0, 0.03, 3.65);
  trayBase.receiveShadow = true;
  trayGroup.add(trayBase);
  const slotGeo = createSlotGeometry();
  const slotMat = new MeshStandardMaterial({ color: new Color(0x000000), roughness: 0.9, transparent: true, opacity: 0.24 });
  slotMeshes = [];
  for (let i = 0; i < 7; i++) {
    const slot = new Mesh(slotGeo, slotMat);
    slot.position.set(slotX(i), 0.1, 3.65);
    trayGroup.add(slot);
    slotMeshes.push(slot);
  }
  slotPreview = new Mesh(createRingGeometry(0.42, 0.54), new MeshBasicMaterial({ color: new Color(0x7ac88a), transparent: true, opacity: 0, depthWrite: false }));
  slotPreview.position.y = 0.16;
  trayGroup.add(slotPreview);
}
const slotX = (i: number, cap = 7): number => (i - (cap - 1) / 2) * 1.06;
function slotWorld(i: number, cap: number, out = new Vector3()): Vector3 { return out.set(slotX(i, cap), 0.24, 3.65); }

/** scene.js _fitShadowFrustum: the key light's orthographic shadow box around the table, tray and props. */
function fitShadowFrustum(): void {
  const dir = keyLight.position.clone().normalize();
  keyLight.target.position.set(0, 0, 0);
  keyLight.position.copy(dir.clone().multiplyScalar(14));
  keyLight.updateMatrixWorld();
  keyLight.target.updateMatrixWorld();
  const view = new Matrix4().lookAt(keyLight.position, keyLight.target.position, new Vector3(0, 1, 0));
  view.setPosition(keyLight.position);
  const inv = view.clone().invert();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const p = new Vector3();
  for (const x of [-6.6, 6.6]) for (const y of [-0.7, 2.2]) for (const z of [-4.8, 4.8]) {
    p.set(x, y, z).applyMatrix4(inv);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const cam = keyLight.shadow.camera as unknown as { left: number; right: number; top: number; bottom: number; near: number; far: number; updateProjectionMatrix(): void };
  Object.assign(cam, { left: minX, right: maxX, top: maxY, bottom: minY, near: -maxZ - 0.5, far: -minZ + 0.5 });
  cam.updateProjectionMatrix();
}

// ---------------------------------------------------------------- the look (scene.js _applyGraphics)
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  if (!built) build();
  const g = look;
  renderer.shadowMap.enabled = g.shadows > 0;
  keyLight.castShadow = g.shadows > 0;
  if (g.shadows > 0) keyLight.shadow.mapSize = g.shadows;
  if (g.reflections) {
    if (!envRoom) {
      try {
        const pmrem = new PMREMGenerator(renderer);
        envRoom = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
        pmrem.dispose();
      } catch (e) { console.warn(`environment: ${String(e)}`); }
    }
    scene.environment = envRoom;
    scene.environmentIntensity = 0.35;
  } else {
    scene.environment = envSimple;
    scene.environmentIntensity = 1;
  }
  const pc = particleCounts(g);
  petals.count = Math.min(MAX_PETALS, pc.petals);
  mistCount = Math.min(MAX_MIST, pc.mist);
  mist.geometry.setDrawRange(0, mistCount);
  steamCount = Math.min(MAX_STEAM, pc.steam);
  steam.geometry.setDrawRange(0, steamCount);
  steam.visible = steamCount > 0;
  burstCount = Math.min(MAX_BURST, Math.round(BURST_BASE * pc.burst));
  const segKey = String(g.budget.tileSeg);
  if (tileSegKey !== segKey) {
    tileSegKey = segKey;
    const old = tileGeometry;
    tileGeometry = createTileGeometry(g.budget.tileSeg);
    for (const [, rec] of tiles) rec.mesh.geometry = tileGeometry;
    old?.dispose();
  }
  applyPropMaterials();
  islands.children.forEach((isl, i) => { isl.visible = i < (g.detailed ? MAX_ISLANDS : 2); });
  applyDetail();
  // post: GTAO (radius 0.45, distance exponent 1.6, thickness 1.2), UnrealBloom (0.4, 0.4, 1.25), the grade, AA
  renderer.ao = g.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.45, distanceExponent: 1.6, thickness: 1.2, scale: 1, samples: g.ao === "high" ? 16 : 8, resolution: g.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === "high" ? 6 : 4, rings: 2, samples: g.ao === "high" ? 16 : 8 },
  };
  // r164 page: r160 UnrealBloom at the page's strength
  renderer.bloom = g.bloom ? { model: "r160", strength: 0.4, radius: 0.4, threshold: 1.25, resolution: g.budget.bloomRes } : null;
  // GradeShader before OutputPass (linear light): an 0.18 S-curve, saturation 1.07, cool shadows / warm highlights by a
  // smoothstep of luma 0.2–0.8, over-range light kept (mix(c, s + max(c - 1, 0), amount)), a 0.24 vignette from 0.42
  // to 0.9 (x × 1.1)
  renderer.grade = g.grade ? {
    space: "linear", overRange: "keep", contrast: 0.18, saturation: 1.07, split: [0.2, 0.8], shadows: [0.97, 0.99, 1.04], highlights: [1.03, 1.0, 0.97],
    vignette: { amount: 0.24, inner: 0.42, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = g.antialias;
}
function applyDetail(): void {
  if (!look || !built) return;
  const detailed = look.detailed;
  const tm = tableMaterial as MeshStandardMaterial;
  if (tm && "bumpMap" in tm) {
    tm.bumpMap = detailed ? woodTexture : null;
    tm.bumpScale = 2.2;
    tm.roughnessMap = detailed ? grainTexture : null;
  }
  const key = look.budget.material + "|" + look.budget.texture + "|" + (grainTexture ? 1 : 0);
  if (tileDetail !== detailed || tileKey !== key) {
    tileDetail = detailed;
    tileKey = key;
    rebuildTileMaterials();
  }
}
function applyPropMaterials(): void {
  const kind = look!.budget.material;
  if (propKind === kind) return;
  propKind = kind;
  const made = new Map<unknown, Material>();
  for (const mesh of [rock, teapot, ...cups.children, ...islands.children] as Mesh[]) {
    const spec = mesh.userData.surface as Surf | undefined;
    if (!spec) continue;
    if (!made.has(spec)) made.set(spec, surface(spec[0], spec[1]));
    (mesh.material as Material).dispose();
    mesh.material = made.get(spec)!;
  }
  const old = tableMaterial;
  tableMaterial = surface({ map: woodTexture, roughness: 0.62, metalness: 0.05 }, null);
  table.material = tableMaterial;
  old?.dispose();
}

// ---------------------------------------------------------------- themes, settings
export function setTheme(id: string, force = false): void {
  const t = Content.THEMES[id];
  if (!t || (!force && t === theme)) return;
  theme = t;
  if (!built) return;
  skyUniforms.top.value = skyColor(t.sky[0]);
  skyUniforms.mid.value = skyColor(t.sky[1]);
  skyUniforms.bottom.value = skyColor(t.sky[2]);
  (scene.fog as Fog).color = new Color(t.fog);
  mist.material.color = mistColor(t);
  keyLight.color = new Color(t.key.color);
  keyLight.intensity = t.key.intensity;
  keyBase = t.key.intensity;
  fillLight.color = new Color(t.fill.color);
  fillLight.intensity = t.fill.intensity;
  (trayBase.material as MeshStandardMaterial).color = new Color(t.tableTrim);
  petalMat.map?.dispose();
  petalMat.map = buildPetalTexture(hexStr(t.petal));
  rebuildTileMaterials();
  if (lastState) updateTraySlots(lastState);
}
export function setReducedMotion(v: boolean): void { reducedMotion = v; }
export function setPalette(p: string): void {
  if (p === palette) return;
  palette = p;
  rebuildTileMaterials();
}
export function setCameraPreference(pref: string): void {
  cameraPref = pref;
  anchorLocked = false;
  aim(anchorForAspect(camera.aspect, pref));
}
export function resetCamera(): void {
  anchorLocked = false;
  aim(anchorForAspect(camera.aspect, cameraPref));
}
/** Window size and the HUD rectangles covering the play view (null off the play screen). */
export function setView(w: number, h: number, parts: Rect[] | null): void {
  const sameParts = JSON.stringify(parts) === JSON.stringify(chrome);
  if (w === win.w && h === win.h && sameParts) return;
  win = { w, h };
  chrome = parts;
  if (!built || w < 2 || h < 2) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  rig.applied = { z: -1, x: 0, y: 0 };
  const anchor = anchorForAspect(w / h, cameraPref);
  aim(anchor !== rig.anchor && !anchorLocked ? anchor : rig.anchor);
}
function aim(name: string): void { setAnchor(name, frameForAnchor(name)); }

/** scene.js _frameFor: board + tray fill the window left free by the HUD. */
function frameForAnchor(name: string): Frame | null {
  if (!chrome || !fitGroups || name === "win") return null;
  const W = win.w, H = win.h;
  const groups = fitGroups.map((g) => projectBounds(name, g, camera.aspect));
  const all = groups.reduce((u, b) => ({ x0: Math.min(u.x0, b.x0), x1: Math.max(u.x1, b.x1), y0: Math.min(u.y0, b.y0), y1: Math.max(u.y1, b.y1) }));
  const ins = { t: 0, b: 0, l: 0, r: 0 };
  const pieces: Box[] = [];
  for (const r of chrome) {
    const p = { x0: Math.max(0, r.x), x1: Math.min(W, r.x + r.width), y0: Math.max(0, r.y), y1: Math.min(H, r.y + r.height) };
    if (p.x1 - p.x0 < 1 || p.y1 - p.y0 < 1) continue;
    if (p.x1 - p.x0 > W * 0.5) inset(ins, p, W, H, "v");
    else if (p.y1 - p.y0 > H * 0.5) inset(ins, p, W, H, "h");
    else pieces.push(p);
  }
  const m = Math.round(Math.min(W, H) * 0.025);
  const toNdc = (r: Box): Box => ({ x0: (2 * r.x0) / W - 1, x1: (2 * r.x1) / W - 1, y0: 1 - (2 * r.y1) / H, y1: 1 - (2 * r.y0) / H });
  let frame: Frame | null = null;
  for (let pass = 0, passes = pieces.length; pass <= passes; pass++) {
    const x0 = ins.l + m, x1 = W - ins.r - m, y0 = ins.t + m, y1 = H - ins.b - m;
    if (x1 - x0 < W * 0.3 || y1 - y0 < H * 0.3) return frame;
    frame = frameFor(all, toNdc({ x0, x1, y0, y1 }));
    const f = frame;
    const hit = pieces.find((p) => {
      const q = toNdc(p);
      return groups.some((g) => { const s = framed(g, f); return s.x0 < q.x1 && s.x1 > q.x0 && s.y0 < q.y1 && s.y1 > q.y0; });
    });
    if (!hit) return frame;
    pieces.splice(pieces.indexOf(hit), 1);
    const midX = (hit.x0 + hit.x1) / 2, midY = (hit.y0 + hit.y1) / 2;
    const costV = (midY < H / 2 ? hit.y1 : H - hit.y0) / H;
    const costH = (midX < W / 2 ? hit.x1 : W - hit.x0) / W;
    inset(ins, hit, W, H, costV <= costH ? "v" : "h");
  }
  return frame;
}
function inset(ins: { t: number; b: number; l: number; r: number }, p: Box, W: number, H: number, axis: "v" | "h"): void {
  if (axis === "v") {
    if ((p.y0 + p.y1) / 2 < H / 2) ins.t = Math.max(ins.t, p.y1);
    else ins.b = Math.max(ins.b, H - p.y0);
  } else if ((p.x0 + p.x1) / 2 < W / 2) ins.l = Math.max(ins.l, p.x1);
  else ins.r = Math.max(ins.r, W - p.x0);
}
function computeFitBox(lv: Level): void {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
  const half = TILE_SIZE / 2 + 0.05;
  const bz = boardGroup.position.z;
  for (const t of lv.tiles) {
    const x = t.gx / 2 - boardOffset.x, z = t.gy / 2 - boardOffset.y + bz;
    x0 = Math.min(x0, x - half); x1 = Math.max(x1, x + half); z0 = Math.min(z0, z - half); z1 = Math.max(z1, z + half);
    top = Math.max(top, 0.05 + t.z * LAYER_HEIGHT + TILE_THICK);
  }
  const pad = 0.25;
  const box = (ax: number, bx: number, ay: number, by: number, az: number, bz2: number): Vector3[] => {
    const out: Vector3[] = [];
    for (const x of [ax - pad, bx + pad]) for (const y of [ay, by]) for (const z of [az - pad, bz2 + pad]) out.push(new Vector3(x, y, z));
    return out;
  };
  const tw = (7 * 1.06 + 0.5) / 2 + 0.06;
  fitGroups = [box(x0, x1, 0, top + 0.35, z0, z1), box(-tw, tw, 0, 0.6, 3.65 - 0.74, 3.65 + 0.74)];
}

// ---------------------------------------------------------------- the board
function rebuildTileMaterials(): void {
  if (!level || !look) return;
  for (const s of textureSets.values()) { s.map.dispose(); s.bumpMap.dispose(); }
  materialCache.forEach((m) => m.dispose());
  materialCache.clear();
  textureSets = buildTileTextures(level.symbolIds, palette, look.budget.texture);
  for (const [, rec] of tiles) {
    if (rec.own) { (rec.mesh.material as Material).dispose(); rec.own = false; }
    rec.mesh.material = materialFor(rec.sym, rec.exposed);
  }
  if (hovered) { const h = hovered; hovered = null; setHover(h); }
}
function materialFor(sym: string, exposed: boolean): Material {
  const key = sym + (exposed ? ":lit" : ":dim");
  const cached = materialCache.get(key);
  if (cached) return cached;
  const set = textureSets.get(sym);
  const color = new Color(exposed ? theme.tile : 0x9a8f7c);
  const kind = look!.budget.material;
  const base = { color, map: set?.map ?? null, bumpMap: set?.bumpMap ?? null, bumpScale: 1.4, roughness: 0.55, metalness: 0.04, emissive: new Color(0x000000) };
  const mat = kind === "lambert"
    ? new MeshLambertMaterial({ color, map: base.map, bumpMap: base.bumpMap, bumpScale: 1.4, emissive: new Color(0x000000) })
    : tileDetail && kind === "physical"
      ? new MeshPhysicalMaterial({ ...base, roughness: 0.5, roughnessMap: grainTexture, clearcoat: exposed ? 0.55 : 0.2, clearcoatRoughness: 0.28 })
      : new MeshStandardMaterial(base);
  materialCache.set(key, mat);
  return mat;
}
/** scene.js buildBoard. */
export function buildBoard(lv: Level, state: State): void {
  if (!built) return;
  level = lv;
  fxRand = Rng.decorStream(lv.seed + ":fx");
  for (const [, rec] of tiles) { boardGroup.remove(rec.mesh); if (rec.own) (rec.mesh.material as Material).dispose(); }
  tiles.clear();
  tweens.length = 0;
  hovered = null;
  focused = null;
  focusRing.material && ((focusRing.material as MeshBasicMaterial).opacity = 0);
  (hintRing.material as MeshBasicMaterial).opacity = 0;
  (slotPreview.material as MeshBasicMaterial).opacity = 0;
  anchorLocked = false;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const t of lv.tiles) { minX = Math.min(minX, t.gx); maxX = Math.max(maxX, t.gx); minY = Math.min(minY, t.gy); maxY = Math.max(maxY, t.gy); }
  boardOffset = { x: (minX + maxX) / 4, y: (minY + maxY) / 4 };
  textureSets = new Map();
  computeFitBox(lv);
  for (const t of lv.tiles) {
    const mesh = new Mesh(tileGeometry!, new MeshBasicMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const home = new Vector3(t.gx / 2 - boardOffset.x, 0.03 + t.z * LAYER_HEIGHT + TILE_THICK / 2, t.gy / 2 - boardOffset.y);
    mesh.position.copy(home);
    mesh.userData.tileId = t.id;
    boardGroup.add(mesh);
    tiles.set(t.id, { mesh, home, sym: t.sym, exposed: true, inTray: false, cleared: false, own: false });
  }
  rebuildTileMaterials();
  reconcile(state, true);
  resetCamera();
}
/** Off the play screen: no board (the title shows the bare table). */
export function clearBoard(): void {
  for (const [, rec] of tiles) { boardGroup.remove(rec.mesh); if (rec.own) (rec.mesh.material as Material).dispose(); }
  tiles.clear();
  tweens.length = 0;
  level = null;
  lastState = null;
  fitGroups = null;
  hovered = null;
  focused = null;
  if (built) {
    (focusRing.material as MeshBasicMaterial).opacity = 0;
    (hintRing.material as MeshBasicMaterial).opacity = 0;
    (slotPreview.material as MeshBasicMaterial).opacity = 0;
    const empty = { tray: [], trayCapacity: 7 } as unknown as State;
    updateTraySlots(empty);
    anchorLocked = false;
    resetCamera();
  }
}
const tmp = new Vector3();
function reconcile(state: State, instant: boolean): void {
  lastState = state;
  const { exposed } = Engine.computeExposure(state);
  const exposedSet = new Set(exposed);
  const onBoard = new Set(state.tiles.map((t) => t.id));
  const inTray = new Map(state.tray.map((e, i) => [e.id, i]));
  for (const [id, rec] of tiles) {
    const was = rec.exposed;
    rec.exposed = exposedSet.has(id);
    rec.inTray = inTray.has(id);
    rec.cleared = !onBoard.has(id) && !inTray.has(id);
    if (rec.cleared) { rec.mesh.visible = false; continue; }
    rec.mesh.visible = true;
    const want = materialFor(rec.sym, rec.exposed);
    if (!rec.own && rec.mesh.material !== want) rec.mesh.material = want;
    if (rec.own && !rec.exposed) { (rec.mesh.material as Material).dispose(); rec.own = false; rec.mesh.material = want; }
    if (instant) {
      if (rec.inTray) {
        slotWorld(inTray.get(id)!, state.trayCapacity, tmp);
        boardGroup.worldToLocal(tmp);
        rec.mesh.position.copy(tmp);
        rec.mesh.rotation.set(0, 0, 0);
        rec.mesh.scale.setScalar(0.94);
      } else {
        rec.mesh.position.copy(rec.home);
        rec.mesh.scale.setScalar(1);
      }
    }
    if (was !== rec.exposed && !instant) tween(rec.mesh.position, { y: rec.inTray ? rec.mesh.position.y : rec.home.y }, 0.18, EASE.outQuad);
  }
  updateTraySlots(state);
}
function updateTraySlots(state: State): void {
  for (let i = 0; i < slotMeshes.length; i++) slotMeshes[i]!.visible = i < state.trayCapacity;
  const fullness = state.tray.length / state.trayCapacity;
  const c = new Color(theme.tableTrim);
  if (fullness >= 0.85) c.lerp(new Color(0xb04030), 0.55);
  else if (fullness >= 0.6) c.lerp(new Color(0xb08030), 0.35);
  (trayBase.material as MeshStandardMaterial).color = c;
}

// ---------------------------------------------------------------- events
/** scene.js applyEvents. */
export function applyEvents(events: RulesEvent[], state: State): void {
  if (!built) return;
  for (const ev of events) {
    switch (ev.type) {
      case "pick": { const rec = tiles.get(ev.tileId!); if (rec) flyToTray(rec, ev.insertAt ?? 0, state); break; }
      case "triple": tripleBurst(ev, state); break;
      case "invalid": if (ev.tileId) invalidWiggle(ev.tileId); break;
      case "undo": reconcile(state, true); break;
      case "win":
        anchorLocked = true;
        setAnchor("win");
        shake(2);
        spawnBurst(new Vector3(0, 1, -0.5), new Color(0xffe9a8), 2);
        spawnBurst(new Vector3(0, 0.4, 3.4), new Color(theme.petal), 1.5);
        break;
      case "lose": anchorLocked = true; aim("top"); shake(1); break;
    }
  }
  reconcile(state, false);
}
function flyToTray(rec: TileRec, insertAt: number, state: State): void {
  if (rec.own) { (rec.mesh.material as Material).dispose(); rec.own = false; rec.mesh.material = materialFor(rec.sym, rec.exposed); }
  if (hovered && tiles.get(hovered) === rec) { hovered = null; (slotPreview.material as MeshBasicMaterial).opacity = 0; }
  const target = slotWorld(insertAt, state.trayCapacity, new Vector3());
  boardGroup.worldToLocal(target);
  const mesh = rec.mesh;
  const from = mesh.position.clone();
  const dur = reducedMotion ? 0.08 : 0.3, arcH = reducedMotion ? 0.1 : 1.4;
  tweens.push({ t: 0, dur, fn: (t) => {
    const e = EASE.inOutCubic(t);
    mesh.position.copy(from).lerp(target, e);
    mesh.position.y += Math.sin(e * Math.PI) * arcH;
    mesh.scale.setScalar(1 - 0.06 * e);
  } });
  shake(0);
}
function tripleBurst(ev: RulesEvent, state: State): void {
  const midSlot = Math.min(state.tray.length, state.trayCapacity - 1);
  const origin = slotWorld(Math.max(0, midSlot - 1), state.trayCapacity, new Vector3());
  origin.y += 0.3;
  const set = textureSets.get(ev.sym ?? "");
  const color = set ? set.color.clone() : new Color(0xffe9a8);
  spawnBurst(origin, color, (ev.chain ?? 1) >= 2 ? 1.5 : 1);
  shake((ev.chain ?? 1) >= 2 ? 2 : 1);
  spawnPulse(origin, set ? set.color.clone() : new Color(0xffffff));
  for (const id of ev.tileIds ?? []) {
    const rec = tiles.get(id);
    if (!rec) continue;
    const m = rec.mesh, s0 = m.scale.x;
    tweens.push({ t: 0, dur: reducedMotion ? 0.05 : 0.25, fn: (t) => m.scale.setScalar(Math.max(0.001, s0 * (1 - EASE.outBack(t)))) });
  }
}
function invalidWiggle(id: string): void {
  const rec = tiles.get(id);
  if (!rec) return;
  const mesh = rec.mesh, x0 = mesh.position.x;
  tweens.push({ t: 0, dur: reducedMotion ? 0.06 : 0.32, fn: (t) => { mesh.position.x = x0 + Math.sin(t * Math.PI * 6) * 0.05 * (1 - t); } });
}
function tween(v: Vector3, to: { y: number }, dur: number, ease: (k: number) => number): void {
  const fy = v.y;
  tweens.push({ t: 0, dur: Math.max(dur, 0.001), fn: (k) => { v.y = fy + (to.y - fy) * ease(k); } });
}
function spawnBurst(origin: Vector3, color: Color, power: number): void {
  const b = bursts[burstIndex++ % bursts.length]!;
  const pos = b.points.geometry.getAttribute("position") as BufferAttribute, col = b.points.geometry.getAttribute("color") as BufferAttribute;
  b.count = burstCount;
  b.points.geometry.setDrawRange(0, b.count);
  for (let i = 0; i < b.count; i++) {
    pos.setXYZ(i, origin.x, origin.y, origin.z);
    const a = fxRand.range(0, Math.PI * 2), up = fxRand.range(1.2, 3.6) * power, out = fxRand.range(0.4, 2) * power;
    b.vel[i * 3] = Math.cos(a) * out; b.vel[i * 3 + 1] = up; b.vel[i * 3 + 2] = Math.sin(a) * out;
    const shade = fxRand.range(0.75, 1);
    col.setXYZ(i, color.r * shade, color.g * shade, color.b * shade);
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  b.life = 0;
  b.maxLife = reducedMotion ? 0.4 : 1.1;
  b.active = true;
  b.points.visible = true;
}
function spawnPulse(origin: Vector3, color: Color): void {
  const mat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false });
  const ring = new Mesh(focusRing.geometry, mat);
  ring.position.copy(origin);
  ring.position.y = Math.max(0.2, origin.y - 0.2);
  scene.add(ring);
  tweens.push({ t: 0, dur: reducedMotion ? 0.25 : 0.6, fn: (t) => {
    ring.scale.setScalar(1 + t * 2.2);
    mat.opacity = 0.85 * (1 - t);
    if (t >= 1) { scene.remove(ring); mat.dispose(); }
  } });
}

// ---------------------------------------------------------------- hover, focus, hints, picking
const raycaster = new Raycaster();
const ndc = new Vector2();
/** scene.js pickTile: the exposed board tile under a window point, or null. */
export function pickTile(x: number, y: number): string | null {
  if (!built || !level) return null;
  pointerToNdc(x, y, ndc);
  camera.updateMatrixWorld();
  raycaster.setFromCamera(ndc, camera);
  const pick: Mesh[] = [];
  for (const [, rec] of tiles) if (rec.exposed && !rec.inTray && !rec.cleared && rec.mesh.visible) pick.push(rec.mesh);
  const hits = raycaster.intersectObjects(pick, false);
  return hits.length ? (hits[0]!.object.userData.tileId as string) : null;
}
export function hoveredTile(): string | null { return hovered; }
export function setHover(id: string | null): void {
  if (hovered === id) return;
  if (hovered) setLift(hovered, false);
  hovered = id;
  if (id) { setLift(id, true); showTrayPreview(id); }
  else if (built) (slotPreview.material as MeshBasicMaterial).opacity = 0;
}
function setLift(id: string, on: boolean): void {
  const rec = tiles.get(id);
  if (!rec || rec.inTray || rec.cleared) return;
  if (on) {
    if (!rec.own) { rec.mesh.material = (rec.mesh.material as Material).clone(); rec.own = true; }
    const m = rec.mesh.material as MeshStandardMaterial;
    m.emissive = new Color(0x2a2410);
  } else if (rec.own) {
    (rec.mesh.material as Material).dispose();
    rec.mesh.material = materialFor(rec.sym, rec.exposed);
    rec.own = false;
  }
  tween(rec.mesh.position, { y: rec.home.y + (on ? 0.14 : 0) }, 0.12, EASE.outQuad);
}
function showTrayPreview(id: string): void {
  if (!lastState) return;
  const proj = Engine.projectSelect(lastState, id);
  if (!proj) return;
  const i = Math.min(proj.insertAt, lastState.trayCapacity - 1);
  slotWorld(i, lastState.trayCapacity, tmp);
  slotPreview.position.set(tmp.x, 0.16, tmp.z);
  const m = slotPreview.material as MeshBasicMaterial;
  m.color = new Color(proj.wouldClear ? 0x7ac88a : proj.trayAfter >= lastState.trayCapacity ? 0xd05a4a : 0xffe9a8);
  m.opacity = 0.9;
}
export function setFocus(id: string | null): void {
  focused = id;
  if (!built) return;
  const m = focusRing.material as MeshBasicMaterial;
  if (!id) { m.opacity = 0; return; }
  const rec = tiles.get(id);
  if (!rec) return;
  focusRing.position.set(rec.mesh.position.x + boardGroup.position.x, 0.12, rec.mesh.position.z + boardGroup.position.z);
  m.opacity = 0.85;
}
export function focusedTile(): string | null { return focused; }
export function showHint(id: string): void {
  const rec = tiles.get(id);
  if (!rec) return;
  hintRing.position.set(rec.mesh.position.x + boardGroup.position.x, 0.13, rec.mesh.position.z + boardGroup.position.z);
  const m = hintRing.material as MeshBasicMaterial;
  tweens.push({ t: 0, dur: reducedMotion ? 0.6 : 1.8, fn: (t) => {
    const pulse = Math.sin(t * Math.PI * 3);
    m.opacity = t >= 1 ? 0 : 0.9 * (1 - t) * (0.6 + 0.4 * pulse);
    hintRing.scale.setScalar(1 + 0.15 * pulse);
  } });
}
/** A tile's window rectangle (its top face projected), for the screen-reader targets over the table. */
export function tileRect(id: string): Rect | null {
  const rec = tiles.get(id);
  if (!rec || !rec.mesh.visible || !level) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  const h = TILE_SIZE / 2;
  for (const [dx, dz] of [[-h, -h], [h, -h], [-h, h], [h, h]] as const) {
    tmp.set(rec.mesh.position.x + dx, rec.mesh.position.y + TILE_THICK / 2, rec.mesh.position.z + dz);
    boardGroup.localToWorld(tmp);
    tmp.project(camera);
    if (tmp.z > 1) return null;
    const x = (tmp.x * 0.5 + 0.5) * win.w, y = (-tmp.y * 0.5 + 0.5) * win.h;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  // the inner half: clear of the neighbours and of tiles stacked over the edges
  const w = x1 - x0, hh = y1 - y0;
  return { x: x0 + w * 0.25, y: y0 + hh * 0.25, width: w * 0.5, height: hh * 0.5 };
}

// ---------------------------------------------------------------- frame
const petalM = new Matrix4(), petalQ = new Quaternion(), petalE = new Euler(), v1 = new Vector3(), v2 = new Vector3(1, 1, 1);
let ambientPosed = false;
/** scene.js render(dt): the rig, tweens, bursts and the ambient motion. */
export function update(dtSec: number): void {
  if (!built) return;
  const dt = Math.min(dtSec, 0.1);
  time += dt;
  updateRig(dt);
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]!;
    tw.t += dt;
    const k = Math.min(tw.t / tw.dur, 1);
    tw.fn(k);
    if (k >= 1) tweens.splice(tweens.indexOf(tw), 1);
  }
  const fm = focusRing.material as MeshBasicMaterial;
  if (fm.opacity > 0) {
    fm.opacity = 0.7 + Math.sin(time * 4) * 0.15;
    if (focused) { const rec = tiles.get(focused); if (rec) focusRing.position.set(rec.mesh.position.x + boardGroup.position.x, 0.12, rec.mesh.position.z + boardGroup.position.z); }
  }
  for (const b of bursts) {
    if (!b.active) continue;
    b.life += dt;
    if (b.life >= b.maxLife) { b.active = false; b.points.visible = false; continue; }
    const pos = b.points.geometry.getAttribute("position") as BufferAttribute;
    for (let i = 0; i < b.count; i++) {
      b.vel[i * 3 + 1] -= 4.4 * dt;
      pos.setXYZ(i, pos.getX(i) + b.vel[i * 3]! * dt, pos.getY(i) + b.vel[i * 3 + 1]! * dt, pos.getZ(i) + b.vel[i * 3 + 2]! * dt);
    }
    pos.needsUpdate = true;
    b.points.material.opacity = 0.95 * (1 - b.life / b.maxLife);
  }
  const moving = !!look && look.animated && !reducedMotion;
  if (!moving) {
    if (!ambientPosed) { ambientPosed = true; keyLight.intensity = keyBase; poseAmbient(0); updateSteam(0); }
    return;
  }
  ambientPosed = false;
  keyLight.intensity = keyBase * (1 + 0.025 * Math.sin(time * 0.6) + 0.012 * Math.sin(time * 1.7));
  if (steam.visible) updateSteam(dt);
  poseAmbient(dt);
}
function updateSteam(dt: number): void {
  const pos = steam.geometry.getAttribute("position") as BufferAttribute, col = steam.geometry.getAttribute("color") as BufferAttribute;
  for (let i = 0; i < steamCount; i++) {
    let l = steamLife[i]! + dt * 0.28 * steamSeeds[i * 2 + 1]!;
    if (l >= 1) l -= 1;
    steamLife[i] = l;
    const ph = steamSeeds[i * 2]!;
    pos.setXYZ(i, STEAM_ORIGIN.x + 0.12 * l + Math.sin(ph + l * 5 + time * 0.8) * 0.12 * l, STEAM_ORIGIN.y + l * 1.9, STEAM_ORIGIN.z + Math.cos(ph + l * 4) * 0.1 * l);
    // the old fragment's alpha: smoothstep(0, 0.15, life) × (1 − life) × 0.32 (additive here, so it scales the colour)
    const s = Math.min(1, l / 0.15), a = s * s * (3 - 2 * s) * (1 - l) * 0.32;
    col.setXYZ(i, a, a * 0.98, a * 0.95);
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
}
function poseAmbient(dt: number): void {
  for (let i = 0; i < petals.count; i++) {
    const p = petalData[i]!;
    p.y -= p.speed * dt;
    p.x += Math.sin(time * 0.6 + p.phase) * dt * 0.3;
    if (p.y < -3) { p.y = 9 + (i % 5); p.x = ((i * 7) % 28) - 14; }
    petalE.set(time * p.spin, p.phase, time * p.spin * 0.7);
    petalQ.setFromEuler(petalE);
    petalM.compose(v1.set(p.x, p.y, p.z), petalQ, v2);
    petals.setMatrixAt(i, petalM);
  }
  petals.instanceMatrix.needsUpdate = true;
  const mp = mist.geometry.getAttribute("position") as BufferAttribute;
  for (let i = 0; i < mistCount; i++) {
    const ph = mistSeeds[i * 2]!, sp = mistSeeds[i * 2 + 1]!;
    const x = mp.getX(i), z = mp.getZ(i);
    const a = Math.atan2(z, x) + sp * dt * 0.12, r = Math.hypot(x, z);
    mp.setXYZ(i, Math.cos(a) * r, mp.getY(i) + Math.sin(time * 0.4 + ph) * dt * 0.05, Math.sin(a) * r);
  }
  mp.needsUpdate = true;
  for (const isl of islands.children) isl.position.y += Math.sin(time * 0.3 + (isl.userData.bobPhase as number)) * dt * 0.06;
  for (const c of clouds.children) { c.position.x += (c.userData.speed as number) * dt; if (c.position.x > 36) c.position.x = -36; }
}
