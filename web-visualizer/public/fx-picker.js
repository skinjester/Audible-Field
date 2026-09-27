/**
 * Face-button FX / WAM picker dropdown (same chrome as stem sample dropdown).
 */

/**
 * Face-button FX / WAM picker dropdown (same chrome as stem sample dropdown).
 * Square / Triangle / Circle list all vendored WAMs. Cross (X) has no picker.
 */

const FX_SLOTS = ["square", "triangle", "circle"];

let dropdownEl = null;
let dropdownListEl = null;
let dropdownScrollEl = null;
let dropdownThumbEl = null;
let dropdownOutsideHandler = null;
let dropdownKeyHandler = null;
/** @type {HTMLElement | null} */
let dropdownAnchor = null;
let dropdownOnSelect = null;
let dropdownThumbDrag = null;
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
  if (!dropdownListEl || !dropdownScrollEl || !dropdownThumbEl) return;
  const view = dropdownListEl.clientHeight;
  const total = dropdownListEl.scrollHeight;
  const track = dropdownScrollEl.clientHeight;
  if (total <= view + 1 || track <= 0) {
    dropdownScrollEl.classList.remove("is-needed");
    dropdownThumbEl.style.height = "0px";
    return;
  }
  dropdownScrollEl.classList.add("is-needed");
  const thumbH = Math.max(20, Math.round((view / total) * track));
  const maxTop = track - thumbH;
  const maxScroll = total - view;
  const top =
    maxScroll <= 0 ? 0 : Math.round((dropdownListEl.scrollTop / maxScroll) * maxTop);
  dropdownThumbEl.style.height = `${thumbH}px`;
  dropdownThumbEl.style.transform = `translateY(${top}px)`;
}

function bindDropdownScrollbar() {
  if (!dropdownListEl || !dropdownScrollEl || !dropdownThumbEl) return;

  dropdownListEl.addEventListener("scroll", () => {
    if (dropdownThumbDrag) return;
    syncDropdownScrollbar();
  });

  dropdownThumbEl.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const track = dropdownScrollEl.clientHeight;
    const thumbH = dropdownThumbEl.offsetHeight;
    const maxTop = Math.max(0, track - thumbH);
    const startY = event.clientY;
    const match = /translateY\(([-\d.]+)px\)/.exec(dropdownThumbEl.style.transform || "");
    const startTop = match ? Number(match[1]) : 0;
    dropdownThumbDrag = { startY, startTop, maxTop };
    dropdownThumbEl.classList.add("is-dragging");
    dropdownThumbEl.setPointerCapture(event.pointerId);
  });

  dropdownThumbEl.addEventListener("pointermove", (event) => {
    if (!dropdownThumbDrag) return;
    const { startY, startTop, maxTop } = dropdownThumbDrag;
    const top = Math.min(maxTop, Math.max(0, startTop + (event.clientY - startY)));
    dropdownThumbEl.style.transform = `translateY(${top}px)`;
    const view = dropdownListEl.clientHeight;
    const total = dropdownListEl.scrollHeight;
    const maxScroll = Math.max(0, total - view);
    dropdownListEl.scrollTop = maxTop <= 0 ? 0 : (top / maxTop) * maxScroll;
  });

  const endDrag = () => {
    if (!dropdownThumbDrag) return;
    dropdownThumbDrag = null;
    dropdownThumbEl.classList.remove("is-dragging");
  };
  dropdownThumbEl.addEventListener("pointerup", endDrag);
  dropdownThumbEl.addEventListener("pointercancel", endDrag);
  dropdownThumbEl.addEventListener("lostpointercapture", endDrag);
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
      <div class="stem-dropdown-scroll" data-fx-dropdown-scroll aria-hidden="true">
        <div class="stem-dropdown-thumb" data-fx-dropdown-thumb></div>
      </div>
    </div>`;
  document.body.appendChild(dropdownEl);
  dropdownListEl = dropdownEl.querySelector("[data-fx-dropdown-list]");
  dropdownScrollEl = dropdownEl.querySelector("[data-fx-dropdown-scroll]");
  dropdownThumbEl = dropdownEl.querySelector("[data-fx-dropdown-thumb]");
  bindDropdownScrollbar();
  dropdownEl.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
}

function positionDropdown(anchor) {
  if (!dropdownEl || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const pad = 8;
  const maxW = Math.min(280, window.innerWidth - pad * 2);
  let left = rect.left;
  let top = rect.bottom + 4;

  dropdownEl.style.width = `${maxW}px`;
  dropdownEl.style.maxHeight = `${Math.min(320, window.innerHeight - pad * 2)}px`;
  dropdownEl.hidden = false;
  dropdownEl.setAttribute("aria-hidden", "false");

  const dd = dropdownEl.getBoundingClientRect();
  if (left + dd.width > window.innerWidth - pad) {
    left = Math.max(pad, window.innerWidth - pad - dd.width);
  }
  if (top + dd.height > window.innerHeight - pad) {
    top = Math.max(pad, rect.top - dd.height - 4);
  }
  left = Math.max(pad, left);

  dropdownEl.style.left = `${Math.round(left)}px`;
  dropdownEl.style.top = `${Math.round(top)}px`;
  syncDropdownScrollbar();
}

async function loadWamPlugins() {
  if (wamCache) return wamCache;
  const res = await fetch("/api/wams");
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
  const { closeStemDropdown } = await import("./sample-picker.js?v=16");
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
