/**
 * Touchscreen gesture sampler. No atoms, materials, or scene graph.
 * One contact aims. Two contacts pan, yaw, and zoom from their geometry.
 * FallingInput merges the consumed frame with mouse, keys, and the pad.
 */

/**
 * @typedef {{
 *   active: boolean,
 *   aimAt: { x: number, y: number } | null,
 *   panDelta: { x: number, y: number } | null,
 *   pointerAt: { x: number, y: number } | null,
 *   orbitDelta: number,
 *   zoomFactor: number,
 * }} TouchInputFrame
 */

/**
 * @typedef {{
 *   orbitSign?: number,
 *   zoomGain?: number,
 * }} TouchBindings
 */

export class TouchInput {
  /**
   * @param {TouchBindings} [bindings]
   */
  constructor(bindings = {}) {
    /** Positive screen-angle change (y-down atan2, clockwise) times this becomes yaw. */
    this.orbitSign = bindings.orbitSign ?? 1;
    /** 1 matches pinch ratio to camera zoom. Above 1 is more sensitive. */
    this.zoomGain = bindings.zoomGain ?? 1;
    /** @type {Map<number, { x: number, y: number, order: number }>} */
    this.pointers = new Map();
    this._order = 0;
    /** @type {{ x: number, y: number } | null} */
    this._aimAt = null;
    /** @type {{ x: number, y: number } | null} */
    this._pointerAt = null;
    this._panX = 0;
    this._panY = 0;
    this._orbit = 0;
    this._zoom = 1;
    /**
     * Seeded pair. The first sample after a pair change does not jump.
     * @type {{ idA: number, idB: number, cx: number, cy: number, angle: number, dist: number } | null}
     */
    this._pair = null;
  }

  /**
   * @param {PointerEvent} event
   */
  pointerDown(event) {
    this.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      order: ++this._order,
    });
    this._syncGesture();
  }

  /**
   * @param {PointerEvent} event
   */
  pointerMove(event) {
    const pointer = this.pointers.get(event.pointerId);
    if (!pointer) return;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    this._syncGesture();
  }

  /**
   * @param {PointerEvent} event
   */
  pointerUp(event) {
    this.pointers.delete(event.pointerId);
    this._syncGesture();
  }

  reset() {
    this.pointers.clear();
    this._aimAt = null;
    this._pointerAt = null;
    this._panX = 0;
    this._panY = 0;
    this._orbit = 0;
    this._zoom = 1;
    this._pair = null;
  }

  /**
   * Take the gesture deltas accumulated since the last sample.
   * @returns {TouchInputFrame}
   */
  consume() {
    const panX = this._panX;
    const panY = this._panY;
    const orbitDelta = this._orbit;
    const zoomFactor = this._zoom;
    this._panX = 0;
    this._panY = 0;
    this._orbit = 0;
    this._zoom = 1;
    return {
      active: this.pointers.size > 0,
      aimAt: this._aimAt ? { x: this._aimAt.x, y: this._aimAt.y } : null,
      panDelta: panX || panY ? { x: panX, y: panY } : null,
      pointerAt: this._pointerAt ? { x: this._pointerAt.x, y: this._pointerAt.y } : null,
      orbitDelta,
      zoomFactor,
    };
  }

  _syncGesture() {
    const ordered = [...this.pointers.entries()].sort((a, b) => a[1].order - b[1].order);
    if (ordered.length === 0) {
      this._aimAt = null;
      this._pair = null;
      return;
    }
    if (ordered.length === 1) {
      const pointer = ordered[0][1];
      this._aimAt = { x: pointer.x, y: pointer.y };
      this._pair = null;
      return;
    }

    this._aimAt = null;
    const [idA, a] = ordered[0];
    const [idB, b] = ordered[1];
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const same = this._pair && this._pair.idA === idA && this._pair.idB === idB;
    this._pointerAt = { x: cx, y: cy };
    if (!same) {
      this._pair = { idA, idB, cx, cy, angle, dist };
      return;
    }

    this._panX += cx - this._pair.cx;
    this._panY += cy - this._pair.cy;
    this._orbit += wrapAngle(angle - this._pair.angle) * this.orbitSign;
    if (this._pair.dist > 8 && dist > 8) {
      const ratio = this._pair.dist / dist;
      this._zoom *= this.zoomGain === 1 ? ratio : Math.pow(ratio, this.zoomGain);
    }
    this._pair.cx = cx;
    this._pair.cy = cy;
    this._pair.angle = angle;
    this._pair.dist = dist;
  }
}

/**
 * @param {number} delta
 */
function wrapAngle(delta) {
  const turn = Math.PI * 2;
  let wrapped = delta % turn;
  if (wrapped > Math.PI) wrapped -= turn;
  if (wrapped < -Math.PI) wrapped += turn;
  return wrapped;
}
