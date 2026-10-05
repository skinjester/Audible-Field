/**
 * Face-button FX / WAM picker dropdown (same chrome as stem sample dropdown).
 */

/**
 * Face-button FX / WAM picker dropdown (same chrome as stem sample dropdown).
 * Square / Triangle / Circle list all vendored WAMs. Cross (X) has no picker.
 */

import { attachUiScroll } from "./ui-scroll.js?v=1";

const FX_SLOTS = ["square", "triangle", "circle"];

let dropdownEl = null;
let dropdownListEl = null;
/** @type {{ sync: () => void, host: HTMLElement } | null} */
let dropdownScroll = null;
let dropdownOutsideHandler = null;
let dropdownKeyHandler = null;
/** @type {HTMLElement | null} */
let dropdownAnchor = null;
let dropdownOnSelect = null;
/** @type {object[] | null} */
let wamCache = null;

function closeFxDropdown() {
  if (dropdownOutsideHandler) {
    document.removeEventListener("pointerdown", dropdownOutsideHandler, true);
    dropdownOutsideHandler = null;
  }
  if (dropdownKeyHandler) {
    document.removeEventListener("keydown", dropdownKeyHandler, true);
    dropdownKeyHandler = null;
  }
  dropdownOnSelect = null;
  if (dropdownAnchor) {
    dropdownAnchor.classList.remove("is-open");
    dropdownAnchor.setAttribute("aria-expanded", "false");
    dropdownAnchor = null;
  }
  if (dropdownEl) {
    dropdownEl.hidden = true;
    dropdownEl.setAttribute("aria-hidden", "true");
  }
}

function bindDropdownDismiss() {
  if (dropdownOutsideHandler) {
    document.removeEventListener("pointerdown", dropdownOutsideHandler, true);
  }
  if (dropdownKeyHandler) {
    document.removeEventListener("keydown", dropdownKeyHandler, true);
  }
  dropdownOutsideHandler = (event) => {
    if (!dropdownEl || dropdownEl.hidden) return;
    const target = event.target;
    if (target instanceof Node) {
      if (dropdownEl.contains(target)) return;
      if (dropdownAnchor && dropdownAnchor.contains(target)) return;
    }
    closeFxDropdown();
  };
  dropdownKeyHandler = (event) => {
    if (event.key === "Escape") closeFxDropdown();
  };
  document.addEventListener("pointerdown", dropdownOutsideHandler, true);
  document.addEventListener("keydown", dropdownKeyHandler, true);
}

function syncDropdownScrollbar() {
  dropdownScroll?.sync();
}

function ensureDropdownDom() {
  if (dropdownEl) return;
  dropdownEl = document.createElement("div");
  dropdownEl.className = "stem-dropdown";
  dropdownEl.hidden = true;
  dropdownEl.setAttribute("role", "listbox");
  dropdownEl.setAttribute("aria-hidden", "true");
  dropdownEl.innerHTML = `
    <div class="stem-dropdown-body">
      <div class="stem-dropdown-list" data-fx-dropdown-list></div>
    </div>`;
  document.body.appendChild(dropdownEl);
  dropdownListEl = dropdownEl.querySelector("[data-fx-dropdown-list]");
  dropdownScroll = dropdownListEl ? attachUiScroll(dropdownListEl) : null;
  dropdownEl.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
}

function viewportBox() {
  const pad = 8;
  const vv = window.visualViewport;
  if (!vv) {
    return {
      top: pad,
      left: pad,
      right: window.innerWidth - pad,
      bottom: window.innerHeight - pad,
    };
  }
  return {
    top: vv.offsetTop + pad,
    left: vv.offsetLeft + pad,
    right: vv.offsetLeft + vv.width - pad,
    bottom: vv.offsetTop + vv.height - pad,
  };
}

function positionDropdown(anchor) {
  if (!dropdownEl || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const box = viewportBox();
  const maxW = Math.min(280, box.right - box.left);
  let left = rect.left;

  dropdownEl.style.width = `${maxW}px`;
  dropdownEl.style.maxHeight = "none";
  dropdownEl.hidden = false;
  dropdownEl.setAttribute("aria-hidden", "false");

  const natural = dropdownEl.getBoundingClientRect().height;
  const room = Math.max(0, box.bottom - box.top);
  if (natural > room + 1) dropdownEl.style.maxHeight = `${Math.floor(room)}px`;

  const height = Math.min(natural, room);
  let top = rect.bottom + 4;
  if (top + height > box.bottom) top = box.bottom - height;
  if (top < box.top) top = box.top;
  if (left + maxW > box.right) left = box.right - maxW;
  if (left < box.left) left = box.left;

  dropdownEl.style.left = `${Math.round(left)}px`;
  dropdownEl.style.top = `${Math.round(top)}px`;
  syncDropdownScrollbar();
}

async function loadWamPlugins() {
  if (wamCache) return wamCache;
  const res = await fetch("/catalog/wams.json");
  if (!res.ok) throw new Error(`Could not load WAMs (${res.status})`);
  const data = await res.json();
  wamCache = Array.isArray(data.plugins) ? data.plugins : [];
  return wamCache;
}

/**
 * @param {string} slot
 * @param {object[]} plugins
 */
function buildGroups(slot, plugins) {
  // Face WAM pickers: all vendored WAMs (X / Cross has no picker — it bypasses WAMs).
  const byVendor = new Map();
  for (const plugin of plugins) {
    const vendor = plugin.vendor || "WAM";
    if (!byVendor.has(vendor)) byVendor.set(vendor, []);
    byVendor.get(vendor).push({
      id: plugin.id,
      label: plugin.name,
      kind: "wam",
      path: plugin.path,
      vendor: plugin.vendor,
      slot,
    });
  }

  const groups = [];
  for (const [vendor, items] of [...byVendor.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    items.sort((a, b) => a.label.localeCompare(b.label));
    groups.push({ folder: vendor, items });
  }

  return groups;
}

function renderGroups(groups) {
  if (!dropdownListEl) return;
  dropdownListEl.replaceChildren();

  if (!groups?.length) {
    const empty = document.createElement("p");
    empty.className = "stem-dropdown-empty";
    empty.textContent = "No FX available";
    dropdownListEl.appendChild(empty);
    syncDropdownScrollbar();
    return;
  }

  for (const group of groups) {
    const header = document.createElement("div");
    header.className = "stem-dropdown-header";
    header.textContent = String(group.folder || "FX").toUpperCase();
    dropdownListEl.appendChild(header);

    for (const item of group.items || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "stem-dropdown-item";
      btn.setAttribute("role", "option");
      btn.textContent = item.label;
      btn.title = item.kind === "wam" ? item.path : item.label;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const cb = dropdownOnSelect;
        closeFxDropdown();
        if (typeof cb === "function") cb(item);
      });
      dropdownListEl.appendChild(btn);
    }
  }
  syncDropdownScrollbar();
}

/**
 * Open FX/WAM picker for a face-button slot.
 * @param {{ anchor: HTMLElement, slot: string, onSelect?: (choice: object) => void }} opts
 */
export async function openFxDropdown(opts = {}) {
  const slot = opts.slot;
  if (!FX_SLOTS.includes(slot)) return;

  ensureDropdownDom();
  const { closeStemDropdown } = await import("./sample-picker.js?v=19");
  closeStemDropdown();

  if (
    dropdownEl &&
    !dropdownEl.hidden &&
    opts.anchor &&
    dropdownAnchor === opts.anchor
  ) {
    closeFxDropdown();
    return;
  }

  closeFxDropdown();

  dropdownAnchor = opts.anchor || null;
  if (dropdownAnchor) {
    dropdownAnchor.classList.add("is-open");
    dropdownAnchor.setAttribute("aria-expanded", "true");
  }

  dropdownOnSelect = typeof opts.onSelect === "function" ? opts.onSelect : null;
  dropdownListEl.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "stem-dropdown-empty";
  loading.textContent = "Loading…";
  dropdownListEl.appendChild(loading);
  positionDropdown(opts.anchor);
  bindDropdownDismiss();

  try {
    const plugins = await loadWamPlugins();
    if (dropdownEl?.hidden || dropdownAnchor !== opts.anchor) return;
    renderGroups(buildGroups(slot, plugins));
    positionDropdown(opts.anchor);
  } catch (err) {
    if (dropdownEl?.hidden || dropdownAnchor !== opts.anchor) return;
    dropdownListEl.replaceChildren();
    const errEl = document.createElement("p");
    errEl.className = "stem-dropdown-empty";
    errEl.textContent = err?.message || "Failed to load FX list";
    dropdownListEl.appendChild(errEl);
  }
}

export function invalidateWamCache() {
  wamCache = null;
}

export { closeFxDropdown };
