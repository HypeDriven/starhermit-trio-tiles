/**
 * TeaScene — the Three.js presentation of the floating tea table.
 *
 * Rendering consumes immutable rules snapshots plus event lists; it never
 * writes game state. Cosmetic animation always derives from the
 * authoritative end state, and finishAll() settles every object into the
 * exact deterministic pose (skip/fast-forward safety).
 *
 * Layers: 0 environment · 1 gameplay · 2 selection/ghosts · 3 effects.
 * Raycasts run only against the explicit gameplay pick list; particles and
 * decoration never intercept input.
 */

import * as THREE from 'three';
import { decorStream } from '../rules/rng.js';
import { computeExposure, projectSelect } from '../rules/engine.js';
import { THEMES } from '../rules/content.js';
import {
  createTileGeometry,
  createTableGeometry,
  createRockGeometry,
  createTeapotGeometry,
  createCupGeometry,
  createIslandGeometry,
  createRingGeometry,
  createTrayBaseGeometry,
  createSlotGeometry,
  mergeGeometries,
  TILE_SIZE,
  TILE_THICK,
  LAYER_HEIGHT,
} from './geometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  buildTileTextures,
  buildWoodTexture,
  buildSoftCircleTexture,
  buildPetalTexture,
  buildGrainTexture,
  disposeTextureSets,
} from './materials.js';
import { CameraRig, CAMERA_ANCHORS } from './camera.js';
import { detectPreset, resolve, describe, SHADOW_MAP, PARTICLES } from './gfx.js';

const LAYER_ENV = 0;
const LAYER_GAME = 1;
const LAYER_SELECT = 2;
const LAYER_FX = 3;

// Pools are allocated once at the largest tier; tiers only change draw counts.
const MAX_PETALS = PARTICLES.high.petals;
const MAX_MIST = PARTICLES.high.mist;
const MAX_STEAM = PARTICLES.high.steam;
const MAX_BURST = 140;
const MAX_ISLANDS = 6;
const STEAM_ORIGIN = new THREE.Vector3(-3.42, 0.95, -2.2); // teapot spout tip

// Warm tea-house grade: gentle S-curve, a touch more saturation, warm
// highlights / cool shadows, and a soft vignette that never reaches the board.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.24 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      vec3 lc = clamp(c, 0.0, 1.0);
      vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.18);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.07);
      s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.97), smoothstep(0.2, 0.8, l));
      c = mix(c, s + max(c - 1.0, 0.0), uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.42, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

const EASE = {
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outBack: (t) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2),
  outQuad: (t) => 1 - (1 - t) * (1 - t),
};

export class TeaScene {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { graphics, reducedMotion, colorblindPalette, onContextLost }
   *   graphics: saved Graphics settings ({} = Auto), see gfx.js resolve().
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.reducedMotion = !!opts.reducedMotion;
    this.colorblindPalette = opts.colorblindPalette ?? 'default';
    this.gfxSaved = opts.graphics ?? {};
    this.onContextLost = opts.onContextLost ?? (() => {});
    this.adaptiveScale = 1;
    this.pixelRatio = 1;
    this.size = [0, 0];
    this._frames = [];
    this.fps = 0;
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    try {
      this._prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    } catch {
      this._prefersReduced = null;
    }

    this.theme = THEMES.dawn;
    this.tiles = new Map(); // tileId -> {mesh, home, sym}
    this.traySlots = [];
    this.tweens = [];
    this.bursts = [];
    this.pulses = [];
    this.hovered = null;
    this.focused = null;
    this.time = 0;
    this.lastState = null;
    this.level = null;
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._tmpV = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._disposed = false;

    this._initGL();
    this._bindContextEvents();
  }

  // -------------------------------------------------------------------------
  // GL bootstrap / teardown (also the context-restore path)
  // -------------------------------------------------------------------------

  _initGL() {
    // Canvas MSAA is off: multisampling (when chosen) happens in the post
    // chain's render target so it can be switched live without a new context.
    const r = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = false;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = r;
    this.gpu = readGpuName(r);
    this.detected = detectPreset(this.gpu, { mobile: isTouchDevice() });
    this.q = resolve(this.gfxSaved, this.detected);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
    this.camera.layers.enable(LAYER_GAME);
    this.camera.layers.enable(LAYER_SELECT);
    this.camera.layers.enable(LAYER_FX);
    this.rig = new CameraRig(this.camera);
    this.rig.reducedMotion = this.reducedMotion;

    // Lights: one dominant warm key, soft sky fill, gentle ambient.
    this.keyLight = new THREE.DirectionalLight(0xffe3c0, 2.6);
    this.keyLight.position.set(6, 10, 4);
    this.keyLight.castShadow = false;
    this.keyLight.shadow.bias = -0.0004;
    this.keyLight.shadow.normalBias = 0.02;
    this.keyLight.shadow.radius = 3;
    this._fitShadowFrustum();
    this.scene.add(this.keyLight);
    this.keyBase = this.keyLight.intensity;
    this.fillLight = new THREE.HemisphereLight(0x88a0b9, 0x3a2e28, 0.55);
    this.scene.add(this.fillLight);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.12);
    this.scene.add(this.ambient);

    this.textureSets = new Map();
    this.materialCache = new Map();
    this._buildEnvironment();

    this.boardGroup = new THREE.Group();
    this.boardGroup.position.set(0, 0.02, -0.55);
    this.scene.add(this.boardGroup);
    this.trayGroup = new THREE.Group();
    this.scene.add(this.trayGroup);

    this.tileGeometry = createTileGeometry();
    this._buildTray();
    this._buildSelectionAids();
    this._buildVFXPools();

    // Precompile every material variant before first play (no mid-round
    // shader compilation hitches).
    this._applyGraphics();
    this.renderer.compile(this.scene, this.camera);
    this.resize();
  }

  /** Fit the key light's orthographic shadow camera tightly around the table + tray + props. */
  _fitShadowFrustum() {
    const light = this.keyLight;
    const dir = light.position.clone().normalize();
    light.target.position.set(0, 0, 0);
    light.position.copy(dir.clone().multiplyScalar(14));
    light.updateMatrixWorld();
    light.target.updateMatrixWorld();
    const view = new THREE.Matrix4().lookAt(light.position, light.target.position, new THREE.Vector3(0, 1, 0));
    view.setPosition(light.position);
    const inv = view.clone().invert();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const p = new THREE.Vector3();
    // Play area: table top (±6.4 × ±4.6) from the slab edge up to a tall tile stack / the teapot lid.
    for (const x of [-6.6, 6.6]) for (const y of [-0.7, 2.2]) for (const z of [-4.8, 4.8]) {
      p.set(x, y, z).applyMatrix4(inv);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    Object.assign(light.shadow.camera, { left: minX, right: maxX, top: maxY, bottom: minY, near: -maxZ - 0.5, far: -minZ + 0.5 });
    light.shadow.camera.updateProjectionMatrix();
  }

  // -------------------------------------------------------------------------
  // Graphics settings (live — no reload)
  // -------------------------------------------------------------------------

  /** Apply saved Graphics settings ({} = Auto). */
  setGraphics(saved) {
    this.gfxSaved = saved ?? {};
    this.q = resolve(this.gfxSaved, this.detected);
    this.adaptiveScale = 1;
    this._frames = [];
    this._applyGraphics();
  }

  _applyGraphics() {
    const g = this.q;
    const r = this.renderer;
    // Shadows: enable/size the map; lit materials recompile for the new state.
    const size = SHADOW_MAP[g.shadows];
    const shadowChanged = r.shadowMap.enabled !== size > 0;
    r.shadowMap.enabled = size > 0;
    this.keyLight.castShadow = size > 0;
    if (size > 0 && this.keyLight.shadow.mapSize.x !== size) {
      this.keyLight.shadow.mapSize.set(size, size);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    // Image-based lighting: a studio room (reflections on tiles/teapot) or the cheap sky tint.
    if (g.reflections === 'on') {
      if (!this._envRoom) {
        const pmrem = new THREE.PMREMGenerator(r);
        const room = new RoomEnvironment(r);
        this._envRoom = pmrem.fromScene(room, 0.04).texture;
        room.dispose?.();
        pmrem.dispose();
      }
      this.scene.environment = this._envRoom;
      this.scene.environmentIntensity = 0.35;
    } else {
      this.scene.environment = this._envSimple;
      this.scene.environmentIntensity = 1;
    }
    // Particles: draw counts only (pools are allocated at the top tier).
    const pc = PARTICLES[g.particles];
    this.petals.count = pc.petals;
    this.mist.geometry.setDrawRange(0, pc.mist);
    this.steam.geometry.setDrawRange(0, pc.steam);
    this.steam.visible = pc.steam > 0;
    this.burstCount = Math.round(MAX_BURST * pc.burst);
    // Detail: distant islands, table grain relief, glossy tiles.
    const islands = g.detail === 'detailed' ? MAX_ISLANDS : 2;
    this.islands.children.forEach((isl, i) => (isl.visible = i < islands));
    const detailed = g.detail === 'detailed';
    if (this.tableMaterial.userData.detailed !== detailed) {
      this.tableMaterial.userData.detailed = detailed;
      this.tableMaterial.bumpMap = detailed ? this.tableMaterial.map : null;
      this.tableMaterial.bumpScale = 2.2;
      this.tableMaterial.roughnessMap = detailed ? this.grainTexture : null;
      this.tableMaterial.needsUpdate = true;
    }
    if (this._tileDetail !== detailed) {
      this._tileDetail = detailed;
      this._rebuildTileMaterials();
    }
    if (shadowChanged) {
      this.scene.traverse((o) => {
        if (o.material && !o.material.isShaderMaterial) {
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
        }
      });
      for (const m of this.materialCache.values()) m.needsUpdate = true;
    }
    this.postKey = null; // rebuild the post chain on the next frame
    this._ambientPosed = false; // re-pose particles for the new counts
    this._fpsVisible(g.showFps);
    this.canvas.dataset.gfxPreset = g.preset;
    document.body.dataset.gfxPreset = g.preset;
    this.applyRenderScale();
  }

  /** Whether decorative motion runs (Background setting + reduced-motion preferences). */
  _ambientMoving() {
    return this.q.background === 'animated' && !this.reducedMotion && !this._prefersReduced?.matches;
  }

  /** What the Graphics panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo(words) {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      summary: describe(this.q, px, words),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.className = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post && !this.postFailed ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    for (const pass of this.composer?.passes ?? []) pass.dispose?.();
    this.composer?.dispose();
    this.composer = null;
    if (!g.post || this.postFailed) return;
    try {
      const pw = Math.max(1, Math.round(w * this.pixelRatio));
      const ph = Math.max(1, Math.round(h * this.pixelRatio));
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType,
        samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // Threshold above lit ivory (the HDR buffer is pre-tone-mapping): only clearcoat glints and triple bursts bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.4, 1.25));
      }
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      composer.addPass(new OutputPass());
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly and let the panel say so.
      this.postFailed = true;
      this.composer = null;
    }
  }

  /** Adaptive resolution: step the render scale down when frames are slow, back up when fast. */
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  _bindContextEvents() {
    this._onLost = (e) => {
      e.preventDefault();
      this.onContextLost();
    };
    this.canvas.addEventListener('webglcontextlost', this._onLost, false);
  }

  dispose() {
    this._disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.scene?.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) {
          for (const k of Object.keys(m)) if (m[k]?.isTexture) m[k].dispose();
          m.dispose();
        }
      }
    });
    disposeTextureSets(this.textureSets);
    for (const pass of this.composer?.passes ?? []) pass.dispose?.();
    this.composer?.dispose();
    this._envRoom?.dispose();
    this._envSimple?.dispose();
    this.renderer?.dispose();
    this.tiles.clear();
    this.tweens.length = 0;
  }

  // -------------------------------------------------------------------------
  // Environment
  // -------------------------------------------------------------------------

  _buildEnvironment() {
    const t = this.theme;
    const decor = decorStream(this._decorSeed ?? 'env');

    // Sky dome: vertical gradient with a warm horizon band (no textures).
    const skyGeo = new THREE.SphereGeometry(90, 24, 16);
    // The dome is encoded through the renderer's colour-space chunk so the
    // direct (Low) and post-processed skies match.
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      uniforms: {
        top: { value: skyColor(t.sky[0]) },
        mid: { value: skyColor(t.sky[1]) },
        bottom: { value: skyColor(t.sky[2]) },
      },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP;
        void main(){
          float h = normalize(vP).y;
          vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.6, h)) : mix(mid, bottom, smoothstep(0.0, -0.5, h));
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    this.sky = new THREE.Mesh(skyGeo, skyMat);
    this.sky.layers.set(LAYER_ENV);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(t.fog, 22, 70);

    // Image-based fill from a tiny generated room (core PMREM, no addons).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(new THREE.SphereGeometry(10, 16, 12), new THREE.MeshBasicMaterial({ color: t.sky[1], side: THREE.BackSide }));
    const envGlow = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({ color: t.key.color }));
    envGlow.position.set(4, 6, -6);
    envGlow.lookAt(0, 0, 0);
    envScene.add(envSky, envGlow);
    this._envSimple = pmrem.fromScene(envScene, 0.04).texture;
    this.scene.environment = this._envSimple;
    pmrem.dispose();
    this.grainTexture = buildGrainTexture(decorStream('grain'));

    // Table + carved trim + floating rock underside.
    const wood = buildWoodTexture('#8a5a3b', '#5e3a24', decor);
    // Extrude UVs are in world units (table ≈ 12.8 × 9.2): ~2 grain repeats across.
    wood.repeat.set(0.16, 0.16);
    wood.anisotropy = 8;
    this.tableMaterial = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.62, metalness: 0.05 });
    this.table = new THREE.Mesh(createTableGeometry(), this.tableMaterial);
    this.table.receiveShadow = true;
    this.table.layers.set(LAYER_ENV);
    this.scene.add(this.table);

    this.rock = new THREE.Mesh(createRockGeometry(decor), new THREE.MeshStandardMaterial({ color: 0x5a4a42, roughness: 0.95, flatShading: true }));
    this.rock.position.y = -2.6;
    this.rock.layers.set(LAYER_ENV);
    this.scene.add(this.rock);

    // Tea set props (signature storytelling, kept clear of the play area).
    const potMat = new THREE.MeshPhysicalMaterial({ color: 0x7a4a3a, roughness: 0.38, metalness: 0.05, clearcoat: 0.6, clearcoatRoughness: 0.2 });
    this.teapot = new THREE.Mesh(createTeapotGeometry(), potMat);
    this.teapot.position.set(-4.6, 0.02, -2.2);
    this.teapot.scale.setScalar(1.4);
    this.teapot.castShadow = true;
    this.teapot.layers.set(LAYER_ENV);
    this.scene.add(this.teapot);
    const cupMat = new THREE.MeshPhysicalMaterial({ color: 0xe8dcc8, roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.15 });
    this.cups = new THREE.Group();
    for (let i = 0; i < 2; i++) {
      const cup = new THREE.Mesh(createCupGeometry(), cupMat);
      cup.position.set(-3.4 + i * 0.8, 0.02, -2.9 + i * 0.35);
      cup.castShadow = true;
      cup.layers.set(LAYER_ENV);
      this.cups.add(cup);
    }
    this.scene.add(this.cups);

    // Distant islands + clouds, deterministic per scene seed.
    this.islands = new THREE.Group();
    const islandMat = new THREE.MeshStandardMaterial({ color: 0x6a7a5e, roughness: 0.9, flatShading: true });
    for (let i = 0; i < MAX_ISLANDS; i++) {
      const isl = new THREE.Mesh(createIslandGeometry(decor, decor.range(1.2, 2.4)), islandMat);
      const a = decor.range(0, Math.PI * 2);
      const r = decor.range(16, 30);
      isl.position.set(Math.cos(a) * r, decor.range(-4, 3), Math.sin(a) * r - 8);
      isl.userData.bobPhase = decor.range(0, Math.PI * 2);
      isl.layers.set(LAYER_ENV);
      this.islands.add(isl);
    }
    this.scene.add(this.islands);

    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false });
    this.clouds = new THREE.Group();
    for (let i = 0; i < 4; i++) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(decor.range(2, 4), 10, 8), cloudMat);
      puff.scale.y = 0.35;
      puff.position.set(decor.range(-30, 30), decor.range(6, 12), decor.range(-34, -16));
      puff.userData.speed = decor.range(0.05, 0.16);
      puff.layers.set(LAYER_ENV);
      this.clouds.add(puff);
    }
    this.scene.add(this.clouds);

    // Mist ring under the table (points, raycast-free by layer).
    const mistCount = MAX_MIST;
    const mistGeo = new THREE.BufferGeometry();
    const mp = new Float32Array(mistCount * 3);
    this.mistSeeds = new Float32Array(mistCount * 2);
    for (let i = 0; i < mistCount; i++) {
      const a = decor.range(0, Math.PI * 2);
      const r = decor.range(4, 10);
      mp[i * 3] = Math.cos(a) * r;
      mp[i * 3 + 1] = decor.range(-4.5, -1);
      mp[i * 3 + 2] = Math.sin(a) * r;
      this.mistSeeds[i * 2] = decor.range(0, Math.PI * 2);
      this.mistSeeds[i * 2 + 1] = decor.range(0.1, 0.5);
    }
    mistGeo.setAttribute('position', new THREE.BufferAttribute(mp, 3));
    this.mist = new THREE.Points(
      mistGeo,
      new THREE.PointsMaterial({
        map: buildSoftCircleTexture(),
        color: mistColor(t),
        size: 2.4,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.mist.layers.set(LAYER_ENV);
    this.mist.raycast = () => {};
    this.scene.add(this.mist);

    // Drifting petals (instanced; bounded; seeded).
    const petalCount = MAX_PETALS;
    const petalGeo = new THREE.PlaneGeometry(0.22, 0.22);
    const petalMat = new THREE.MeshBasicMaterial({
      map: buildPetalTexture('#e8a4b8'),
      transparent: true,
      alphaTest: 0.1,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.petals = new THREE.InstancedMesh(petalGeo, petalMat, petalCount);
    this.petals.layers.set(LAYER_ENV);
    this.petals.raycast = () => {};
    this.petalData = [];
    for (let i = 0; i < petalCount; i++) {
      this.petalData.push({
        x: decor.range(-14, 14),
        y: decor.range(0, 10),
        z: decor.range(-14, 10),
        phase: decor.range(0, Math.PI * 2),
        speed: decor.range(0.15, 0.5),
        spin: decor.range(0.4, 1.6),
      });
    }
    this.scene.add(this.petals);
    this._petalMat4 = new THREE.Matrix4();
    this._petalQuat = new THREE.Quaternion();
    this._petalEuler = new THREE.Euler();

    // Steam curling from the teapot spout (bounded, seeded; drawn only at medium/high particles).
    const steamGeo = new THREE.BufferGeometry();
    const sp = new Float32Array(MAX_STEAM * 3);
    const sl = new Float32Array(MAX_STEAM);
    this.steamSeeds = new Float32Array(MAX_STEAM * 2);
    for (let i = 0; i < MAX_STEAM; i++) {
      sl[i] = i / MAX_STEAM;
      this.steamSeeds[i * 2] = decor.range(0, Math.PI * 2);
      this.steamSeeds[i * 2 + 1] = decor.range(0.7, 1.3);
    }
    steamGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    steamGeo.setAttribute('aLife', new THREE.BufferAttribute(sl, 1));
    this.steam = new THREE.Points(
      steamGeo,
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: { map: { value: buildSoftCircleTexture() }, uScale: { value: 300 } },
        vertexShader: `
          attribute float aLife; varying float vLife; uniform float uScale;
          void main() {
            vLife = aLife;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = uScale * (0.12 + aLife * 0.34) / -mv.z;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          uniform sampler2D map; varying float vLife;
          void main() {
            float a = texture2D(map, gl_PointCoord).a * smoothstep(0.0, 0.15, vLife) * (1.0 - vLife) * 0.32;
            gl_FragColor = vec4(vec3(1.0, 0.98, 0.95), a);
          }`,
      }),
    );
    this.steam.frustumCulled = false;
    this.steam.layers.set(LAYER_ENV);
    this.steam.raycast = () => {};
    this._updateSteam(0);
    this.scene.add(this.steam);
  }

  _updateSteam(dt) {
    const pos = this.steam.geometry.attributes.position;
    const life = this.steam.geometry.attributes.aLife;
    const n = this.steam.geometry.drawRange.count === Infinity ? MAX_STEAM : Math.min(MAX_STEAM, this.steam.geometry.drawRange.count);
    for (let i = 0; i < n; i++) {
      let l = life.getX(i) + dt * 0.28 * this.steamSeeds[i * 2 + 1];
      if (l >= 1) l -= 1;
      life.setX(i, l);
      const ph = this.steamSeeds[i * 2];
      const rise = l * 1.9;
      pos.setXYZ(
        i,
        STEAM_ORIGIN.x + 0.12 * l + Math.sin(ph + l * 5 + this.time * 0.8) * 0.12 * l,
        STEAM_ORIGIN.y + rise,
        STEAM_ORIGIN.z + Math.cos(ph + l * 4) * 0.1 * l,
      );
    }
    pos.needsUpdate = true;
    life.needsUpdate = true;
  }

  // -------------------------------------------------------------------------
  // Tray + selection aids + VFX pools
  // -------------------------------------------------------------------------

  _buildTray() {
    const capacity = 7;
    const baseMat = new THREE.MeshStandardMaterial({ color: this.theme.tableTrim, roughness: 0.6 });
    this.trayBase = new THREE.Mesh(createTrayBaseGeometry(capacity), baseMat);
    this.trayBase.position.set(0, 0.03, 3.65);
    this.trayBase.receiveShadow = true;
    this.trayBase.layers.set(LAYER_ENV);
    this.trayGroup.add(this.trayBase);

    this.slotMeshes = [];
    const slotGeo = createSlotGeometry();
    const slotMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.9, transparent: true, opacity: 0.24 });
    for (let i = 0; i < capacity; i++) {
      const slot = new THREE.Mesh(slotGeo, slotMat);
      slot.position.set(this._slotX(i, capacity), 0.1, 3.65);
      slot.layers.set(LAYER_ENV);
      this.trayGroup.add(slot);
      this.slotMeshes.push(slot);
    }

    // Preview marker shown on the insertion slot before commit.
    this.slotPreview = new THREE.Mesh(
      createRingGeometry(0.42, 0.54),
      new THREE.MeshBasicMaterial({ color: 0x7ac88a, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.slotPreview.position.y = 0.16;
    this.slotPreview.layers.set(LAYER_SELECT);
    this.slotPreview.raycast = () => {};
    this.trayGroup.add(this.slotPreview);
  }

  _slotX(i, capacity = 7) {
    return (i - (capacity - 1) / 2) * 1.06;
  }

  slotWorldPosition(i, capacity = 7, out = new THREE.Vector3()) {
    out.set(this._slotX(i, capacity), 0.24, 3.65);
    return out;
  }

  _buildSelectionAids() {
    // Grounded marker under the hovered/focused tile (selection is never
    // bloom alone: lift + emissive rim + this ring).
    this.focusRing = new THREE.Mesh(
      createRingGeometry(0.56, 0.7),
      new THREE.MeshBasicMaterial({ color: 0xfff0c8, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.focusRing.layers.set(LAYER_SELECT);
    this.focusRing.raycast = () => {};
    this.scene.add(this.focusRing);

    this.hintRing = new THREE.Mesh(
      createRingGeometry(0.6, 0.74),
      new THREE.MeshBasicMaterial({ color: 0x8ad0ff, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.hintRing.layers.set(LAYER_SELECT);
    this.hintRing.raycast = () => {};
    this.scene.add(this.hintRing);
  }

  _buildVFXPools() {
    // Bounded pooled bursts — allocated once, reused, never raycast.
    const burstCount = 4;
    const perBurst = MAX_BURST;
    const tex = buildSoftCircleTexture();
    for (let b = 0; b < burstCount; b++) {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(perBurst * 3);
      const col = new Float32Array(perBurst * 3);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const mat = new THREE.PointsMaterial({
        size: 0.16,
        map: tex,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geo, mat);
      points.visible = false;
      points.layers.set(LAYER_FX);
      points.raycast = () => {};
      this.scene.add(points);
      this.bursts.push({ points, velocities: new Float32Array(perBurst * 3), life: 0, maxLife: 1, active: false, count: perBurst });
    }
    this._burstIndex = 0;
  }

  // -------------------------------------------------------------------------
  // Theme + tier
  // -------------------------------------------------------------------------

  setTheme(themeId) {
    const t = THEMES[themeId];
    if (!t || t === this.theme) return;
    this.theme = t;
    this.sky.material.uniforms.top.value.copy(skyColor(t.sky[0]));
    this.sky.material.uniforms.mid.value.copy(skyColor(t.sky[1]));
    this.sky.material.uniforms.bottom.value.copy(skyColor(t.sky[2]));
    this.scene.fog.color.set(t.fog);
    this.mist.material.color.copy(mistColor(t));
    this.keyLight.color.set(t.key.color);
    this.keyLight.intensity = t.key.intensity;
    this.keyBase = t.key.intensity;
    this.fillLight.color.set(t.fill.color);
    this.fillLight.intensity = t.fill.intensity;
    this.trayBase.material.color.set(t.tableTrim);
    this.petals.material.map?.dispose();
    this.petals.material.map = buildPetalTexture('#' + new THREE.Color(t.petal).getHexString());
    this.petals.material.needsUpdate = true;
    // Tile face art is per-theme ink — rebuild the texture sets and materials.
    this._rebuildTileMaterials();
  }

  /** Pixel ratio = min(dpr, preset cap) × preset/user scale × adaptive scale. */
  applyRenderScale() {
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dprCap) * this.q.scale * this.adaptiveScale;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio) {
      this.size = [w, h];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(w, h, false);
      if (this.steam) this.steam.material.uniforms.uScale.value = h * ratio * 0.5;
    }
    const anchor = this.rig.anchorForAspect(w / h, this._cameraPreference ?? 'default');
    // Re-frame on every resize: the play area's fit depends on aspect and HUD.
    this._aim(anchor !== this.rig.anchor && !this._anchorLocked ? anchor : this.rig.anchor);
  }

  setCameraPreference(pref) {
    this._cameraPreference = pref;
    this._anchorLocked = false;
    this._aim(this.rig.anchorForAspect(this.camera.aspect, pref));
  }

  resetCamera() {
    this._anchorLocked = false;
    this._aim(this.rig.anchorForAspect(this.camera.aspect, this._cameraPreference ?? 'default'));
  }

  // -------------------------------------------------------------------------
  // Play-area framing
  // -------------------------------------------------------------------------

  /**
   * `fn()` returns the HUD elements that cover the canvas during play (the
   * play area — board + tray — is framed in the rectangle they leave free),
   * or null off the play screen (authored anchor framing).
   */
  setFramingChrome(fn) {
    this._chromeFn = fn;
  }

  /** Recompute the framing for the current anchor (HUD or board changed). */
  reframe() {
    this._aim(this.rig.anchor);
  }

  _aim(name) {
    this.rig.setAnchor(name, this._frameFor(name));
  }

  /**
   * Lens frame for anchor `name`: board + tray fill the canvas left free by
   * the HUD (identity off the play screen and for the win close-up). Full-
   * width bands and full-height rails are always kept clear; smaller corner
   * pieces only when the framed board or tray would end up beneath them.
   */
  _frameFor(name) {
    const chrome = this._chromeFn?.();
    if (!chrome || !this._fitGroups || name === 'win') return null;
    const W = this.canvas.clientWidth || window.innerWidth;
    const H = this.canvas.clientHeight || window.innerHeight;
    this._fitCam ??= new THREE.PerspectiveCamera();
    const groups = this._fitGroups.map((g) => CameraRig.projectBounds(name, g, this.camera.aspect, this._fitCam));
    const all = groups.reduce((u, b) => ({
      x0: Math.min(u.x0, b.x0), x1: Math.max(u.x1, b.x1), y0: Math.min(u.y0, b.y0), y1: Math.max(u.y1, b.y1),
    }));
    const ins = { t: 0, b: 0, l: 0, r: 0 };
    const pieces = [];
    for (const el of chrome) {
      const r = el.getBoundingClientRect();
      const p = { x0: Math.max(0, r.left), x1: Math.min(W, r.right), y0: Math.max(0, r.top), y1: Math.min(H, r.bottom) };
      if (p.x1 - p.x0 < 1 || p.y1 - p.y0 < 1) continue;
      if (p.x1 - p.x0 > W * 0.5) this._inset(ins, p, W, H, 'v'); // top/bottom band
      else if (p.y1 - p.y0 > H * 0.5) this._inset(ins, p, W, H, 'h'); // side rail
      else pieces.push(p);
    }
    const m = Math.round(Math.min(W, H) * 0.025); // breathing room
    const toNdc = (r) => ({ x0: (2 * r.x0) / W - 1, x1: (2 * r.x1) / W - 1, y0: 1 - (2 * r.y1) / H, y1: 1 - (2 * r.y0) / H });
    let frame = null;
    for (let pass = 0, passes = pieces.length; pass <= passes; pass++) {
      const x0 = ins.l + m, x1 = W - ins.r - m, y0 = ins.t + m, y1 = H - ins.b - m;
      if (x1 - x0 < W * 0.3 || y1 - y0 < H * 0.3) return frame;
      frame = CameraRig.frameFor(all, toNdc({ x0, x1, y0, y1 }));
      const hit = pieces.find((p) => {
        const q = toNdc(p);
        return groups.some((g) => {
          const s = CameraRig.framed(g, frame);
          return s.x0 < q.x1 && s.x1 > q.x0 && s.y0 < q.y1 && s.y1 > q.y0;
        });
      });
      if (!hit) return frame;
      pieces.splice(pieces.indexOf(hit), 1);
      // Give up whichever axis costs less of the screen.
      const midX = (hit.x0 + hit.x1) / 2, midY = (hit.y0 + hit.y1) / 2;
      const costV = (midY < H / 2 ? hit.y1 : H - hit.y0) / H;
      const costH = (midX < W / 2 ? hit.x1 : W - hit.x0) / W;
      this._inset(ins, hit, W, H, costV <= costH ? 'v' : 'h');
    }
    return frame;
  }

  _inset(ins, p, W, H, axis) {
    if (axis === 'v') {
      if ((p.y0 + p.y1) / 2 < H / 2) ins.t = Math.max(ins.t, p.y1);
      else ins.b = Math.max(ins.b, H - p.y0);
    } else if ((p.x0 + p.x1) / 2 < W / 2) ins.l = Math.max(ins.l, p.x1);
    else ins.r = Math.max(ins.r, W - p.x0);
  }

  /** World boxes framed in play: the level's tiles (at their highest lift) and the tray. */
  _computeFitBox(level) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = 0;
    const half = TILE_SIZE / 2 + 0.05;
    const bz = this.boardGroup.position.z;
    for (const t of level.tiles) {
      const x = t.gx / 2 - this.boardOffset.x;
      const z = t.gy / 2 - this.boardOffset.y + bz;
      x0 = Math.min(x0, x - half); x1 = Math.max(x1, x + half);
      z0 = Math.min(z0, z - half); z1 = Math.max(z1, z + half);
      top = Math.max(top, 0.05 + t.z * LAYER_HEIGHT + TILE_THICK);
    }
    const pad = 0.25;
    const box = (ax, bx, ay, by, az, bz2) => {
      const out = [];
      for (const x of [ax - pad, bx + pad]) for (const y of [ay, by]) for (const z of [az - pad, bz2 + pad]) out.push(new THREE.Vector3(x, y, z));
      return out;
    };
    // Tray: 7 slots × 1.06 + rim wide, 1.35 deep, centred at z 3.65.
    const tw = (7 * 1.06 + 0.5) / 2 + 0.06;
    this._fitGroups = [
      box(x0, x1, 0, top + 0.35 /* hover/selection lift */, z0, z1),
      box(-tw, tw, 0, 0.6, 3.65 - 0.74, 3.65 + 0.74),
    ];
  }

  // -------------------------------------------------------------------------
  // Board construction from rules snapshots
  // -------------------------------------------------------------------------

  _rebuildTileMaterials() {
    if (!this.level) return;
    disposeTextureSets(this.textureSets);
    this.materialCache.forEach((m) => m.dispose());
    this.materialCache.clear();
    this.textureSets = buildTileTextures(this.level.symbolIds, this.theme, this.colorblindPalette);
    for (const [, rec] of this.tiles) {
      if (rec.ownMaterial) {
        rec.mesh.material.dispose();
        rec.ownMaterial = false;
      }
      rec.mesh.material = this._materialFor(rec.sym, rec.exposed);
    }
  }

  _materialFor(sym, exposed) {
    const key = sym + (exposed ? ':lit' : ':dim');
    if (this.materialCache.has(key)) return this.materialCache.get(key);
    const set = this.textureSets.get(sym);
    const base = {
      color: exposed ? this.theme.tile : 0x9a8f7c,
      map: set?.map ?? null,
      bumpMap: set?.bumpMap ?? null,
      bumpScale: 1.4,
      roughness: 0.55,
      metalness: 0.04,
      emissive: new THREE.Color(0x000000),
    };
    // Detailed: lacquered tiles — clearcoat over a faintly mottled surface.
    const mat = this._tileDetail
      ? new THREE.MeshPhysicalMaterial({
          ...base,
          roughness: 0.5,
          roughnessMap: this.grainTexture,
          clearcoat: exposed ? 0.55 : 0.2,
          clearcoatRoughness: 0.28,
          envMapIntensity: 0.9,
        })
      : new THREE.MeshStandardMaterial(base);
    this.materialCache.set(key, mat);
    return mat;
  }

  /**
   * Build tile meshes for a materialized level + opening state.
   * All positions derive from the deterministic layout — no per-session drift.
   */
  buildBoard(level, state) {
    this.level = level;
    this._decorSeed = level.seed + ':decor:' + this.theme.id;
    this.fxRand = decorStream(level.seed + ':fx');
    // Clear previous board.
    for (const [, rec] of this.tiles) {
      this.boardGroup.remove(rec.mesh);
    }
    this.tiles.clear();
    this.tweens.length = 0;
    this.textureSets = buildTileTextures(level.symbolIds, this.theme, this.colorblindPalette);

    // Center the layout on the table.
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const t of level.tiles) {
      minX = Math.min(minX, t.gx);
      maxX = Math.max(maxX, t.gx);
      minY = Math.min(minY, t.gy);
      maxY = Math.max(maxY, t.gy);
    }
    this.boardOffset = { x: (minX + maxX) / 4, y: (minY + maxY) / 4 }; // half-units→world /2, center
    this._computeFitBox(level);
    this.reframe();
    for (const t of level.tiles) {
      const mesh = new THREE.Mesh(this.tileGeometry, null);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER_GAME);
      const home = this._tileWorld(t);
      mesh.position.copy(home);
      mesh.userData.tileId = t.id;
      this.boardGroup.add(mesh);
      this.tiles.set(t.id, { mesh, home, sym: t.sym, exposed: true, inTray: false, cleared: false });
    }
    this.reconcile(state, { instant: true });
  }

  _tileWorld(t) {
    return this._tmpV
      .set((t.gx / 2 - this.boardOffset.x) * 1.0, 0.03 + t.z * LAYER_HEIGHT + TILE_THICK / 2, (t.gy / 2 - this.boardOffset.y) * 1.0)
      .clone();
  }

  /**
   * Reconcile every mesh to the snapshot exactly. With {instant:true} all
   * poses snap (fast-forward / undo / restore); otherwise only bookkeeping.
   */
  reconcile(state, { instant = false } = {}) {
    this.lastState = state;
    const { exposed, blockers } = computeExposure(state);
    const exposedSet = new Set(exposed);
    const onBoard = new Set(state.tiles.map((t) => t.id));
    const inTray = new Map(state.tray.map((e, i) => [e.id, i]));

    for (const [id, rec] of this.tiles) {
      const wasExposed = rec.exposed;
      rec.exposed = exposedSet.has(id);
      rec.inTray = inTray.has(id);
      rec.cleared = !onBoard.has(id) && !inTray.has(id);
      rec.blockerCount = blockers.get(id)?.length ?? 0;

      if (rec.cleared) {
        rec.mesh.visible = false;
        continue;
      }
      rec.mesh.visible = true;
      const matKeyChanged = rec.mesh.material !== this._materialFor(rec.sym, rec.exposed);
      if (matKeyChanged) rec.mesh.material = this._materialFor(rec.sym, rec.exposed);

      if (instant) {
        if (rec.inTray) {
          const slotIdx = inTray.get(id);
          this.slotWorldPosition(slotIdx, state.trayCapacity, this._tmpV2);
          this.boardGroup.worldToLocal(this._tmpV2);
          rec.mesh.position.copy(this._tmpV2);
          rec.mesh.rotation.set(0, 0, 0);
          rec.mesh.scale.setScalar(0.94);
        } else {
          rec.mesh.position.copy(rec.home);
          rec.mesh.scale.setScalar(1);
        }
      }
      if (wasExposed !== rec.exposed && !instant) {
        // Small settle nudge when a tile becomes exposed.
        this._tween(rec.mesh.position, { y: rec.inTray ? rec.mesh.position.y : rec.home.y }, 0.18, EASE.outQuad);
      }
    }
    this._updateTraySlots(state);
  }

  _updateTraySlots(state) {
    for (let i = 0; i < this.slotMeshes.length; i++) {
      const slot = this.slotMeshes[i];
      slot.visible = i < state.trayCapacity;
      slot.userData.danger = !slot.userData.occupied && state.tray.length >= state.trayCapacity - 2;
      slot.userData.occupied = i < state.tray.length;
    }
    // Tray fullness tint on the base.
    const fullness = state.tray.length / state.trayCapacity;
    const c = new THREE.Color(this.theme.tableTrim);
    if (fullness >= 0.85) c.lerp(new THREE.Color(0xb04030), 0.55);
    else if (fullness >= 0.6) c.lerp(new THREE.Color(0xb08030), 0.35);
    this.trayBase.material.color.copy(c);
  }

  // -------------------------------------------------------------------------
  // Event presentation (cosmetic; end state always reconciled)
  // -------------------------------------------------------------------------

  applyEvents(events, state) {
    for (const ev of events) {
      switch (ev.type) {
        case 'pick': {
          const rec = this.tiles.get(ev.tileId);
          if (rec) this._flyToTray(rec, ev.insertAt, state);
          break;
        }
        case 'triple': {
          this._tripleBurst(ev, state);
          break;
        }
        case 'invalid': {
          if (ev.tileId) this._invalidWiggle(ev.tileId);
          break;
        }
        case 'undo': {
          this.reconcile(state, { instant: true });
          break;
        }
        case 'win': {
          this._winSequence();
          break;
        }
        case 'lose': {
          this._loseSequence(ev.reason);
          break;
        }
      }
    }
    this.reconcile(state, { instant: false });
  }

  _flyToTray(rec, insertAt, state) {
    const target = this.slotWorldPosition(insertAt, state.trayCapacity, new THREE.Vector3());
    this.boardGroup.worldToLocal(target);
    const mesh = rec.mesh;
    const from = mesh.position.clone();
    const dur = this.reducedMotion ? 0.08 : 0.3;
    const arcH = this.reducedMotion ? 0.1 : 1.4;
    this._tweenCustom(dur, (t) => {
      const e = EASE.inOutCubic(t);
      mesh.position.lerpVectors(from, target, e);
      mesh.position.y += Math.sin(e * Math.PI) * arcH;
      mesh.scale.setScalar(1 - 0.06 * e);
    });
    this.rig.shake(0);
  }

  _tripleBurst(ev, state) {
    // Burst from the middle cleared slot.
    const midSlot = Math.min(state.tray.length, state.trayCapacity - 1);
    const origin = this.slotWorldPosition(Math.max(0, midSlot - 1), state.trayCapacity, new THREE.Vector3());
    origin.y += 0.3;
    const set = this.textureSets.get(ev.sym);
    this._spawnBurst(origin, set?.color ?? new THREE.Color(0xffe9a8), ev.chain >= 2 ? 1.5 : 1);
    this.rig.shake(ev.chain >= 2 ? 2 : 1);
    // Ring pulse at the tray.
    this._spawnPulse(origin, set?.color ?? new THREE.Color(0xffffff));
    // Cleared tiles vanish after their flight; reconcile handles final pose.
    for (const id of ev.tileIds) {
      const rec = this.tiles.get(id);
      if (rec) {
        const m = rec.mesh;
        const s0 = m.scale.x;
        this._tweenCustom(this.reducedMotion ? 0.05 : 0.25, (t) => {
          m.scale.setScalar(s0 * (1 - EASE.outBack(t)));
        });
      }
    }
  }

  _invalidWiggle(tileId) {
    const rec = this.tiles.get(tileId);
    if (!rec) return;
    const mesh = rec.mesh;
    const x0 = mesh.position.x;
    const dur = this.reducedMotion ? 0.06 : 0.32;
    this._tweenCustom(dur, (t) => {
      mesh.position.x = x0 + Math.sin(t * Math.PI * 6) * 0.05 * (1 - t);
    });
  }

  _winSequence() {
    this._anchorLocked = true;
    this.rig.setAnchor('win');
    this.rig.shake(2);
    const center = new THREE.Vector3(0, 1, -0.5);
    this._spawnBurst(center, new THREE.Color(0xffe9a8), 2);
    this._spawnBurst(new THREE.Vector3(0, 0.4, 3.4), new THREE.Color(this.theme.petal), 1.5);
  }

  _loseSequence() {
    this._anchorLocked = true;
    this._aim('top');
    this.rig.shake(1);
  }

  releaseCamera() {
    this._anchorLocked = false;
    this.resetCamera();
  }

  // -------------------------------------------------------------------------
  // Tweens + bursts + pulses
  // -------------------------------------------------------------------------

  _tween(vec3Prop, to, dur, ease = EASE.outCubic) {
    const from = { x: vec3Prop.x, y: vec3Prop.y, z: vec3Prop.z };
    const target = { ...from, ...to };
    this.tweens.push({
      t: 0,
      dur: Math.max(dur, 0.001),
      fn: (k) => {
        const e = ease(k);
        vec3Prop.x = from.x + (target.x - from.x) * e;
        vec3Prop.y = from.y + (target.y - from.y) * e;
        vec3Prop.z = from.z + (target.z - from.z) * e;
      },
    });
  }

  _tweenCustom(dur, fn) {
    this.tweens.push({ t: 0, dur: Math.max(dur, 0.001), fn });
  }

  /** Settle every cosmetic object into its deterministic end state. */
  finishAll() {
    for (const tw of this.tweens) tw.fn(1);
    this.tweens.length = 0;
    for (const b of this.bursts) {
      b.active = false;
      b.points.visible = false;
    }
    if (this.lastState) this.reconcile(this.lastState, { instant: true });
  }

  _spawnBurst(origin, color, power = 1) {
    const b = this.bursts[this._burstIndex++ % this.bursts.length];
    const rand = this.fxRand; // seeded audiovisual stream — replay-consistent
    const pos = b.points.geometry.attributes.position;
    const col = b.points.geometry.attributes.color;
    b.count = this.burstCount ?? MAX_BURST;
    b.points.geometry.setDrawRange(0, b.count);
    const n = b.count;
    for (let i = 0; i < n; i++) {
      pos.setXYZ(i, origin.x, origin.y, origin.z);
      const a = rand.range(0, Math.PI * 2);
      const up = rand.range(1.2, 3.6) * power;
      const out = rand.range(0.4, 2.0) * power;
      b.velocities[i * 3] = Math.cos(a) * out;
      b.velocities[i * 3 + 1] = up;
      b.velocities[i * 3 + 2] = Math.sin(a) * out;
      const shade = rand.range(0.75, 1);
      col.setXYZ(i, color.r * shade, color.g * shade, color.b * shade);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    b.life = 0;
    b.maxLife = this.reducedMotion ? 0.4 : 1.1;
    b.active = true;
    b.points.visible = true;
  }

  _spawnPulse(origin, color) {
    const ring = this.focusRing.clone();
    ring.material = this.focusRing.material.clone();
    ring.material.color.copy(color);
    ring.material.opacity = 0.85;
    ring.position.copy(origin);
    ring.position.y = Math.max(0.2, origin.y - 0.2);
    ring.layers.set(LAYER_FX);
    ring.raycast = () => {};
    this.scene.add(ring);
    const dur = this.reducedMotion ? 0.25 : 0.6;
    this._tweenCustom(dur, (t) => {
      ring.scale.setScalar(1 + t * 2.2);
      ring.material.opacity = 0.85 * (1 - t);
      if (t >= 1) {
        this.scene.remove(ring);
        ring.material.dispose();
      }
    });
  }

  // -------------------------------------------------------------------------
  // Hover / focus / preview
  // -------------------------------------------------------------------------

  pickTile(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this._pointer.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this.camera);
    this._raycaster.layers.set(LAYER_GAME);
    const pickables = [];
    for (const [, rec] of this.tiles) {
      if (rec.exposed && !rec.inTray && !rec.cleared && rec.mesh.visible) pickables.push(rec.mesh);
    }
    const hits = this._raycaster.intersectObjects(pickables, false);
    return hits.length > 0 ? hits[0].object.userData.tileId : null;
  }

  setHover(tileId) {
    if (this.hovered === tileId) return;
    if (this.hovered) this._setTileLift(this.hovered, false);
    this.hovered = tileId;
    if (tileId) {
      this._setTileLift(tileId, true);
      this._showTrayPreview(tileId);
    } else {
      this.slotPreview.material.opacity = 0;
    }
    this.canvas.style.cursor = tileId ? 'pointer' : 'default';
  }

  _setTileLift(tileId, on) {
    const rec = this.tiles.get(tileId);
    if (!rec || rec.inTray || rec.cleared) return;
    // Materials are shared per symbol: never mutate the shared instance.
    // Give the hovered tile its own clone; restore the shared one on release.
    if (on) {
      if (!rec.ownMaterial) {
        rec.mesh.material = rec.mesh.material.clone();
        rec.ownMaterial = true;
      }
      rec.mesh.material.emissive?.set(0x2a2410);
    } else if (rec.ownMaterial) {
      rec.mesh.material.dispose();
      rec.mesh.material = this._materialFor(rec.sym, rec.exposed);
      rec.ownMaterial = false;
    }
    this._tween(rec.mesh.position, { y: rec.home.y + (on ? 0.14 : 0) }, 0.12, EASE.outQuad);
  }

  _showTrayPreview(tileId) {
    if (!this.lastState) return;
    const proj = projectSelect(this.lastState, tileId);
    if (!proj) return;
    const slotIdx = Math.min(proj.insertAt, this.lastState.trayCapacity - 1);
    this.slotWorldPosition(slotIdx, this.lastState.trayCapacity, this._tmpV2);
    this.slotPreview.position.set(this._tmpV2.x, 0.16, this._tmpV2.z);
    this.slotPreview.material.color.set(proj.wouldClear ? 0x7ac88a : proj.trayAfter >= this.lastState.trayCapacity ? 0xd05a4a : 0xffe9a8);
    this.slotPreview.material.opacity = 0.9;
  }

  setFocus(tileId) {
    this.focused = tileId;
    if (!tileId) {
      this.focusRing.material.opacity = 0;
      return;
    }
    const rec = this.tiles.get(tileId);
    if (!rec) return;
    this.focusRing.position.set(rec.mesh.position.x + this.boardGroup.position.x, 0.12, rec.mesh.position.z + this.boardGroup.position.z);
    this.focusRing.material.opacity = 0.85;
  }

  showHint(tileId) {
    const rec = this.tiles.get(tileId);
    if (!rec) return;
    this.hintRing.position.set(rec.mesh.position.x + this.boardGroup.position.x, 0.13, rec.mesh.position.z + this.boardGroup.position.z);
    const dur = this.reducedMotion ? 0.6 : 1.8;
    this._tweenCustom(dur, (t) => {
      const pulse = Math.sin(t * Math.PI * 3);
      this.hintRing.material.opacity = 0.9 * (1 - t) * (0.6 + 0.4 * pulse);
      this.hintRing.scale.setScalar(1 + 0.15 * pulse);
      if (t >= 1) this.hintRing.material.opacity = 0;
    });
  }

  /** Screen-space projection for DOM overlays aligned to 3D targets. */
  worldToScreen(world, out = {}) {
    this._tmpV.copy(world).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    out.x = rect.left + (this._tmpV.x * 0.5 + 0.5) * rect.width;
    out.y = rect.top + (-this._tmpV.y * 0.5 + 0.5) * rect.height;
    out.behind = this._tmpV.z > 1;
    return out;
  }

  tileScreenPosition(tileId) {
    const rec = this.tiles.get(tileId);
    if (!rec) return null;
    rec.mesh.getWorldPosition(this._tmpV2);
    return this.worldToScreen(this._tmpV2, {});
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  render(dtMs, { hidden = false } = {}) {
    if (this._disposed || !this.renderer) return;
    const dt = Math.min(dtMs / 1000, 0.1);
    if (!hidden) {
      this.time += dt;
      this.rig.update(dt);
      this._updateTweens(dt);
      this._updateBursts(dt);
      this._updateAmbient(dt);
      if (this._adapt(dtMs)) this.applyRenderScale();
      const [w, h] = this.size;
      const key = this._postKey(w, h);
      if (key !== this.postKey) {
        this.postKey = key;
        this._buildPost(w, h);
      }
      if (this.composer) {
        try {
          this.composer.render(dt);
        } catch {
          this.postFailed = true;
          this.composer = null;
          this.postKey = null;
          this.renderer.setRenderTarget(null);
          this.renderer.render(this.scene, this.camera);
        }
      } else {
        this.renderer.render(this.scene, this.camera);
      }
    }
  }

  _updateTweens(dt) {
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const tw = this.tweens[i];
      tw.t += dt;
      const k = Math.min(tw.t / tw.dur, 1);
      tw.fn(k);
      if (k >= 1) this.tweens.splice(i, 1);
    }
    // Focus ring idle pulse.
    if (this.focusRing.material.opacity > 0) {
      this.focusRing.material.opacity = 0.7 + Math.sin(this.time * 4) * 0.15;
    }
  }

  _updateBursts(dt) {
    for (const b of this.bursts) {
      if (!b.active) continue;
      b.life += dt;
      if (b.life >= b.maxLife) {
        b.active = false;
        b.points.visible = false;
        continue;
      }
      const pos = b.points.geometry.attributes.position;
      const fade = 1 - b.life / b.maxLife;
      const n = b.count;
      for (let i = 0; i < n; i++) {
        b.velocities[i * 3 + 1] -= 4.4 * dt;
        pos.setXYZ(
          i,
          pos.getX(i) + b.velocities[i * 3] * dt,
          pos.getY(i) + b.velocities[i * 3 + 1] * dt,
          pos.getZ(i) + b.velocities[i * 3 + 2] * dt,
        );
      }
      pos.needsUpdate = true;
      b.points.material.opacity = 0.95 * fade;
    }
  }

  _updateAmbient(dt) {
    // Decorative motion stops entirely for reduced motion or a static background.
    if (!this._ambientMoving()) {
      if (!this._ambientPosed) {
        this._ambientPosed = true;
        this.keyLight.intensity = this.keyBase;
        this._poseAmbient(0);
      }
      return;
    }
    this._ambientPosed = false;
    // Sun shimmer: a slow, very small breath in the key light (never a flicker).
    this.keyLight.intensity = this.keyBase * (1 + 0.025 * Math.sin(this.time * 0.6) + 0.012 * Math.sin(this.time * 1.7));
    if (this.steam.visible) this._updateSteam(dt);
    this._poseAmbient(dt);
  }

  _poseAmbient(dt) {
    // Petals drift downward and respawn above (bounded loop).
    for (let i = 0; i < this.petals.count; i++) {
      const p = this.petalData[i];
      p.y -= p.speed * dt;
      p.x += Math.sin(this.time * 0.6 + p.phase) * dt * 0.3;
      if (p.y < -3) {
        p.y = 9 + (i % 5);
        p.x = ((i * 7) % 28) - 14;
      }
      this._petalEuler.set(this.time * p.spin, p.phase, this.time * p.spin * 0.7);
      this._petalQuat.setFromEuler(this._petalEuler);
      this._petalMat4.compose(this._tmpV.set(p.x, p.y, p.z), this._petalQuat, this._tmpV2.set(1, 1, 1));
      this.petals.setMatrixAt(i, this._petalMat4);
    }
    this.petals.instanceMatrix.needsUpdate = true;

    // Mist slow swirl.
    const mp = this.mist.geometry.attributes.position;
    const n = Math.min(mp.count, this.mist.geometry.drawRange.count);
    for (let i = 0; i < n; i++) {
      const ph = this.mistSeeds[i * 2];
      const sp = this.mistSeeds[i * 2 + 1];
      const x = mp.getX(i);
      const z = mp.getZ(i);
      const a = Math.atan2(z, x) + sp * dt * 0.12;
      const r = Math.hypot(x, z);
      mp.setX(i, Math.cos(a) * r);
      mp.setZ(i, Math.sin(a) * r);
      mp.setY(i, mp.getY(i) + Math.sin(this.time * 0.4 + ph) * dt * 0.05);
    }
    mp.needsUpdate = true;

    // Islands bob; clouds drift.
    for (const isl of this.islands.children) {
      isl.position.y += Math.sin(this.time * 0.3 + isl.userData.bobPhase) * dt * 0.06;
    }
    for (const c of this.clouds.children) {
      c.position.x += c.userData.speed * dt;
      if (c.position.x > 36) c.position.x = -36;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unmasked GPU name when the browser exposes it (quietly; never logs). */
function readGpuName(renderer) {
  try {
    const gl = renderer.getContext();
    const firefox = /firefox/i.test(navigator.userAgent || '');
    if (!firefox) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
    }
    return String(gl.getParameter(gl.RENDERER) || '');
  } catch {
    return '';
  }
}

function isTouchDevice() {
  try {
    const ua = navigator.userAgent || '';
    return /Mobi|Android|iPhone|iPad/i.test(ua) || (window.matchMedia?.('(pointer: coarse)').matches && navigator.maxTouchPoints > 0);
  } catch {
    return false;
  }
}

// Authored sky hexes, darkened toward dusk so HUD text over the sky keeps its contrast.
function skyColor(hex) {
  return new THREE.Color(hex).multiplyScalar(0.62);
}

// Mist sprites take a little of the theme's haze so the cloud sea sits in the scene.
function mistColor(theme) {
  return new THREE.Color(0xffffff).lerp(new THREE.Color(theme.fog), 0.35);
}
