/**
 * Renderer — everything Three.js. It knows nothing about game rules: it is told
 * where to put spheres (peg + level + player) and reports taps/hover on pegs.
 *
 * World layout (units ≈ "sphere diameters"):
 *   - 4×4 pegs, PITCH apart, centred on the origin, y is up
 *   - slot (peg, level) centre = BASE_TOP + R + level
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// ───────────────────────── constants ─────────────────────────
const PITCH = 1.3;            // distance between pegs
const R = 0.5;                // sphere radius
const BASE_H = 0.44;          // wooden base height
const BASE_TOP = BASE_H + 0.06;
const PEG_H = 4.5;            // visible peg height above BASE_TOP
const DROP_FROM = BASE_TOP + PEG_H + 1.3;
const GRAVITY = 42;
const RESTITUTION = 0.3;
const TARGET_Y = 2.45;        // orbit centre
const HIT_RADIUS = 0.66;      // forgiving pick radius around each peg axis
export const ACCENT = { 1: 0xffb454, 2: 0x62a4ff };
const DEG = Math.PI / 180;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** World position of a peg's centre line (y = 0) */
export function pegPosition(peg) {
  return new THREE.Vector3(((peg % 4) - 1.5) * PITCH, 0, (((peg / 4) | 0) - 1.5) * PITCH);
}
/** World position of a sphere slot centre */
export function slotPosition(peg, level) {
  const p = pegPosition(peg);
  p.y = BASE_TOP + R + level;
  return p;
}

// ───────────────────── procedural textures ─────────────────────
function canvasTexture(w, h, paint, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function woodTexture() {
  return canvasTexture(1024, 1024, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#34211a'); grad.addColorStop(1, '#2a1a13');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 520; i++) {
      const y = Math.random() * h, amp = 1 + Math.random() * 6;
      const f = 0.004 + Math.random() * 0.012, ph = Math.random() * 6.28;
      g.strokeStyle = Math.random() < 0.5
        ? `rgba(12,6,3,${Math.random() * 0.25})` : `rgba(140,86,52,${Math.random() * 0.16})`;
      g.lineWidth = 0.5 + Math.random() * 2.8;
      g.beginPath();
      for (let x = 0; x <= w; x += 16) {
        const yy = y + Math.sin(x * f + ph) * amp;
        x ? g.lineTo(x, yy) : g.moveTo(x, yy);
      }
      g.stroke();
    }
  });
}

/** Painted sphere skin for player 2: obsidian with a luminous equator band. */
function obsidianTextures() {
  const accent = '#' + ACCENT[2].toString(16);
  const map = canvasTexture(1024, 512, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#242836'); grad.addColorStop(0.5, '#171a25'); grad.addColorStop(1, '#242836');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    g.fillStyle = accent; g.fillRect(0, h / 2 - 34, w, 68);
    g.fillStyle = '#c9d4f0';
    g.fillRect(0, h / 2 - 66, w, 5); g.fillRect(0, h / 2 + 61, w, 5);
  });
  const emissive = canvasTexture(1024, 512, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.fillStyle = accent; g.fillRect(0, h / 2 - 34, w, 68);
    g.fillStyle = '#4a5878';
    g.fillRect(0, h / 2 - 66, w, 5); g.fillRect(0, h / 2 + 61, w, 5);
  });
  return { map, emissive };
}

function backgroundTexture() {
  return canvasTexture(512, 512, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h * 0.42, 10, w / 2, h * 0.5, h * 0.78);
    r.addColorStop(0, '#222a44'); r.addColorStop(0.55, '#0e111c'); r.addColorStop(1, '#05060a');
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  });
}

function radialAlphaTexture() {
  return canvasTexture(256, 256, (g, w, h) => {
    const r = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    r.addColorStop(0, '#fff'); r.addColorStop(0.45, '#bbb'); r.addColorStop(1, '#000');
    g.fillStyle = r; g.fillRect(0, 0, w, h);
  }, false);
}

// ───────────────────────── Renderer ─────────────────────────
export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{onHover?:(peg:number)=>void, onTap?:(peg:number, pointerType:string)=>void, onLand?:(strength:number)=>void}} handlers
   */
  constructor(canvas, handlers = {}) {
    this.canvas = canvas;
    this.h = handlers;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.mode = 'menu';

    this.spheres = new Map();      // key peg*4+level → Mesh
    this.drops = [];               // active falling spheres
    this.winSlots = null;
    this.winPlayer = 0;
    this.tween = null;
    this.frame = { x: 0, y: 0, z: 1, tx: 0, ty: 0, tz: 1 };
    this._dirty = true;
    this._slow = 0;
    this._last = performance.now();
    this._time = 0;
    this._disposed = false;

    this._initRenderer();
    this._initScene();
    this._initBoard();
    this._initMaterials();
    this._initFx();
    this._initControls();
    this._initPointer();

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
    this.resize(true);
    this.resetView(false);
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  // ─────────────── setup ───────────────
  _initRenderer() {
    const gl = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2); // cap for mobile perf
    gl.setPixelRatio(this.pixelRatio);
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1.05;
    this.gl = gl;
  }

  _initScene() {
    const scene = (this.scene = new THREE.Scene());
    this.bgTex = backgroundTexture();
    scene.background = this.bgTex;
    scene.fog = new THREE.FogExp2(0x090b12, 0.012);

    // HDR-like reflections from a procedural studio room
    const pmrem = new THREE.PMREMGenerator(this.gl);
    this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = this.envRT.texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);

    // key (shadow caster) + fill + rim + soft hemisphere
    const coarse = matchMedia('(pointer: coarse)').matches;
    const key = new THREE.DirectionalLight(0xfff0dc, 2.7);
    key.position.set(4.5, 14, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(coarse ? 1024 : 2048, coarse ? 1024 : 2048);
    Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6, near: 1, far: 30 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    scene.add(key, key.target);
    const fill = new THREE.DirectionalLight(0x9db8ff, 0.8);
    fill.position.set(-8, 5, 4);
    const rim = new THREE.DirectionalLight(0x7da6ff, 2.0);
    rim.position.set(-3, 6, -10);
    const hemi = new THREE.HemisphereLight(0x8a96b8, 0x0a0a10, 0.35);
    scene.add(fill, rim, hemi);

    // floor that fades into the background
    this.alphaTex = radialAlphaTexture();
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(15, 64),
      new THREE.MeshStandardMaterial({ color: 0x12141d, roughness: 0.85, metalness: 0, transparent: true, alphaMap: this.alphaTex, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
  }

  _initBoard() {
    const board = (this.board = new THREE.Group());
    this.scene.add(board);
    this.woodTex = woodTexture();
    this.woodTex.anisotropy = Math.min(8, this.gl.capabilities.getMaxAnisotropy());

    // walnut base (beveled) + matte-black playing plate
    const base = new THREE.Mesh(
      new RoundedBoxGeometry(5.7, BASE_H, 5.7, 5, 0.11),
      new THREE.MeshStandardMaterial({ map: this.woodTex, roughness: 0.5, metalness: 0.05 }),
    );
    base.position.y = BASE_H / 2;
    base.castShadow = base.receiveShadow = true;
    const plate = new THREE.Mesh(
      new RoundedBoxGeometry(5.05, 0.06, 5.05, 3, 0.026),
      new THREE.MeshStandardMaterial({ color: 0x0b0c11, roughness: 0.92, metalness: 0 }),
    );
    plate.position.y = BASE_H + 0.03;
    plate.receiveShadow = true;
    board.add(base, plate);

    // pegs, collars and caps as instanced meshes (3 draw calls for 48 parts)
    this.pegMat = new THREE.MeshStandardMaterial({ color: 0xe4e8f0, metalness: 1, roughness: 0.16, envMapIntensity: 1.9 });
    const pegGeo = new THREE.CylinderGeometry(0.075, 0.075, PEG_H, 20);
    const collarGeo = new THREE.CylinderGeometry(0.17, 0.21, 0.09, 28);
    const capGeo = new THREE.SphereGeometry(0.075, 16, 12);
    const pegs = new THREE.InstancedMesh(pegGeo, this.pegMat, 16);
    const collars = new THREE.InstancedMesh(collarGeo, this.pegMat, 16);
    const caps = new THREE.InstancedMesh(capGeo, this.pegMat, 16);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 16; i++) {
      const p = pegPosition(i);
      pegs.setMatrixAt(i, m.makeTranslation(p.x, BASE_TOP + PEG_H / 2, p.z));
      collars.setMatrixAt(i, m.makeTranslation(p.x, BASE_TOP + 0.045, p.z));
      caps.setMatrixAt(i, m.makeTranslation(p.x, BASE_TOP + PEG_H, p.z));
    }
    for (const im of [pegs, collars, caps]) { im.castShadow = true; im.receiveShadow = true; board.add(im); }
    this.instanced = [pegs, collars, caps];
    this.scene.updateMatrixWorld(true);
  }

  _initMaterials() {
    this.sphereGeo = new THREE.SphereGeometry(R, 44, 30);
    const { map, emissive } = obsidianTextures();
    this.skin = { map, emissive };
    const base = {
      1: new THREE.MeshPhysicalMaterial({
        color: 0xf5eee2, roughness: 0.2, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04,
        sheen: 0.7, sheenColor: new THREE.Color(0xffe0ae), sheenRoughness: 0.35,
      }),
      2: new THREE.MeshPhysicalMaterial({
        color: 0xffffff, map, emissive: 0xffffff, emissiveMap: emissive, emissiveIntensity: 0.55,
        roughness: 0.26, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.05,
      }),
    };
    const variant = (m, over) => Object.assign(m.clone(), over);
    this.mat = {
      base,
      ghost: {
        1: variant(base[1], { transparent: true, opacity: 0.55, depthWrite: false }),
        2: variant(base[2], { transparent: true, opacity: 0.6, depthWrite: false }),
      },
      dim: {
        1: variant(base[1], { transparent: true, opacity: 0.2, depthWrite: false }),
        2: variant(base[2], { transparent: true, opacity: 0.28, depthWrite: false }),
      },
      win: {
        1: variant(base[1], { emissive: new THREE.Color(ACCENT[1]), emissiveIntensity: 0.4 }),
        2: variant(base[2], { emissiveIntensity: 1 }),
      },
    };
    // ghost sphere (hover preview)
    this.ghost = new THREE.Mesh(this.sphereGeo, this.mat.ghost[1]);
    this.ghost.visible = false;
    this.ghost.renderOrder = 2;
    this.scene.add(this.ghost);
  }

  _initFx() {
    // hover marker: glowing ring on the base + faint light column
    const mk = (this.marker = new THREE.Group());
    this.markerMat = new THREE.MeshBasicMaterial({
      color: ACCENT[1], transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    this.columnMat = this.markerMat.clone();
    this.columnMat.opacity = 0.05;
    this.columnMat.side = THREE.DoubleSide;
    const ringGeo = new THREE.RingGeometry(0.4, 0.56, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const colGeo = new THREE.CylinderGeometry(0.5, 0.5, PEG_H + 0.4, 28, 1, true);
    const ring = new THREE.Mesh(ringGeo, this.markerMat);
    ring.position.y = BASE_TOP + 0.012;
    const col = new THREE.Mesh(colGeo, this.columnMat);
    col.position.y = BASE_TOP + (PEG_H + 0.4) / 2;
    mk.add(ring, col);
    mk.visible = false;
    this.scene.add(mk);

    // halo that marks the last move
    this.haloMat = new THREE.MeshBasicMaterial({ color: ACCENT[1], transparent: true, opacity: 0.9, toneMapped: false });
    this.halo = new THREE.Mesh(new THREE.TorusGeometry(R + 0.07, 0.022, 12, 56), this.haloMat);
    this.halo.rotation.x = Math.PI / 2;
    this.halo.visible = false;
    this.scene.add(this.halo);

    // win line (core + glow), unit cylinder scaled on demand
    this.lineGeo = new THREE.CylinderGeometry(1, 1, 1, 16, 1, true);
    const lm = (opacity) => new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity, blending: THREE.AdditiveBlending,
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.lineCore = new THREE.Mesh(this.lineGeo, lm(0.95));
    this.lineGlow = new THREE.Mesh(this.lineGeo, lm(0.28));
    this.lineCore.renderOrder = this.lineGlow.renderOrder = 10;
    this.lineCore.visible = this.lineGlow.visible = false;
    this.scene.add(this.lineCore, this.lineGlow);

    // confetti (one InstancedMesh)
    this.N = 200;
    this.confetti = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.13, 0.22),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, toneMapped: false }),
      this.N,
    );
    this.confetti.frustumCulled = false;
    this.confetti.visible = false;
    this.cf = {
      pos: new Float32Array(this.N * 3), vel: new Float32Array(this.N * 3),
      rot: new Float32Array(this.N * 3), spin: new Float32Array(this.N * 3),
      life: new Float32Array(this.N), alive: 0,
    };
    this.dummy = new THREE.Object3D();
    this.scene.add(this.confetti);
  }

  _initControls() {
    const c = (this.controls = new OrbitControls(this.camera, this.canvas));
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.enablePan = false;
    c.rotateSpeed = 0.7;
    c.zoomSpeed = 0.8;
    c.minPolarAngle = 12 * DEG;
    c.maxPolarAngle = 93 * DEG; // never below the board plane
    c.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }; // one-finger rotate, pinch zoom
    c.target.set(0, TARGET_Y, 0);
    c.addEventListener('start', () => { this.tween = null; });
    c.addEventListener('change', () => { this._dirty = true; });
  }

  _initPointer() {
    this.ray = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    const cv = this.canvas;
    this._ptr = new Map();
    this._tap = null;
    this._hoverPeg = -1;
    this._pendingMove = null;

    this._onDown = (e) => {
      this._ptr.set(e.pointerId, true);
      if (this._ptr.size === 1) {
        this._tap = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), ok: true, type: e.pointerType };
      } else if (this._tap) {
        this._tap.ok = false; // a second finger (pinch) cancels the tap
      }
    };
    this._onMove = (e) => {
      const tap = this._tap;
      if (tap && tap.id === e.pointerId && tap.ok) {
        const lim = e.pointerType === 'mouse' ? 6 : 10;
        if (Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > lim) {
          tap.ok = false; // it's a drag-to-rotate
          if (this._hoverPeg !== -1) { this._hoverPeg = -1; this.h.onHover?.(-1); }
        }
      }
      if (e.pointerType === 'mouse' && e.buttons === 0) this._pendingMove = { x: e.clientX, y: e.clientY };
    };
    this._onUp = (e) => {
      const tap = this._tap;
      this._ptr.delete(e.pointerId);
      if (tap && tap.id === e.pointerId) {
        this._tap = null;
        if (tap.ok && performance.now() - tap.t < 600 && e.type === 'pointerup') {
          this.h.onTap?.(this.pick(e.clientX, e.clientY), tap.type);
        }
      }
    };
    this._onLeave = (e) => {
      if (e.pointerType === 'mouse') { this._pendingMove = null; if (this._hoverPeg !== -1) { this._hoverPeg = -1; this.h.onHover?.(-1); } }
    };
    cv.addEventListener('pointerdown', this._onDown);
    cv.addEventListener('pointermove', this._onMove);
    cv.addEventListener('pointerup', this._onUp);
    cv.addEventListener('pointercancel', this._onUp);
    cv.addEventListener('pointerleave', this._onLeave);
    this._noCtx = (e) => e.preventDefault();
    cv.addEventListener('contextmenu', this._noCtx);
  }

  /**
   * Which peg is under the pointer? → peg index or -1.
   * 1) Whatever visible peg/sphere the ray hits first wins (what you see is what you get).
   * 2) Otherwise the peg whose axis passes closest to the ray, within a generous radius —
   *    an invisible, forgiving hit area that makes pegs easy to hit with a thumb.
   */
  pick(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);

    const targets = [...this.instanced, ...this.spheres.values()];
    const hit = this.ray.intersectObjects(targets, false)[0];
    if (hit) return hit.instanceId !== undefined ? hit.instanceId : hit.object.userData.peg;

    const { origin, direction: d } = this.ray.ray;
    let best = -1, bestDist = HIT_RADIUS, bestS = Infinity;
    for (let i = 0; i < 16; i++) {
      const px = ((i % 4) - 1.5) * PITCH, pz = (((i / 4) | 0) - 1.5) * PITCH;
      // closest approach between the ray and the vertical peg axis (segment)
      const wx = origin.x - px, wy = origin.y - BASE_TOP, wz = origin.z - pz;
      const b = d.y, dw = d.x * wx + d.y * wy + d.z * wz, e = wy;
      const den = 1 - b * b;
      let t = den > 1e-6 ? (e - b * dw) / den : e;
      t = clamp(t, 0, PEG_H + 0.4);
      const s = Math.max(0, b * t - dw);
      const dx = wx + s * d.x, dy = wy + s * d.y - t, dz = wz + s * d.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < bestDist - 1e-4 || (Math.abs(dist - bestDist) <= 1e-4 && s < bestS)) { best = i; bestDist = dist; bestS = s; }
    }
    return best;
  }

  // ─────────────── public API ───────────────
  /** Preview the next sphere: ghost on top of the stack + highlighted peg. peg<0 hides. */
  setAim(peg, level, player) {
    if (peg < 0 || level > 3) {
      this.ghost.visible = false;
      this.marker.visible = false;
      this._dirty = true;
      return;
    }
    const p = slotPosition(peg, level);
    this.ghost.material = this.mat.ghost[player];
    this.ghost.position.copy(p);
    this._ghostY = p.y;
    this.ghost.visible = true;
    this.marker.position.set(p.x, 0, p.z);
    this.markerMat.color.setHex(ACCENT[player]);
    this.columnMat.color.setHex(ACCENT[player]);
    this.marker.visible = true;
    this._dirty = true;
  }

  /** Falling sphere with gravity + bounce. Resolves when it has settled. */
  drop(peg, level, player) {
    this.setAim(-1);
    const mesh = this._makeSphere(peg, level, player);
    const target = slotPosition(peg, level).y;
    mesh.position.y = DROP_FROM;
    const rm = this.reducedMotion;
    return new Promise((resolve) => {
      this.drops.push({
        mesh, peg, level, player, target, y: rm ? target + 1.2 : DROP_FROM, vy: 0,
        bounces: 0, sq: 0, settled: false, resolve, restitution: rm ? 0 : RESTITUTION,
      });
      this._dirty = true;
    });
  }

  /** Put a sphere in place instantly (menu demo, resync). */
  place(peg, level, player) {
    this._makeSphere(peg, level, player);
    this._dirty = true;
  }

  /** Remove a sphere (undo). */
  remove(peg, level) {
    const key = peg * 4 + level;
    const d = this.drops.findIndex((x) => x.peg === peg && x.level === level);
    if (d >= 0) { this.drops[d].resolve(); this.drops.splice(d, 1); }
    const m = this.spheres.get(key);
    if (m) { this.scene.remove(m); this.spheres.delete(key); }
    this._dirty = true;
  }

  clear() {
    this.clearResult();
    this.drops.forEach((d) => d.resolve());
    this.drops.length = 0;
    this.spheres.forEach((m) => this.scene.remove(m));
    this.spheres.clear();
    this.halo.visible = false;
    this.setAim(-1);
  }

  markLast(peg, level, player) {
    if (peg == null || peg < 0) { this.halo.visible = false; this._dirty = true; return; }
    this.halo.position.copy(slotPosition(peg, level));
    this.haloMat.color.setHex(ACCENT[player]);
    this.halo.visible = true;
    this._dirty = true;
  }

  /** Win presentation: dim others, pulse winners, glowing line, camera orbit, confetti. */
  showWin(slots, player) {
    this.winSlots = slots;
    this.winPlayer = player;
    this.halo.visible = false;
    const winKeys = new Set(slots.map((s) => s.peg * 4 + s.level));
    this.spheres.forEach((mesh, key) => {
      mesh.material = winKeys.has(key) ? this.mat.win[mesh.userData.player] : this.mat.dim[mesh.userData.player];
      mesh.castShadow = winKeys.has(key);
    });
    // glowing line through the four centres, slightly overshooting both ends
    const a = slotPosition(slots[0].peg, slots[0].level);
    const b = slotPosition(slots[3].peg, slots[3].level);
    const dir = b.clone().sub(a);
    const len = dir.length() + R * 1.7;
    dir.normalize();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    for (const [mesh, rad] of [[this.lineCore, 0.045], [this.lineGlow, 0.17]]) {
      mesh.position.copy(mid);
      mesh.quaternion.copy(q);
      mesh.scale.set(rad, len, rad);
      mesh.material.color.setHex(ACCENT[player]).lerp(new THREE.Color(0xffffff), mesh === this.lineCore ? 0.55 : 0.1);
      mesh.visible = true;
    }
    this.winMid = mid;
    this.burst(mid, player);
    this.cinematic(mid);
    this._dirty = true;
  }

  /** Draw: just a slow orbit. */
  showDraw() {
    this.halo.visible = false;
    this.cinematic(new THREE.Vector3(0, TARGET_Y, 0));
  }

  clearResult() {
    this.winSlots = null;
    this.lineCore.visible = this.lineGlow.visible = false;
    this.spheres.forEach((m) => {
      m.material = this.mat.base[m.userData.player];
      m.castShadow = true;
      m.scale.setScalar(1);
    });
    this.cf.alive = 0;
    this.confetti.visible = false;
    if (this.mode === 'game') this.controls.autoRotate = false;
    this._dirty = true;
  }

  /** Set the rendering mode: 'menu' (slow idle rotation) or 'game'. */
  setMode(mode) {
    this.mode = mode;
    const idle = mode === 'menu' && !this.reducedMotion;
    this.controls.autoRotate = idle;
    this.controls.autoRotateSpeed = 0.9;
    this._dirty = true;
  }

  /** Shift/scale the board in the viewport (x, y as fractions of width/height; z = zoom) to make room for UI. */
  setFrame(x, y, z = 1, instant = false) {
    Object.assign(this.frame, { tx: x, ty: y, tz: z });
    if (instant || this.reducedMotion) { Object.assign(this.frame, { x, y, z }); this._applyFrame(); }
    this._dirty = true;
  }

  azimuth() { return this.controls.getAzimuthalAngle(); }

  resetView(animated = true) {
    this.flyTo({ target: new THREE.Vector3(0, TARGET_Y, 0), polar: 58 * DEG, azimuth: 0, distance: this.fitDistance() }, animated ? 0.8 : 0);
  }

  // ─────────────── camera ───────────────
  fitDistance() {
    const cam = this.camera;
    const vh = Math.tan((cam.fov * DEG) / 2);
    const hh = vh * cam.aspect;
    const dv = 5.0 / vh;
    const dh = 3.8 / hh;
    return Math.max(dv, dh);
  }

  flyTo({ target, polar, azimuth, distance }, seconds = 1) {
    const cam = this.camera, ctl = this.controls;
    const from = new THREE.Spherical().setFromVector3(cam.position.clone().sub(ctl.target));
    if (seconds <= 0 || this.reducedMotion) {
      this._setPose(target, polar, azimuth, distance);
      this.tween = null;
      return;
    }
    // shortest way around for azimuth
    let dAz = azimuth - from.theta;
    dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
    this.tween = {
      t: 0, dur: seconds, fromTarget: ctl.target.clone(), toTarget: target.clone(),
      fromR: from.radius, toR: distance, fromPhi: from.phi, toPhi: polar, fromTheta: from.theta, dTheta: dAz,
    };
    this._dirty = true;
  }

  _setPose(target, polar, azimuth, distance) {
    const s = new THREE.Spherical(distance, clamp(polar, 0.05, 3), azimuth);
    this.controls.target.copy(target);
    this.camera.position.setFromSpherical(s).add(target);
    this.camera.lookAt(target);
    this.controls.update();
    this._dirty = true;
  }

  cinematic(center) {
    const target = new THREE.Vector3(0, TARGET_Y, 0).lerp(center, 0.4);
    const az = this.controls.getAzimuthalAngle();
    this.flyTo({ target, polar: 62 * DEG, azimuth: az + 0.9, distance: this.fitDistance() * 0.86 }, 2.2);
    if (!this.reducedMotion) {
      this.controls.autoRotate = true;
      this.controls.autoRotateSpeed = 1.3;
    }
  }

  // ─────────────── internals ───────────────
  _makeSphere(peg, level, player) {
    const key = peg * 4 + level;
    const old = this.spheres.get(key);
    if (old) this.scene.remove(old);
    const mesh = new THREE.Mesh(this.sphereGeo, this.mat.base[player]);
    mesh.position.copy(slotPosition(peg, level));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { peg, level, player };
    // P2's painted band should sit on the equator, slightly varied so stacks don't look cloned
    mesh.rotation.y = player === 2 ? (peg * 1.7 + level) % 6.28 : 0;
    this.scene.add(mesh);
    this.spheres.set(key, mesh);
    return mesh;
  }

  burst(origin, player) {
    if (this.reducedMotion) return;
    const cf = this.cf, N = this.N;
    const palette = [ACCENT[player], 0xffffff, 0xffd98a, ACCENT[player === 1 ? 2 : 1]].map((h) => new THREE.Color(h));
    for (let i = 0; i < N; i++) {
      const j = i * 3;
      cf.pos[j] = origin.x + (Math.random() - 0.5) * 0.6;
      cf.pos[j + 1] = origin.y + (Math.random() - 0.5) * 0.6;
      cf.pos[j + 2] = origin.z + (Math.random() - 0.5) * 0.6;
      const ang = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5.5;
      cf.vel[j] = Math.cos(ang) * sp;
      cf.vel[j + 1] = 5 + Math.random() * 6;
      cf.vel[j + 2] = Math.sin(ang) * sp;
      cf.rot[j] = Math.random() * 6; cf.rot[j + 1] = Math.random() * 6; cf.rot[j + 2] = Math.random() * 6;
      cf.spin[j] = (Math.random() - 0.5) * 16; cf.spin[j + 1] = (Math.random() - 0.5) * 16; cf.spin[j + 2] = (Math.random() - 0.5) * 16;
      cf.life[i] = 2.4 + Math.random() * 1.8;
      this.confetti.setColorAt(i, palette[(Math.random() * palette.length) | 0]);
    }
    this.confetti.instanceColor.needsUpdate = true;
    cf.alive = N;
    this.confetti.visible = true;
  }

  resize(force) {
    const cv = this.canvas;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    if (!force && w === this._w && h === this._h) return;
    const oldFit = this._w ? this.fitDistance() : 0;
    this._w = w; this._h = h;
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // keep the user's zoom proportional when the viewport changes (rotation, keyboard…)
    if (oldFit) {
      const f = this.fitDistance() / oldFit;
      const off = this.camera.position.clone().sub(this.controls.target).multiplyScalar(f);
      this.camera.position.copy(this.controls.target).add(off);
    }
    const fit = this.fitDistance();
    this.controls.minDistance = fit * 0.45;
    this.controls.maxDistance = fit * 1.4;
    this._applyFrame();
    this._dirty = true;
  }

  _applyFrame() {
    const f = this.frame, w = this._w, h = this._h;
    if (!w) return;
    this.camera.zoom = f.z;
    if (Math.abs(f.x) < 1e-3 && Math.abs(f.y) < 1e-3) { this.camera.clearViewOffset(); this.camera.updateProjectionMatrix(); }
    else this.camera.setViewOffset(w, h, -f.x * w, f.y * h, w, h);
  }

  _loop(now) {
    if (this._disposed) return;
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min(0.05, (now - this._last) / 1000 || 0.016);
    this._last = now;
    this._time += dt;
    this._update(dt, this._time);
  }

  _update(dt, t) {
    let busy = false;

    // mouse hover is processed at most once per frame
    if (this._pendingMove) {
      const peg = this.pick(this._pendingMove.x, this._pendingMove.y);
      this._pendingMove = null;
      if (peg !== this._hoverPeg) { this._hoverPeg = peg; this.h.onHover?.(peg); }
    }

    // falling spheres
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      busy = true;
      if (!d.settled) {
        d.vy -= GRAVITY * dt;
        d.y += d.vy * dt;
        if (d.y <= d.target) {
          const speed = -d.vy;
          d.y = d.target;
          if (d.bounces === 0) this.h.onLand?.(clamp(speed / 14, 0.2, 1));
          if (d.restitution > 0 && speed > 2.2 && d.bounces < 2) {
            d.vy = speed * d.restitution; d.bounces++;
            d.sq = Math.min(0.16, speed * 0.012);
          } else {
            d.vy = 0; d.settled = true; d.resolve();
          }
        }
      }
      d.sq *= Math.exp(-dt * 12);
      const sq = d.sq;
      d.mesh.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);
      d.mesh.position.y = d.y - R * sq;
      if (d.settled && d.sq < 0.003) {
        d.mesh.scale.setScalar(1);
        d.mesh.position.y = d.target;
        this.drops.splice(i, 1);
      }
    }

    // camera tween
    if (this.tween) {
      const tw = this.tween;
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const k = easeInOut(tw.t);
      const target = tw.fromTarget.clone().lerp(tw.toTarget, k);
      const s = new THREE.Spherical(
        tw.fromR + (tw.toR - tw.fromR) * k,
        clamp(tw.fromPhi + (tw.toPhi - tw.fromPhi) * k, 0.05, 3),
        tw.fromTheta + tw.dTheta * k,
      );
      this.controls.target.copy(target);
      this.camera.position.setFromSpherical(s).add(target);
      if (tw.t >= 1) this.tween = null;
      busy = true;
    }

    // frame (view offset) easing
    const f = this.frame;
    if (Math.abs(f.tx - f.x) > 1e-4 || Math.abs(f.ty - f.y) > 1e-4 || Math.abs(f.tz - f.z) > 1e-4) {
      const k = 1 - Math.exp(-dt * 7);
      f.x += (f.tx - f.x) * k; f.y += (f.ty - f.y) * k; f.z += (f.tz - f.z) * k;
      if (Math.abs(f.tx - f.x) < 5e-4) f.x = f.tx;
      if (Math.abs(f.ty - f.y) < 5e-4) f.y = f.ty;
      if (Math.abs(f.tz - f.z) < 5e-4) f.z = f.tz;
      this._applyFrame();
      busy = true;
    }

    // ghost + marker animation
    if (this.ghost.visible) {
      if (!this.reducedMotion) {
        this.ghost.position.y = this._ghostY + Math.sin(t * 3.2) * 0.05;
        this.markerMat.opacity = 0.6 + 0.25 * Math.sin(t * 4);
        busy = true;
      }
    }

    // win pulse
    if (this.winSlots) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 4.2);
      this.mat.win[1].emissiveIntensity = 0.25 + 0.55 * pulse;
      this.mat.win[2].emissiveIntensity = 0.9 + 1.2 * pulse;
      this.lineGlow.material.opacity = 0.2 + 0.2 * pulse;
      const sc = 1 + 0.05 * pulse;
      for (const s of this.winSlots) {
        const m = this.spheres.get(s.peg * 4 + s.level);
        if (m) m.scale.setScalar(sc);
      }
      busy = true;
    }

    // confetti
    if (this.cf.alive > 0) {
      const cf = this.cf, dm = this.dummy;
      let alive = 0;
      for (let i = 0; i < this.N; i++) {
        const j = i * 3;
        if (cf.life[i] > 0) {
          cf.life[i] -= dt;
          cf.vel[j + 1] -= 9.5 * dt;
          const drag = Math.exp(-dt * 0.9);
          cf.vel[j] *= drag; cf.vel[j + 2] *= drag; cf.vel[j + 1] *= Math.exp(-dt * 0.3);
          cf.pos[j] += cf.vel[j] * dt; cf.pos[j + 1] += cf.vel[j + 1] * dt; cf.pos[j + 2] += cf.vel[j + 2] * dt;
          if (cf.pos[j + 1] < BASE_TOP + 0.02) { cf.pos[j + 1] = BASE_TOP + 0.02; cf.vel[j] *= 0.6; cf.vel[j + 2] *= 0.6; cf.vel[j + 1] = 0; cf.spin[j] *= 0.5; cf.spin[j + 1] *= 0.5; cf.spin[j + 2] *= 0.5; }
          cf.rot[j] += cf.spin[j] * dt; cf.rot[j + 1] += cf.spin[j + 1] * dt; cf.rot[j + 2] += cf.spin[j + 2] * dt;
          const s = clamp(cf.life[i] / 0.6, 0, 1);
          dm.position.set(cf.pos[j], cf.pos[j + 1], cf.pos[j + 2]);
          dm.rotation.set(cf.rot[j], cf.rot[j + 1], cf.rot[j + 2]);
          dm.scale.setScalar(s);
          dm.updateMatrix();
          this.confetti.setMatrixAt(i, dm.matrix);
          alive++;
        } else if (cf.life[i] > -1) {
          cf.life[i] = -1;
          dm.scale.setScalar(0); dm.updateMatrix();
          this.confetti.setMatrixAt(i, dm.matrix);
        }
      }
      this.confetti.instanceMatrix.needsUpdate = true;
      cf.alive = alive;
      if (!alive) this.confetti.visible = false;
      busy = true;
    }

    const moved = this.controls.update(dt);
    if (busy || moved || this._dirty) {
      this.gl.render(this.scene, this.camera);
      this._dirty = false;
      this._adapt(dt, busy || moved);
    }
  }

  /** Lower the pixel ratio if sustained frame times are too slow (mid-range phones). */
  _adapt(dt, continuous) {
    if (!continuous || this.pixelRatio <= 1) { this._slow = Math.max(0, this._slow - dt); return; }
    this._slow += dt > 0.026 ? dt : -dt * 0.5;
    if (this._slow > 1.2) {
      this._slow = 0;
      this.pixelRatio = Math.max(1, this.pixelRatio - 0.25);
      this.gl.setPixelRatio(this.pixelRatio);
      this.gl.setSize(this._w, this._h, false);
    }
  }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    const cv = this.canvas;
    cv.removeEventListener('pointerdown', this._onDown);
    cv.removeEventListener('pointermove', this._onMove);
    cv.removeEventListener('pointerup', this._onUp);
    cv.removeEventListener('pointercancel', this._onUp);
    cv.removeEventListener('pointerleave', this._onLeave);
    cv.removeEventListener('contextmenu', this._noCtx);
    this.controls.dispose();
    this.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      mats.forEach((m) => m.dispose());
    });
    Object.values(this.mat.base).forEach((m) => m.dispose());
    ['ghost', 'dim', 'win'].forEach((k) => Object.values(this.mat[k]).forEach((m) => m.dispose()));
    [this.bgTex, this.alphaTex, this.woodTex, this.skin.map, this.skin.emissive].forEach((t) => t && t.dispose());
    this.sphereGeo.dispose();
    this.lineGeo.dispose();
    this.envRT.dispose();
    this.gl.dispose();
  }
}
