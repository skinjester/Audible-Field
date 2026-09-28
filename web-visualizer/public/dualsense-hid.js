/**
 * DualSense touchpad via WebHID (Chrome / Edge / Opera).
 * Sticks / face / D-pad stay on the Gamepad API (gamepad-input.js).
 *
 * Layouts follow nondebug/dualsense + the Linux dualsense_input_report:
 *   USB  report 0x01 → common payload at DataView 0 (touch at 32, click at byte 9 bit 1)
 *   BT   report 0x31 → common payload at DataView 1 (touch at 33, click at byte 10 bit 1)
 * Reading feature report 0x05 switches BT from short 0x01 → full 0x31.
 *
 * Falling Blocks reads `touch` directly and sets `routeTouchToMixer` false
 * so a finger aims the emitter instead of the mix pad.
 */

import { setTarget } from "./mixer-core.js?v=65";

const SONY_VENDOR = 0x054c;
const PRODUCT_DUALSENSE = 0x0ce6;
const PRODUCT_DUALSENSE_EDGE = 0x0df2;
const USAGE_PAGE_GENERIC_DESKTOP = 0x01;
const USAGE_ID_GD_GAME_PAD = 0x05;

/** VID/PID only — most reliable on Windows (usage filters often hide the pad). */
const HID_FILTERS = [
  { vendorId: SONY_VENDOR, productId: PRODUCT_DUALSENSE },
  { vendorId: SONY_VENDOR, productId: PRODUCT_DUALSENSE_EDGE },
];

/** Last resort: any Sony HID device. */
const HID_FILTERS_SONY = [{ vendorId: SONY_VENDOR }];

const TOUCH_MAX_X = 1920;
const TOUCH_MAX_Y = 1080;

function isDualSenseDevice(device) {
  if (!device || device.vendorId !== SONY_VENDOR) return false;
  return (
    device.productId === PRODUCT_DUALSENSE ||
    device.productId === PRODUCT_DUALSENSE_EDGE
  );
}

function detectConnectionType(device) {
  for (const c of device.collections || []) {
    if (
      c.usagePage !== USAGE_PAGE_GENERIC_DESKTOP ||
      c.usage !== USAGE_ID_GD_GAME_PAD
    ) {
      continue;
    }
    const maxInputReportBits = (c.inputReports || []).reduce((max, report) => {
      const bits = (report.items || []).reduce(
        (sum, item) => sum + (item.reportSize || 0) * (item.reportCount || 0),
        0
      );
      return Math.max(max, bits);
    }, 0);
    if (maxInputReportBits === 504) return "usb";
    if (maxInputReportBits === 616) return "bluetooth";
  }
  return "unknown";
}

function parseTouchContact(report, offset) {
  if (offset + 3 >= report.byteLength) {
    return { active: false, id: 0, x: 0, y: 0 };
  }
  const b0 = report.getUint8(offset);
  const b1 = report.getUint8(offset + 1);
  const b2 = report.getUint8(offset + 2);
  const b3 = report.getUint8(offset + 3);
  const active = (b0 & 0x80) === 0;
  const id = b0 & 0x7f;
  const x = ((b2 & 0x0f) << 8) | b1;
  const y = (b3 << 4) | ((b2 & 0xf0) >> 4);
  return { active, id, x, y };
}

function normalizeTouch(rawX, rawY) {
  return {
    x: Math.min(1, Math.max(0, rawX / (TOUCH_MAX_X - 1))),
    y: Math.min(1, Math.max(0, rawY / (TOUCH_MAX_Y - 1))),
  };
}

/**
 * Pick touch bytes from a WebHID DataView (report ID is NOT included).
 * Returns null when this report type cannot carry touch data.
 */
function extractTouch(reportId, report) {
  const len = report.byteLength;

  // Full BT report (after feature 0x05 / Gamepad API / Steam).
  if (reportId === 0x31 && len >= 41) {
    return parseTouchContact(report, 33);
  }

  // USB full report — also accept long 0x01 if connection type was mis-detected.
  if (reportId === 0x01 && len >= 36) {
    return parseTouchContact(report, 32);
  }

  // Short BT 0x01 (~10–14 bytes) has no touchpad payload.
  return null;
}

/**
 * Mechanical touchpad click from a full input report.
 * @returns {boolean | null} null when this report has no button bytes
 */
function extractTouchpadPressed(reportId, report) {
  const len = report.byteLength;
  // buttons[2] bit 1. Short BT 0x01 is too small and is left unchanged.
  let offset = -1;
  if (reportId === 0x01 && len >= 36) offset = 9;
  else if (reportId === 0x31 && len >= 41) offset = 10;
  if (offset < 0 || offset >= len) return null;
  return (report.getUint8(offset) & 0x02) !== 0;
}

export class DualsenseHid {
  constructor() {
    this.enabled = false;
    this.device = null;
    this.connectionType = "unknown";
    this.connected = false;
    this.padId = "";
    this.lastError = "";
    this.reportCount = 0;
    this.lastReportId = null;
    this.lastReportLen = 0;
    /** While true, mouse owns the mix pad (skip touchpad overwrite). */
    this.uiLockPad = false;
    /**
     * While false, touch updates `touch` only (Falling Blocks aims the emitter).
     * Diagnostics / visualize still drive the mix pad.
     */
    this.routeTouchToMixer = true;
    this.touch = {
      active: false,
      /** Mechanical click (pad pushed in), separate from a light finger contact. */
      pressed: false,
      x: 0.5,
      y: 0.5,
    };
    this._onInputReport = (event) => this._handleInputReport(event);
    this._onDisconnect = (event) => {
      if (event.device === this.device) this._clearDevice();
    };
    if (typeof navigator !== "undefined" && navigator.hid) {
      navigator.hid.addEventListener("disconnect", this._onDisconnect);
    }
  }

  static isSupported() {
    return typeof navigator !== "undefined" && !!navigator.hid;
  }

  enable() {
    this.enabled = true;
    void this.tryReconnect();
  }

  disable() {
    this.enabled = false;
    void this.close();
  }

  /** Re-open a previously permitted DualSense (no picker). */
  async tryReconnect() {
    if (!this.enabled || !DualsenseHid.isSupported() || this.device) return false;
    try {
      const devices = await navigator.hid.getDevices();
      const match = devices.find(isDualSenseDevice);
      if (!match) return false;
      await this._openDevice(match);
      return true;
    } catch (err) {
      this.lastError = err?.message || String(err);
      console.warn("DualSense HID reconnect failed:", err);
      return false;
    }
  }

  /**
   * Must be called directly from a user gesture (no awaits before this).
   * @returns {Promise<boolean>}
   */
  async requestDevice() {
    if (!DualsenseHid.isSupported()) {
      throw new Error("WebHID is not available in this browser");
    }

    // Prefer already-granted devices (no second picker).
    try {
      const granted = await navigator.hid.getDevices();
      const existing = granted.find(isDualSenseDevice);
      if (existing) {
        try {
          await this.close();
          await this._openDevice(existing);
          this.lastError = "";
          return true;
        } catch (err) {
          console.warn("DualSense HID reopen failed, showing picker:", err);
        }
      }
    } catch {
      /* fall through to picker */
    }

    let devices = [];
    try {
      devices = await navigator.hid.requestDevice({ filters: HID_FILTERS });
    } catch (err) {
      console.warn("DualSense HID request failed:", err);
      this.lastError = err?.message || String(err);
      throw err;
    }

    // Empty chooser is common when usage was too strict or user hit Cancel.
    // Offer a wider Sony-only list once (still requires a gesture — same click).
    if (!devices?.length) {
      try {
        devices = await navigator.hid.requestDevice({ filters: HID_FILTERS_SONY });
      } catch (err) {
        console.warn("DualSense HID Sony-wide request failed:", err);
      }
    }

    const device = devices?.find(isDualSenseDevice) || devices?.[0];
    if (!device) {
      this.lastError =
        "Nothing selected — use desktop Chrome/Edge (not Cursor’s browser), pick Wireless Controller";
      return false;
    }
    if (!isDualSenseDevice(device)) {
      this.lastError = `Wrong device (${device.productName || "unknown"}) — pick DualSense`;
      return false;
    }

    await this.close();
    await this._openDevice(device);
    this.lastError = "";
    return true;
  }

  async close() {
    const device = this.device;
    this._clearDevice(false);
    if (!device) return;
    try {
      device.removeEventListener("inputreport", this._onInputReport);
      if (device.opened) await device.close();
    } catch (err) {
      console.warn("DualSense HID close failed:", err);
    }
  }

  /**
   * Apply latest touchpad contact to the mixer (call once per frame in browser mode).
   * @returns {boolean} true when a live touch is driving the pad
   */
  poll() {
    if (!this.enabled || !this.connected || !this.touch.active) return false;
    if (!this._shouldDriveMixer()) return false;
    setTarget(this.touch.x, this.touch.y, "touchpad", true);
    return true;
  }

  _shouldDriveMixer() {
    return this.routeTouchToMixer && !this.uiLockPad;
  }

  async _openDevice(device) {
    if (!device.opened) await device.open();
    if (!device.opened) {
      throw new Error("Failed to open DualSense HID device");
    }

    this.device = device;
    this.connectionType = detectConnectionType(device);
    this.connected = true;
    this.enabled = true;
    this.padId = device.productName || "DualSense";
    this.reportCount = 0;
    this.lastReportId = null;
    this.lastReportLen = 0;
    this.touch.active = false;
    this.touch.pressed = false;

    // Prefer the standard event; oninputreport is a fallback property some demos use.
    device.addEventListener("inputreport", this._onInputReport);

    // Always request feature 0x05: enables BT report 0x31 (touch + IMU).
    // Harmless on USB; Gamepad/Steam may already have done this.
    try {
      await device.receiveFeatureReport(0x05);
    } catch (err) {
      console.warn("DualSense feature 0x05 failed (BT touch may need Gamepad/Steam):", err);
      this.lastError = `feature 0x05: ${err?.message || err}`;
    }
  }

  _clearDevice(removeListener = true) {
    if (removeListener && this.device) {
      try {
        this.device.removeEventListener("inputreport", this._onInputReport);
      } catch {
        /* ignore */
      }
    }
    this.device = null;
    this.connectionType = "unknown";
    this.connected = false;
    this.padId = "";
    this.touch.active = false;
    this.touch.pressed = false;
    this.reportCount = 0;
    this.lastReportId = null;
    this.lastReportLen = 0;
  }

  _handleInputReport(event) {
    if (!this.enabled || event.device !== this.device) return;

    const report = event.data;
    const reportId = event.reportId;
    this.reportCount += 1;
    this.lastReportId = reportId;
    this.lastReportLen = report.byteLength;

    const pressed = extractTouchpadPressed(reportId, report);
    if (pressed !== null) this.touch.pressed = pressed;

    const contact = extractTouch(reportId, report);
    if (!contact) {
      // Still receiving HID — just not a touch-bearing report yet.
      return;
    }

    const inRange =
      contact.active && contact.x < TOUCH_MAX_X && contact.y < TOUCH_MAX_Y;
    this.touch.active = inRange;
    if (!inRange) return;

    const n = normalizeTouch(contact.x, contact.y);
    this.touch.x = n.x;
    this.touch.y = n.y;

    // Drive mixer immediately (don't wait for rAF poll).
    if (this._shouldDriveMixer()) {
      setTarget(n.x, n.y, "touchpad", true);
    }
  }
}

export const dualsenseHid = new DualsenseHid();
