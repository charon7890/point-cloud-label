import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const SEMANTIC_PALETTE = [
  [0.45, 0.76, 0.98],
  [0.98, 0.45, 0.45],
  [0.45, 0.86, 0.55],
  [0.98, 0.78, 0.35],
  [0.72, 0.54, 0.96],
  [0.35, 0.86, 0.86],
  [0.96, 0.55, 0.75],
  [0.82, 0.82, 0.45],
];

function heightColor(t, target, offset) {
  const x = Math.max(0, Math.min(1, t));
  target[offset] = Math.min(1, Math.max(0, 1.5 - Math.abs(x - 0.75) * 4));
  target[offset + 1] = Math.min(1, Math.max(0, 1.5 - Math.abs(x - 0.5) * 4));
  target[offset + 2] = Math.min(1, Math.max(0, 1.5 - Math.abs(x - 0.25) * 4));
}

export function instanceRgb(id) {
  const hue = (id * 0.61803398875) % 1;
  const x = 1 - Math.abs((hue * 6) % 2 - 1);
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 1 / 6) {
    r = 1;
    g = x;
  } else if (hue < 2 / 6) {
    r = x;
    g = 1;
  } else if (hue < 3 / 6) {
    g = 1;
    b = x;
  } else if (hue < 4 / 6) {
    g = x;
    b = 1;
  } else if (hue < 5 / 6) {
    r = x;
    b = 1;
  } else {
    r = 1;
    b = x;
  }
  return [0.18 + r * 0.82, 0.18 + g * 0.82, 0.18 + b * 0.82];
}

function disposeObject(object) {
  if (!object) return;
  object.parent?.remove(object);
  object.geometry?.dispose();
  object.material?.dispose();
}

function disposeChunks(chunks) {
  if (!chunks?.length) return;
  const material = chunks[0].material;
  for (const object of chunks) {
    object.parent?.remove(object);
    object.geometry?.dispose();
  }
  material?.dispose();
  chunks.length = 0;
}

function centerCloud(cloud) {
  if (!cloud || cloud.centered) return;
  const pos = cloud.positions;
  const n = cloud.count;
  if (!n) return;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i += 1) {
    cx += pos[i * 3];
    cy += pos[i * 3 + 1];
    cz += pos[i * 3 + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  for (let i = 0; i < n; i += 1) {
    pos[i * 3] -= cx;
    pos[i * 3 + 1] -= cy;
    pos[i * 3 + 2] -= cz;
  }
  cloud.centered = true;
}

const DRAW_CHUNK = 250000;

function addPointChunks(scene, positions, colors, material) {
  const chunks = [];
  const n = positions.length / 3;
  for (let start = 0; start < n; start += DRAW_CHUNK) {
    const count = Math.min(DRAW_CHUNK, n - start);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(positions.slice(start * 3, (start + count) * 3), 3)
    );
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(colors.slice(start * 3, (start + count) * 3), 3)
    );
    geometry.computeBoundingSphere();
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);
    chunks.push(points);
  }
  return chunks;
}

export class PointCloudViewer {
  constructor(container) {
    this.container = container;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0d11);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(40, -40, 30);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x0b0d11, 1);
    const canvas = this.renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    container.appendChild(canvas);
    container.style.touchAction = "none";
    this.controls = new OrbitControls(this.camera, container);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enableRotate = true;
    this.controls.enableZoom = true;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = true;
    this.controls.zoomToCursor = false;
    this.controls.rotateSpeed = 1.1;
    this.controls.zoomSpeed = 1.6;
    this.controls.panSpeed = 0.9;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: null,
    };
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };
    this.points = null;
    this.ghostPoints = null;
    this.pointChunks = [];
    this.ghostChunks = [];
    this._opaqueMaterial = null;
    this._ghostMaterial = null;
    this.cloud = null;
    this.colorMode = "instance";
    this.pointSize = 1.8;
    this.labeled = new Map();
    this.selectedInstance = null;
    this.onInstanceClick = null;
    this._fitted = null;
    this._boxHelper = null;
    this._pointerDown = null;
    this._rightPan = null;
    this._lastRightDown = 0;
    this.viewDragMode = false;
    this._panKeys = { KeyW: false, KeyA: false, KeyS: false, KeyD: false };
    this._panV = new THREE.Vector3();
    this._panOffset = new THREE.Vector3();
    this._proj = new THREE.Matrix4();
    this._box3 = new THREE.Box3();
    this._syncClip = () => this._syncClipPlanes();
    this.controls.addEventListener("change", this._syncClip);
    this._resize = () => this.resize();
    window.addEventListener("resize", this._resize);
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this.resize();
    this._bindPicking();
    this._bindViewDrag();
    this._tick = () => {
      this.controls.update();
      this._applyKeyPan();
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(this._tick);
    };
    this._tick();
  }

  _bindPicking() {
    const el = this.container;
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      this._pointerDown = { x: event.clientX, y: event.clientY };
    });
    el.addEventListener("pointerup", (event) => {
      if (event.button !== 0 || !this._pointerDown) return;
      const dx = event.clientX - this._pointerDown.x;
      const dy = event.clientY - this._pointerDown.y;
      this._pointerDown = null;
      if (dx * dx + dy * dy > 25) return;
      this.pickAt(event.clientX, event.clientY);
    });
    el.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
      },
      { passive: false }
    );
    el.addEventListener("contextmenu", (event) => event.preventDefault());
  }

  panScreen(deltaX, deltaY) {
    if (!deltaX && !deltaY) return;
    const camera = this.camera;
    const target = this.controls.target;
    camera.updateMatrixWorld();
    const height = Math.max(1, this.renderer.domElement.clientHeight || this.container.clientHeight || 1);
    const distance = Math.max(camera.position.distanceTo(target), 0.01);
    const factor = (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / height;
    this._panOffset.set(0, 0, 0);
    this._panV.setFromMatrixColumn(camera.matrixWorld, 0);
    if (this._panV.lengthSq() < 1e-10) this._panV.set(1, 0, 0);
    else this._panV.normalize();
    this._panOffset.addScaledVector(this._panV, -deltaX * factor);
    this._panV.setFromMatrixColumn(camera.matrixWorld, 1);
    if (this._panV.lengthSq() < 1e-10) this._panV.set(0, 0, 1);
    else this._panV.normalize();
    this._panOffset.addScaledVector(this._panV, deltaY * factor);
    camera.position.add(this._panOffset);
    target.add(this._panOffset);
    this._syncClipPlanes();
  }

  setPanKey(code, down) {
    if (code in this._panKeys) this._panKeys[code] = Boolean(down);
  }

  clearPanKeys() {
    this._panKeys.KeyW = false;
    this._panKeys.KeyA = false;
    this._panKeys.KeyS = false;
    this._panKeys.KeyD = false;
  }

  _applyKeyPan() {
    const keys = this._panKeys;
    const speed = 18;
    let dx = 0;
    let dy = 0;
    if (keys.KeyA) dx -= speed;
    if (keys.KeyD) dx += speed;
    if (keys.KeyW) dy -= speed;
    if (keys.KeyS) dy += speed;
    if (!dx && !dy) return;
    this.panScreen(dx, dy);
  }

  setViewDragMode(on) {
    this.viewDragMode = Boolean(on);
    this.controls.mouseButtons.LEFT = this.viewDragMode ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    this.container.style.cursor = this.viewDragMode ? "grab" : "";
  }

  _bindViewDrag() {
    const el = this.container;
    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 2) return;
      event.preventDefault();
      const now = performance.now();
      const dbl = now - this._lastRightDown < 450;
      this._lastRightDown = now;
      this._rightPan = {
        x: event.clientX,
        y: event.clientY,
        moved: false,
        dbl,
      };
      try {
        el.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    });
    el.addEventListener("pointermove", (event) => {
      if (!this._rightPan || !(event.buttons & 2)) return;
      const dx = event.clientX - this._rightPan.x;
      const dy = event.clientY - this._rightPan.y;
      if (!dx && !dy) return;
      this._rightPan.moved = true;
      this.panScreen(dx, dy);
      this._rightPan.x = event.clientX;
      this._rightPan.y = event.clientY;
    });
    el.addEventListener("pointerup", (event) => {
      if (event.button !== 2 || !this._rightPan) return;
      if (this._rightPan.dbl && !this._rightPan.moved) {
        this.setViewDragMode(!this.viewDragMode);
      }
      this._rightPan = null;
    });
    el.addEventListener("pointercancel", () => {
      this._rightPan = null;
    });
  }

  resize() {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, true);
  }

  setPointSize(size) {
    this.pointSize = size;
    if (this._opaqueMaterial) this._opaqueMaterial.size = size;
    if (this._ghostMaterial) this._ghostMaterial.size = size;
  }

  setColorMode(mode) {
    this.colorMode = mode;
    if (this.cloud) this._rebuildLayers();
  }

  setLabeledInstances(map) {
    this.labeled = map || new Map();
    if (this.cloud) this._rebuildLayers();
  }

  highlightInstance(id) {
    this.selectedInstance = id == null ? null : id;
    this._updateSelectionBox();
  }

  clear() {
    disposeChunks(this.pointChunks);
    disposeChunks(this.ghostChunks);
    this.points = null;
    this.ghostPoints = null;
    this._opaqueMaterial = null;
    this._ghostMaterial = null;
    this.cloud = null;
    this.highlightInstance(null);
  }

  show(cloud, { fit = true, labeled = null } = {}) {
    const keepTarget = this.controls.target.clone();
    const keepPos = this.camera.position.clone();
    this.clear();
    this.cloud = cloud;
    centerCloud(cloud);
    if (labeled) this.labeled = labeled;
    this._rebuildLayers();
    if (fit) this.fitToCloud();
    else {
      this.camera.position.copy(keepPos);
      this.controls.target.copy(keepTarget);
      this.controls.update();
    }
  }

  _baseColor(cloud, index, target, offset) {
    const mode = this.colorMode;
    if ((mode === "instance" || !cloud.colors) && cloud.instances) {
      const rgb = instanceRgb(cloud.instances[index]);
      target[offset] = rgb[0];
      target[offset + 1] = rgb[1];
      target[offset + 2] = rgb[2];
      return;
    }
    if (mode === "semantic" && cloud.semantic) {
      const rgb = SEMANTIC_PALETTE[cloud.semantic[index] % SEMANTIC_PALETTE.length];
      target[offset] = rgb[0];
      target[offset + 1] = rgb[1];
      target[offset + 2] = rgb[2];
      return;
    }
    if (mode === "rgb" && cloud.colors) {
      const i = index * 3;
      target[offset] = cloud.colors[i] / 255;
      target[offset + 1] = cloud.colors[i + 1] / 255;
      target[offset + 2] = cloud.colors[i + 2] / 255;
      return;
    }
    if (!this._zRange) {
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < cloud.count; i += 1) {
        const z = cloud.positions[i * 3 + 2];
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      this._zRange = { minZ, span: Math.max(1e-6, maxZ - minZ) };
    }
    heightColor((cloud.positions[index * 3 + 2] - this._zRange.minZ) / this._zRange.span, target, offset);
  }

  _rebuildLayers() {
    disposeChunks(this.pointChunks);
    disposeChunks(this.ghostChunks);
    this.pointChunks = [];
    this.ghostChunks = [];
    this.points = null;
    this.ghostPoints = null;
    this._opaqueMaterial = null;
    this._ghostMaterial = null;
    const cloud = this.cloud;
    if (!cloud) return;

    let opaqueCount = 0;
    let ghostCount = 0;
    const labeled = this.labeled;
    for (let i = 0; i < cloud.count; i += 1) {
      const inst = cloud.instances ? cloud.instances[i] : -1;
      if (labeled.has(inst)) ghostCount += 1;
      else opaqueCount += 1;
    }

    const opaquePos = new Float32Array(opaqueCount * 3);
    const opaqueCol = new Float32Array(opaqueCount * 3);
    const ghostPos = new Float32Array(ghostCount * 3);
    const ghostCol = new Float32Array(ghostCount * 3);
    let oi = 0;
    let gi = 0;
    this._zRange = null;
    for (let i = 0; i < cloud.count; i += 1) {
      const inst = cloud.instances ? cloud.instances[i] : -1;
      const label = labeled.get(inst);
      if (label) {
        ghostPos[gi] = cloud.positions[i * 3];
        ghostPos[gi + 1] = cloud.positions[i * 3 + 1];
        ghostPos[gi + 2] = cloud.positions[i * 3 + 2];
        ghostCol[gi] = label.rgb[0];
        ghostCol[gi + 1] = label.rgb[1];
        ghostCol[gi + 2] = label.rgb[2];
        gi += 3;
      } else {
        opaquePos[oi] = cloud.positions[i * 3];
        opaquePos[oi + 1] = cloud.positions[i * 3 + 1];
        opaquePos[oi + 2] = cloud.positions[i * 3 + 2];
        this._baseColor(cloud, i, opaqueCol, oi);
        oi += 3;
      }
    }

    if (opaqueCount) {
      this._opaqueMaterial = new THREE.PointsMaterial({
        size: this.pointSize,
        sizeAttenuation: false,
        vertexColors: true,
      });
      this.pointChunks = addPointChunks(this.scene, opaquePos, opaqueCol, this._opaqueMaterial);
      this.points = this.pointChunks[0] || null;
    }
    if (ghostCount) {
      this._ghostMaterial = new THREE.PointsMaterial({
        size: this.pointSize,
        sizeAttenuation: false,
        vertexColors: true,
        transparent: true,
        opacity: 0.04,
        depthWrite: false,
      });
      this.ghostChunks = addPointChunks(this.scene, ghostPos, ghostCol, this._ghostMaterial);
      this.ghostPoints = this.ghostChunks[0] || null;
    }
    this._updateSelectionBox();
  }

  _updateSelectionBox() {
    if (this._boxHelper) {
      this.scene.remove(this._boxHelper);
      this._boxHelper.geometry.dispose();
      this._boxHelper.material.dispose();
      this._boxHelper = null;
    }
    const cloud = this.cloud;
    if (!cloud?.instances || this.selectedInstance == null) return;
    const box = this._box3.makeEmpty();
    const point = new THREE.Vector3();
    const id = this.selectedInstance;
    for (let i = 0; i < cloud.count; i += 1) {
      if (cloud.instances[i] !== id) continue;
      point.set(cloud.positions[i * 3], cloud.positions[i * 3 + 1], cloud.positions[i * 3 + 2]);
      box.expandByPoint(point);
    }
    if (box.isEmpty()) return;
    this._boxHelper = new THREE.Box3Helper(box.clone(), 0x3d9cf0);
    this.scene.add(this._boxHelper);
  }

  _pickIndex(clientX, clientY, unlabeledOnly) {
    const cloud = this.cloud;
    if (!cloud?.instances) return -1;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const ndcX = ((clientX - rect.left) / width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / height) * 2 + 1;
    this.camera.updateMatrixWorld();
    this._proj.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    const e = this._proj.elements;
    const pos = cloud.positions;
    const threshold = Math.max(this.pointSize * 6, 18);
    const threshSq = threshold * threshold;
    let bestIndex = -1;
    let bestScore = Infinity;

    for (let i = 0; i < cloud.count; i += 1) {
      const inst = cloud.instances[i];
      if (unlabeledOnly && this.labeled.has(inst)) continue;
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w === 0) continue;
      const clipZ = (e[2] * x + e[6] * y + e[10] * z + e[14]) / w;
      if (clipZ < -1 || clipZ > 1) continue;
      const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w - ndcX) * 0.5 * width;
      const sy = ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w - ndcY) * 0.5 * height;
      const distSq = sx * sx + sy * sy;
      if (distSq > threshSq) continue;
      const score = distSq + (clipZ + 1) * 12;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  pickAt(clientX, clientY) {
    if (!this.cloud?.instances) {
      this.onInstanceClick?.(null);
      return;
    }
    let index = this._pickIndex(clientX, clientY, true);
    if (index < 0) index = this._pickIndex(clientX, clientY, false);
    if (index < 0) {
      this.onInstanceClick?.(null);
      return;
    }
    this.onInstanceClick?.(this.cloud.instances[index]);
  }

  _syncClipPlanes() {
    const radius = this._fitted?.radius || 50;
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(0.01, Math.min(distance / 80, radius / 40));
    this.camera.far = Math.max(distance + radius * 12, radius * 30, 200);
    this.camera.updateProjectionMatrix();
  }

  fitToCloud() {
    const cloud = this.cloud;
    if (!cloud) return;
    const box = new THREE.Box3();
    const sphere = new THREE.Sphere();
    box.setFromArray(cloud.positions);
    box.getBoundingSphere(sphere);
    const center = sphere.center.clone();
    const radius = Math.max(sphere.radius, 1);
    const fov = (this.camera.fov * Math.PI) / 180;
    const distance = Math.max((radius / Math.sin(fov / 2)) * 0.9, 5);
    const direction = new THREE.Vector3(0.7, -0.85, 0.55).normalize();
    this.camera.position.copy(center).addScaledVector(direction, distance);
    this.controls.minDistance = Math.max(radius * 0.01, 0.05);
    this.controls.maxDistance = Math.max(radius * 40, 40);
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = Math.PI;
    this.controls.target.copy(center);
    this._fitted = { center, distance, direction, radius };
    this._syncClipPlanes();
    this.controls.update();
  }

  resetView() {
    if (this._fitted) {
      const { center, distance, direction } = this._fitted;
      this.camera.position.copy(center).addScaledVector(direction, distance);
      this.controls.target.copy(center);
      this.controls.update();
      return;
    }
    this.fitToCloud();
  }
}
