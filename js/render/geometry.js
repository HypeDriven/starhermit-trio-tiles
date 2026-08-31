/**
 * Procedural geometry — authored, inspectable meshes built from first
 * principles (no primitive-only placeholders). Shared geometries are created
 * once and reused across every tile/slot; environment detail scales with
 * quality tier. All units are world units; one tile footprint = 1.0.
 */

import * as THREE from 'three';

export const TILE_SIZE = 0.92; // face width (1.0 grid pitch minus a grout gap)
export const TILE_THICK = 0.22;
export const LAYER_HEIGHT = 0.26;

function roundedRectShape(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
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

/** Carved tile body: rounded slab with a small bevel, UVs fit for face art. */
export function createTileGeometry() {
  const shape = roundedRectShape(TILE_SIZE, TILE_SIZE, 0.14);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: TILE_THICK - 0.06,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.03,
    bevelSegments: 2,
    curveSegments: 6,
  });
  geo.rotateX(-Math.PI / 2); // lie flat, face up
  geo.translate(0, TILE_THICK / 2 + 0.015, 0);
  // Normalize top-face UVs to 0..1 for the symbol texture.
  const uv = geo.attributes.uv;
  const pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    // Extrude UVs are in shape space (x, y-of-shape); after rotateX those map
    // to (x, z). Remap from [-size/2, size/2] into [0,1].
    const px = pos.getX(i);
    const pz = pos.getZ(i);
    uv.setXY(i, (px + TILE_SIZE / 2) / TILE_SIZE, 1 - (pz + TILE_SIZE / 2) / TILE_SIZE);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Table slab: a broad rounded board with a beveled lip. */
export function createTableGeometry(radiusX = 6.4, radiusZ = 4.6, thick = 0.5) {
  const shape = roundedRectShape(radiusX * 2, radiusZ * 2, 1.1);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: thick,
    bevelEnabled: true,
    bevelThickness: 0.12,
    bevelSize: 0.12,
    bevelSegments: 3,
    curveSegments: 12,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, -0.06, 0);
  return geo;
}

/** Floating rock underside — a displaced cone, seeded per scene. */
export function createRockGeometry(rand, radius = 4.6, depth = 4.2) {
  const geo = new THREE.ConeGeometry(radius, depth, 28, 6, false);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = (v.y + depth / 2) / depth; // 0 at tip, 1 at rim
    if (t > 0.02 && t < 0.98) {
      const a = Math.atan2(v.z, v.x);
      const bump = Math.sin(a * 3.1 + 1.7) * 0.5 + Math.sin(a * 7.3 + v.y * 1.9) * 0.35 + Math.sin(v.y * 4.7 + a) * 0.25;
      const scale = 1 + bump * 0.16 * (0.4 + t);
      v.x *= scale;
      v.z *= scale;
    }
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Tea pot from a lathe profile — the scene's signature prop. */
export function createTeapotGeometry() {
  const pts = [];
  const profile = [
    [0.0, 0.0],
    [0.34, 0.0],
    [0.5, 0.06],
    [0.58, 0.22],
    [0.52, 0.42],
    [0.34, 0.52],
    [0.16, 0.55],
    [0.14, 0.6],
    [0.2, 0.64],
    [0.1, 0.7],
    [0.0, 0.72],
  ];
  for (const [x, y] of profile) pts.push(new THREE.Vector2(x, y));
  const body = new THREE.LatheGeometry(pts, 24);
  // Spout: a bent small cylinder
  const spout = new THREE.CylinderGeometry(0.05, 0.085, 0.5, 10, 4);
  spout.translate(0, 0.25, 0);
  spout.rotateZ(-0.7);
  spout.translate(0.52, 0.28, 0);
  // Handle: half-torus
  const handle = new THREE.TorusGeometry(0.22, 0.045, 8, 16, Math.PI);
  handle.rotateZ(Math.PI / 2);
  handle.rotateY(Math.PI / 2);
  handle.translate(-0.52, 0.36, 0);
  return mergeGeometries([body, spout, handle]);
}

export function createCupGeometry() {
  const pts = [];
  const profile = [
    [0.0, 0.0],
    [0.16, 0.0],
    [0.2, 0.04],
    [0.23, 0.16],
    [0.22, 0.22],
    [0.18, 0.22],
    [0.19, 0.16],
    [0.16, 0.06],
    [0.0, 0.05],
  ];
  for (const [x, y] of profile) pts.push(new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 20);
}

/** Minimal merge (positions/normals/uvs) to avoid pulling in addons. */
export function mergeGeometries(geos) {
  let vCount = 0;
  let iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const norm = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const u = g.attributes.uv;
    pos.set(p.array, vOff * 3);
    if (n) norm.set(n.array, vOff * 3);
    if (u) uv.set(u.array, vOff * 2);
    else uv.fill(0, vOff * 2, (vOff + p.count) * 2);
    if (g.index) {
      const ia = g.index.array;
      for (let i = 0; i < ia.length; i++) idx[iOff + i] = ia[i] + vOff;
      iOff += ia.length;
    } else {
      for (let i = 0; i < p.count; i++) idx[iOff + i] = vOff + i;
      iOff += p.count;
    }
    vOff += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/** Distant floating island: flattened displaced blob on a rock spike. */
export function createIslandGeometry(rand, r = 1.6) {
  const top = new THREE.SphereGeometry(r, 14, 10);
  top.scale(1, 0.45, 1);
  const pos = top.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const bump = Math.sin(v.x * 2.1 + v.z * 1.3) * 0.08 + Math.sin(v.z * 3.7) * 0.05;
    pos.setXYZ(i, v.x * (1 + bump), v.y, v.z * (1 + bump));
  }
  top.computeVertexNormals();
  const spike = new THREE.ConeGeometry(r * 0.7, r * 1.6, 12, 3);
  spike.rotateX(Math.PI);
  spike.translate(0, -r * 0.75, 0);
  return mergeGeometries([top, spike]);
}

/** Selection/focus ring and grounded marker. */
export function createRingGeometry(inner = 0.5, outer = 0.62) {
  const g = new THREE.RingGeometry(inner, outer, 40);
  g.rotateX(-Math.PI / 2);
  return g;
}

/** Tray: a shallow dish with seven inset slots. */
export function createTrayBaseGeometry(slots = 7) {
  const w = slots * 1.06 + 0.5;
  const shape = roundedRectShape(w, 1.35, 0.5);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: true,
    bevelThickness: 0.05,
    bevelSize: 0.05,
    bevelSegments: 2,
    curveSegments: 8,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function createSlotGeometry() {
  const shape = roundedRectShape(1.0, 1.0, 0.16);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.05,
    bevelEnabled: false,
    curveSegments: 6,
  });
  geo.rotateX(-Math.PI / 2);
  return geo;
}
