/**
 * Touchscreen gesture sampler. No atoms, materials, or scene graph.
 * A lone finger pans only after it drags. Landing a finger, or the first
 * of a pair, does not move the field. Two contacts report the finger
 * chord; the sim yaws that chord about the emitter. Pinch zoom stays on
 * screen span. FallingInput merges the consumed frame with mouse, keys,
 * and the pad.
 */

/**
 * @typedef {{ x: number, y: number }} ScreenPoint
 * @typedef {{
 *   a0: ScreenPoint,
 *   b0: ScreenPoint,
 *   a1: ScreenPoint,
 *   b1: ScreenPoint,
 * }} TouchChord
 * @typedef {{ from: ScreenPoint, to: ScreenPoint }} TouchPan
 * @typedef {{
 *   active: boolean,
 *   pan: TouchPan | null,
 *   twist: TouchChord | null,
 *   zoomFactor: number,
 * }} TouchInputFrame
 */

/**
 * @typedef {{
 *   zoomGain?: number,
 * }} TouchBindings
 */

/** Screen span below this does not pinch. A short chord can still yaw. */
const PINCH_MIN_PX = 8;

/** A lone contact must travel this far before it pans the field. */
const AIM_DRAG_PX = 10;

export class TouchInput {
  /**
   * @param {TouchBindings} [bindings]
   */
  constructor(bindings = {}) {
    /** 1 matches pinch ratio to camera zoom. Above 1 is more sensitive. */
    this.zoomGain = bindings.zoomGain ?? 1;
    /** @type {Map<number, { x: number, y: number, order: number }>} */
    this.pointers = new Map();
    this._order = 0;
    /**
     * Contact that started alone. A second finger clears it, so that chord
     * and the finger left behind cannot pan the field.
     * @type {{ id: number, x: number, y: number, dragging: boolean } | null}
     */
    this._solo = null;
    /** One-finger pan since the last consume. The start stays put. */
    /** @type {TouchPan | null} */
    this._pan = null;
    /**
     * Last settled pair. A new pair does not jump.
     * @type {{ idA: number, idB: number, a: ScreenPoint, b: ScreenPoint } | null}
     */
    this._pair = null;
    /** Chord since the last consume. Endpoints update; the start stays put. */
    /** @type {TouchChord | null} */
    this._pending = null;
  }

  /**
   * @param {PointerEvent} event
   */
  pointerDown(event) {
    const soloStart = this.pointers.size === 0;
    this.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      order: ++this._order,
    });
    if (soloStart) {
      this._solo = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
      };
    } else {
      this._solo = null;
    }
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
    this._solo = null;
    this._pan = null;
    this._pair = null;
    this._pending = null;
  }

  /**
   * Take the gesture accumulated since the last sample.
   * @returns {TouchInputFrame}
   */
  consume() {
    const pending = this._pending;
    const pan = this._pan;
    this._pending = null;
    this._pan = null;
    const zoomFactor = pending ? pinchFactor(pending, this.zoomGain) : 1;
    return {
      active: this.pointers.size > 0,
      pan,
      twist: pending,
      zoomFactor,
    };
  }

  _syncGesture() {
    const ordered = [...this.pointers.entries()].sort((a, b) => a[1].order - b[1].order);
    if (ordered.length === 0) {
      this._solo = null;
      this._pan = null;
      this._pair = null;
      return;
    }
    if (ordered.length === 1) {
      const [id, pointer] = ordered[0];
      const solo = this._solo;
      this._pair = null;
      if (!solo || solo.id !== id) {
        this._pan = null;
        return;
      }
      if (!solo.dragging) {
        const traveled = Math.hypot(pointer.x - solo.x, pointer.y - solo.y);
        if (traveled < AIM_DRAG_PX) {
          this._pan = null;
          return;
        }
        solo.dragging = true;
        solo.x = pointer.x;
        solo.y = pointer.y;
        this._pan = null;
        return;
      }
      if (pointer.x === solo.x && pointer.y === solo.y) return;
      if (!this._pan) {
        this._pan = { from: { x: solo.x, y: solo.y }, to: point(pointer) };
      } else {
        this._pan.to = point(pointer);
      }
      solo.x = pointer.x;
      solo.y = pointer.y;
      return;
    }

    this._pan = null;
    this._solo = null;
    const [idA, a] = ordered[0];
    const [idB, b] = ordered[1];
    const same = this._pair && this._pair.idA === idA && this._pair.idB === idB;
    if (!same) {
      this._pair = { idA, idB, a: point(a), b: point(b) };
      this._pending = null;
      return;
    }
    if (
      a.x === this._pair.a.x &&
      a.y === this._pair.a.y &&
      b.x === this._pair.b.x &&
      b.y === this._pair.b.y
    ) {
      return;
    }
    if (!this._pending) {
      this._pending = { a0: this._pair.a, b0: this._pair.b, a1: point(a), b1: point(b) };
    } else {
      this._pending.a1 = point(a);
      this._pending.b1 = point(b);
    }
    this._pair = { idA, idB, a: point(a), b: point(b) };
  }
}

/**
 * @param {{ x: number, y: number }} p
 */
function point(p) {
  return { x: p.x, y: p.y };
}

/**
 * Screen-span pinch. Ground distance is foreshortened, so zoom does not use it.
 * @param {TouchChord} chord
 * @param {number} gain
 */
function pinchFactor(chord, gain) {
  const d0 = Math.hypot(chord.b0.x - chord.a0.x, chord.b0.y - chord.a0.y);
  const d1 = Math.hypot(chord.b1.x - chord.a1.x, chord.b1.y - chord.a1.y);
  if (d0 <= PINCH_MIN_PX || d1 <= PINCH_MIN_PX) return 1;
  const ratio = d0 / d1;
  return gain === 1 ? ratio : Math.pow(ratio, gain);
}
