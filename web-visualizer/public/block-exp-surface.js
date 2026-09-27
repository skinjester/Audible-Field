import * as THREE from "three";

/**
 * One flowing skin for the block-exp atoms. The top of each column is a
 * spline node; the surface is a single curve through those tops, solid
 * down through the pile. The simulation is unchanged.
 */

const ISO = 0.5;
const MAX_AXIS = 72;
const BASE_VOXEL = 0.05;
const PITCH = 0.25;
/** How far the shape eases from the outer columns down to the ground. */
const SKIRT = 0.32;
/** Thickness of the crest so the spline reads as a round surface. */
const SOFT = 0.14;
const PAD = SKIRT + 0.04;

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const v = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
  const lo = Math.min(p0, p1, p2, p3);
  const hi = Math.max(p0, p1, p2, p3);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function smoothstep01(t) {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * @param {Uint8Array} field
 * @param {number[]} points
 * @param {number[] | undefined} halfExtents
 */
function writeSplineField(field, points, halfExtents, minX, minY, minZ, voxel, nx, ny, nz) {
  const count = (points.length / 3) | 0;
  const originX = points[0] - Math.round(points[0] / PITCH) * PITCH;
  const originZ = points[2] - Math.round(points[2] / PITCH) * PITCH;
  /** @type {Map<string, { ix: number, iz: number, top: number, bottom: number }>} */
  const columns = new Map();
  let base = Infinity;
  for (let i = 0; i < count; i += 1) {
    const o = i * 3;
    const half = halfExtents && halfExtents[i] > 0 ? halfExtents[i] : 0.125;
    const x = points[o];
    const y = points[o + 1];
    const z = points[o + 2];
    const bottom = y - half;
    const top = y + half;
    if (bottom < base) base = bottom;
    const ix = Math.round((x - originX) / PITCH);
    const iz = Math.round((z - originZ) / PITCH);
    const key = `${ix},${iz}`;
    const prev = columns.get(key);
    if (!prev || top > prev.top) columns.set(key, { ix, iz, top, bottom });
  }

  let minIX = Infinity;
  let maxIX = -Infinity;
  let minIZ = Infinity;
  let maxIZ = -Infinity;
  for (const col of columns.values()) {
    if (col.ix < minIX) minIX = col.ix;
    if (col.ix > maxIX) maxIX = col.ix;
    if (col.iz < minIZ) minIZ = col.iz;
    if (col.iz > maxIZ) maxIZ = col.iz;
  }
  const padI = 3;
  const gw = maxIX - minIX + 1 + padI * 2;
  const gh = maxIZ - minIZ + 1 + padI * 2;
  const tops = new Float32Array(gw * gh);
  const occ = new Uint8Array(gw * gh);
  const gi = (ix, iz) => ix - minIX + padI + gw * (iz - minIZ + padI);
  const inGrid = (ix, iz) => ix >= minIX - padI && ix <= maxIX + padI && iz >= minIZ - padI && iz <= maxIZ + padI;
  for (const col of columns.values()) {
    const g = gi(col.ix, col.iz);
    occ[g] = 1;
    tops[g] = col.top;
  }
  // Bridge a one-cell crack so the spline stays one surface.
  const occ2 = occ.slice();
  const tops2 = tops.slice();
  for (let iz = minIZ; iz <= maxIZ; iz += 1) {
    for (let ix = minIX; ix <= maxIX; ix += 1) {
      if (occ[gi(ix, iz)]) continue;
      let n = 0;
      let sum = 0;
      const neighbors = [
        [ix - 1, iz],
        [ix + 1, iz],
        [ix, iz - 1],
        [ix, iz + 1],
      ];
      for (let k = 0; k < neighbors.length; k += 1) {
        const nxb = neighbors[k][0];
        const nzb = neighbors[k][1];
        if (!inGrid(nxb, nzb) || !occ[gi(nxb, nzb)]) continue;
        n += 1;
        sum += tops[gi(nxb, nzb)];
      }
      if (n >= 2) {
        occ2[gi(ix, iz)] = 1;
        tops2[gi(ix, iz)] = sum / n;
      }
    }
  }

  const heightAt = (ix, iz) => {
    if (!inGrid(ix, iz)) return null;
    const g = gi(ix, iz);
    return occ2[g] ? tops2[g] : null;
  };
  const sample = (ix, iz, ax, az) => heightAt(ix, iz) ?? heightAt(ax, az) ?? base;
  const heightCR = (u, v) => {
    const i = Math.floor(u);
    const j = Math.floor(v);
    const ax = Math.round(u);
    const az = Math.round(v);
    const row = (jj) => catmull(sample(i - 1, jj, ax, az), sample(i, jj, ax, az), sample(i + 1, jj, ax, az), sample(i + 2, jj, ax, az), u - i);
    return catmull(row(j - 1), row(j), row(j + 1), row(j + 2), v - j);
  };

  const columnH = new Float32Array(nx * nz);
  columnH.fill(Number.NaN);
  const search = Math.ceil(SKIRT / PITCH) + 2;
  for (let z = 0; z < nz; z += 1) {
    const wz = minZ + (z + 0.5) * voxel;
    const v = (wz - originZ) / PITCH;
    for (let x = 0; x < nx; x += 1) {
      const wx = minX + (x + 0.5) * voxel;
      const u = (wx - originX) / PITCH;
      const iu = Math.round(u);
      const iv = Math.round(v);
      if (heightAt(iu, iv)) {
        columnH[x + nx * z] = heightCR(u, v);
        continue;
      }
      let bestD = Infinity;
      let bestH = base;
      const i0 = iu;
      const j0 = iv;
      for (let jj = j0 - search; jj <= j0 + search; jj += 1) {
        for (let ii = i0 - search; ii <= i0 + search; ii += 1) {
          const h = heightAt(ii, jj);
          if (h == null) continue;
          const cx = originX + ii * PITCH;
          const cz = originZ + jj * PITCH;
          const d = Math.hypot(wx - cx, wz - cz);
          if (d < bestD) {
            bestD = d;
            bestH = h;
          }
        }
      }
      const dist = bestD - PITCH * 0.5;
      if (dist > SKIRT) continue;
      const s = smoothstep01(dist / SKIRT);
      columnH[x + nx * z] = bestH + (base - bestH) * s;
    }
  }

  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      const wy = minY + (y + 0.5) * voxel;
      const row = nx * (y + ny * z);
      for (let x = 0; x < nx; x += 1) {
        const h = columnH[x + nx * z];
        if (Number.isNaN(h) || wy < base) {
          field[row + x] = 0;
          continue;
        }
        let vert = 0.5 + (h - wy) / (2 * SOFT);
        if (vert < 0) vert = 0;
        else if (vert > 1) vert = 1;
        field[row + x] = Math.round(vert * 255);
      }
    }
  }
}

const VERT = `
varying vec3 vField;
uniform vec3 uMin;
uniform vec3 uSize;
void main() {
  vField = uMin + (position + 0.5) * uSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = `
varying vec3 vField;
uniform mat4 projectionMatrix;
uniform sampler3D uVolume;
uniform vec3 uMin;
uniform vec3 uMax;
uniform vec3 uSize;
uniform vec3 uColor;
uniform float uIso;
uniform mat4 uSurfaceMat;
uniform mat4 uSurfaceInv;

float densityAt(vec3 p) {
  vec3 uvw = (p - uMin) / uSize;
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return 0.0;
  return texture(uVolume, uvw).r;
}

void main() {
  vec3 cam = (uSurfaceInv * vec4(cameraPosition, 1.0)).xyz;
  vec3 rd = normalize(vField - cam);
  vec3 invRd = mix(vec3(1e6), 1.0 / rd, greaterThan(abs(rd), vec3(1e-5)));
  vec3 t0 = (uMin - cam) * invRd;
  vec3 t1 = (uMax - cam) * invRd;
  vec3 tsm = min(t0, t1);
  vec3 tbg = max(t0, t1);
  float tNear = max(max(tsm.x, tsm.y), tsm.z);
  float tFar = min(min(tbg.x, tbg.y), tbg.z);
  tNear = max(tNear, 0.0);
  if (tNear >= tFar) discard;

  float stepLen = max((tFar - tNear) / 72.0, 0.012);
  float t = tNear;
  vec3 p = cam + rd * t;
  float prev = densityAt(p);
  bool hit = prev >= uIso;
  if (!hit) {
    for (int i = 0; i < 80; i++) {
      if (t >= tFar) break;
      float tNext = min(tFar, t + stepLen);
      vec3 nextP = cam + rd * tNext;
      float d = densityAt(nextP);
      if (prev < uIso && d >= uIso) {
        hit = true;
        float a = t;
        float b = tNext;
        for (int k = 0; k < 5; k++) {
          float m = 0.5 * (a + b);
          if (densityAt(cam + rd * m) >= uIso) b = m;
          else a = m;
        }
        t = b;
        p = cam + rd * t;
        break;
      }
      prev = d;
      t = tNext;
      p = nextP;
    }
  }
  if (!hit) discard;

  float e = stepLen * 0.65;
  vec3 g = vec3(
    densityAt(p + vec3(e, 0.0, 0.0)) - densityAt(p - vec3(e, 0.0, 0.0)),
    densityAt(p + vec3(0.0, e, 0.0)) - densityAt(p - vec3(0.0, e, 0.0)),
    densityAt(p + vec3(0.0, 0.0, e)) - densityAt(p - vec3(0.0, 0.0, e))
  );
  float glen = length(g);
  vec3 nField = glen > 1e-4 ? -g / glen : vec3(0.0, 1.0, 0.0);
  vec3 nWorld = normalize(mat3(uSurfaceMat) * nField);
  float wrap = clamp(dot(nWorld, normalize(vec3(0.42, 0.82, 0.34))) * 0.55 + 0.45, 0.0, 1.0);
  gl_FragColor = vec4(uColor * (0.18 + 0.82 * wrap), 1.0);
  #include <colorspace_fragment>
  vec4 hitWorld = uSurfaceMat * vec4(p, 1.0);
  vec4 clip = projectionMatrix * viewMatrix * hitWorld;
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
}
`;

export function createBlockExpSurface() {
  const uniforms = {
    uVolume: { value: null },
    uMin: { value: new THREE.Vector3() },
    uMax: { value: new THREE.Vector3() },
    uSize: { value: new THREE.Vector3(1, 1, 1) },
    uColor: { value: new THREE.Color("#3d7ec4") },
    uIso: { value: ISO },
    uSurfaceMat: { value: new THREE.Matrix4() },
    uSurfaceInv: { value: new THREE.Matrix4() },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 1;

  /** @type {THREE.Data3DTexture | null} */
  let texture = null;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  /** @type {Uint8Array | null} */
  let field = null;

  function disposeTexture() {
    texture?.dispose();
    texture = null;
    uniforms.uVolume.value = null;
  }

  return {
    mesh,
    /**
     * @param {THREE.Object3D} parent
     * @param {number[]} points xyz triples in playfield space
     * @param {string | number | THREE.Color} color
     * @param {number[]} [halfExtents] half-size of each atom cube
     */
    update(parent, points, color, halfExtents) {
      if (mesh.parent !== parent) parent.add(mesh);
      uniforms.uColor.value.set(color);
      parent.updateWorldMatrix(true, false);
      uniforms.uSurfaceMat.value.copy(parent.matrixWorld);
      uniforms.uSurfaceInv.value.copy(parent.matrixWorld).invert();

      const count = (points.length / 3) | 0;
      if (count <= 0) {
        mesh.visible = false;
        return;
      }

      let minX = Infinity;
      let minY = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < count; i += 1) {
        const o = i * 3;
        const half = halfExtents && halfExtents[i] > 0 ? halfExtents[i] : 0.125;
        const x = points[o];
        const y = points[o + 1];
        const z = points[o + 2];
        if (x - half < minX) minX = x - half;
        if (y - half < minY) minY = y - half;
        if (z - half < minZ) minZ = z - half;
        if (x + half > maxX) maxX = x + half;
        if (y + half > maxY) maxY = y + half;
        if (z + half > maxZ) maxZ = z + half;
      }
      const pad = PAD;
      minX -= pad;
      minY -= pad;
      minZ -= pad;
      maxX += pad;
      maxY += pad;
      maxZ += pad;

      const spanX = Math.max(maxX - minX, pad);
      const spanY = Math.max(maxY - minY, pad);
      const spanZ = Math.max(maxZ - minZ, pad);
      const voxel = Math.max(BASE_VOXEL, spanX / MAX_AXIS, spanY / MAX_AXIS, spanZ / MAX_AXIS);
      minX = Math.floor(minX / voxel) * voxel;
      minY = Math.floor(minY / voxel) * voxel;
      minZ = Math.floor(minZ / voxel) * voxel;
      const dimX = Math.max(2, Math.ceil((maxX - minX) / voxel));
      const dimY = Math.max(2, Math.ceil((maxY - minY) / voxel));
      const dimZ = Math.max(2, Math.ceil((maxZ - minZ) / voxel));
      const sizeX = dimX * voxel;
      const sizeY = dimY * voxel;
      const sizeZ = dimZ * voxel;

      if (dimX !== nx || dimY !== ny || dimZ !== nz) {
        disposeTexture();
        nx = dimX;
        ny = dimY;
        nz = dimZ;
        field = new Uint8Array(nx * ny * nz);
        texture = new THREE.Data3DTexture(field, nx, ny, nz);
        texture.format = THREE.RedFormat;
        texture.type = THREE.UnsignedByteType;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.wrapR = THREE.ClampToEdgeWrapping;
        texture.generateMipmaps = false;
        texture.colorSpace = THREE.NoColorSpace;
        texture.needsUpdate = true;
        uniforms.uVolume.value = texture;
      }

      field.fill(0);
      writeSplineField(field, points, halfExtents, minX, minY, minZ, voxel, nx, ny, nz);
      texture.needsUpdate = true;

      uniforms.uMin.value.set(minX, minY, minZ);
      uniforms.uMax.value.set(minX + sizeX, minY + sizeY, minZ + sizeZ);
      uniforms.uSize.value.set(sizeX, sizeY, sizeZ);
      mesh.position.set(minX + sizeX * 0.5, minY + sizeY * 0.5, minZ + sizeZ * 0.5);
      mesh.scale.set(sizeX, sizeY, sizeZ);
      mesh.visible = true;
    },
    dispose() {
      disposeTexture();
      mesh.geometry.dispose();
      material.dispose();
      mesh.removeFromParent();
    },
  };
}
