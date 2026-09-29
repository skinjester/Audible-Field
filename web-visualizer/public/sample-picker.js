/**
 * Shared sample library picker (shell-level <dialog>).
 * Browse samples/ by folder; callers bind selection via onSelect.
 */

import { attachUiScroll } from "./ui-scroll.js?v=1";

const AUDIO_HINT = "wav · aif · mp3 · ogg";

let dialogEl = null;
let titleEl = null;
let crumbsEl = null;
let listEl = null;
let errorEl = null;
let activeOnSelect = null;
let currentPath = "";
let startPathDefault = "";
let rootsFilter = null;
let loadToken = 0;

function ensureDom() {
  if (dialogEl) return;

  dialogEl = document.createElement("dialog");
  dialogEl.className = "sample-picker";
  dialogEl.dataset.samplePicker = "";
  dialogEl.innerHTML = `
    <form method="dialog" class="sample-picker-panel">
      <header class="sample-picker-head">
        <div>
          <p class="kicker">Library</p>
          <h2 data-picker-title>Samples</h2>
        </div>
        <button type="submit" value="cancel" class="sample-picker-close" aria-label="Close">Close</button>
      </header>
      <nav class="sample-picker-crumbs" data-picker-crumbs aria-label="Folder path"></nav>
      <p class="sample-picker-error" data-picker-error hidden></p>
      <div class="sample-picker-list" data-picker-list data-ui-scroll role="list"></div>
      <p class="sample-picker-hint">${AUDIO_HINT}</p>
    </form>
  `;
  document.body.appendChild(dialogEl);

  titleEl = dialogEl.querySelector("[data-picker-title]");
  crumbsEl = dialogEl.querySelector("[data-picker-crumbs]");
  listEl = dialogEl.querySelector("[data-picker-list]");
  errorEl = dialogEl.querySelector("[data-picker-error]");
  if (listEl) attachUiScroll(listEl);

  dialogEl.addEventListener("close", () => {
    activeOnSelect = null;
  });

  dialogEl.addEventListener("click", (event) => {
    if (event.target === dialogEl) dialogEl.close();
  });
}

function joinPath(base, name) {
  if (!base) return name;
  return `${base}/${name}`;
}

function parentPath(rel) {
  if (!rel) return "";
  const parts = rel.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function setError(message) {
  if (!errorEl) return;
  if (!message) {
    errorEl.hidden = true;
    errorEl.textContent = "";
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function renderCrumbs(relPath) {
  if (!crumbsEl) return;
  crumbsEl.replaceChildren();

  const rootBtn = document.createElement("button");
  rootBtn.type = "button";
  rootBtn.className = "sample-picker-crumb";
  rootBtn.textContent = "samples";
  rootBtn.addEventListener("click", () => void navigateTo(""));
  crumbsEl.appendChild(rootBtn);

  const parts = String(relPath || "")
    .split("/")
    .filter(Boolean);
  let acc = "";
  for (const part of parts) {
    acc = joinPath(acc, part);
    const sep = document.createElement("span");
    sep.className = "sample-picker-crumb-sep";
    sep.textContent = "/";
    crumbsEl.appendChild(sep);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sample-picker-crumb";
    btn.textContent = part;
    const target = acc;
    btn.addEventListener("click", () => void navigateTo(target));
    crumbsEl.appendChild(btn);
  }
}

function makeRow({ kind, name, onActivate }) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `sample-picker-row sample-picker-row-${kind}`;
  row.setAttribute("role", "listitem");
  row.innerHTML = `<span class="sample-picker-kind">${kind === "dir" ? "Folder" : "File"}</span><span class="sample-picker-name"></span>`;
  row.querySelector(".sample-picker-name").textContent = name;
  row.addEventListener("click", onActivate);
  return row;
}

function filterDirs(dirs) {
  if (!rootsFilter || currentPath) return dirs;
  const allow = new Set(rootsFilter);
  return dirs.filter((name) => allow.has(name));
}

async function navigateTo(relPath) {
  ensureDom();
  currentPath = String(relPath || "").replace(/^\/+|\/+$/g, "");
  renderCrumbs(currentPath);
  setError("");
  listEl.replaceChildren();
  listEl.textContent = "Loading…";

  const token = ++loadToken;
  try {
    const res = await fetch(`/api/samples?path=${encodeURIComponent(currentPath)}`);
    if (!res.ok) throw new Error(`Could not open folder (${res.status})`);
    const data = await res.json();
    if (token !== loadToken) return;

    listEl.replaceChildren();

    if (currentPath) {
      listEl.appendChild(
        makeRow({
          kind: "dir",
          name: "…",
          onActivate: () => void navigateTo(parentPath(currentPath)),
        })
      );
    }

    const dirs = filterDirs(data.dirs || []);
    for (const name of dirs) {
      listEl.appendChild(
        makeRow({
          kind: "dir",
          name,
          onActivate: () => void navigateTo(joinPath(currentPath, name)),
        })
      );
    }

    for (const name of data.files || []) {
      listEl.appendChild(
        makeRow({
          kind: "file",
          name,
          onActivate: () => selectFile(name),
        })
      );
    }

    if (!dirs.length && !(data.files || []).length) {
      const empty = document.createElement("p");
      empty.className = "sample-picker-empty";
      empty.textContent = "Empty folder";
      listEl.appendChild(empty);
    }
  } catch (err) {
    if (token !== loadToken) return;
    listEl.replaceChildren();
    setError(err?.message || "Failed to list samples");
  }
}

function selectFile(name) {
  const rel = joinPath(currentPath, name);
  const file = {
    name,
    path: rel,
    url: `/samples/${rel.split("/").map(encodeURIComponent).join("/")}`,
    label: name.replace(/\.[^.]+$/, ""),
  };
  const cb = activeOnSelect;
  dialogEl?.close();
  if (typeof cb === "function") cb(file);
}

/**
 * Open the sample picker modal.
 * @param {{ title?: string, startPath?: string, roots?: string[], onSelect?: (file: object) => void }} [opts]
 */
export function openSamplePicker(opts = {}) {
  ensureDom();
  activeOnSelect = typeof opts.onSelect === "function" ? opts.onSelect : null;
  rootsFilter = Array.isArray(opts.roots) && opts.roots.length ? opts.roots : null;
  startPathDefault = String(opts.startPath || "").replace(/^\/+|\/+$/g, "");
  if (titleEl) titleEl.textContent = opts.title || "Samples";

  const start = startPathDefault;
  if (!dialogEl.open) dialogEl.showModal();
  void navigateTo(start);
}

export function closeSamplePicker() {
  if (dialogEl?.open) dialogEl.close();
}

/* —— Flat stem dropdown (pad quadrant labels) —— */

let dropdownEl = null;
let dropdownListEl = null;
/** @type {{ sync: () => void, host: HTMLElement } | null} */
let dropdownScroll = null;
let dropdownCache = null;
let dropdownOnSelect = null;
let dropdownOutsideHandler = null;
let dropdownKeyHandler = null;
/** @type {HTMLElement | null} */
let dropdownAnchor = null;

function folderHeaderLabel(folder) {
  if (!folder) return "SAMPLES";
  return folder
    .split("/")
    .filter(Boolean)
    .join(" / ")
    .toUpperCase();
}

function sampleUrl(folder, name, urlBase) {
  const base = urlBase || "/samples";
  const rel = urlBase ? name : folder ? `${folder}/${name}` : name;
  return `${base}/${String(rel).split("/").map(encodeURIComponent).join("/")}`;
}

function closeStemDropdown() {
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

/** Capture-phase so outside clicks still dismiss even if a control stopPropagates. */
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
    closeStemDropdown();
  };
  dropdownKeyHandler = (event) => {
    if (event.key === "Escape") closeStemDropdown();
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
      <div class="stem-dropdown-list" data-stem-dropdown-list></div>
    </div>`;
  document.body.appendChild(dropdownEl);
  dropdownListEl = dropdownEl.querySelector("[data-stem-dropdown-list]");
  dropdownScroll = dropdownListEl ? attachUiScroll(dropdownListEl) : null;

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

  // Measure after show
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

function renderDropdownGroups(groups) {
  if (!dropdownListEl) return;
  dropdownListEl.replaceChildren();

  if (!groups?.length) {
    const empty = document.createElement("p");
    empty.className = "stem-dropdown-empty";
    empty.textContent = "No samples found";
    dropdownListEl.appendChild(empty);
    syncDropdownScrollbar();
    return;
  }

  for (const group of groups) {
    const header = document.createElement("div");
    header.className = "stem-dropdown-header";
    header.textContent = folderHeaderLabel(group.folder);
    dropdownListEl.appendChild(header);

    for (const name of group.files || []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "stem-dropdown-item";
      btn.setAttribute("role", "option");
      const rawLabel = name.replace(/\.[^.]+$/, "");
      const label = group.urlBase ? rawLabel.replace(/-rx$/i, "") : rawLabel;
      btn.textContent = label;
      btn.title = name;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const file = {
          name,
          path: group.folder ? `${group.folder}/${name}` : name,
          url: sampleUrl(group.folder, name, group.urlBase),
          label,
        };
        const cb = dropdownOnSelect;
        closeStemDropdown();
        if (typeof cb === "function") cb(file);
      });
      dropdownListEl.appendChild(btn);
    }
  }
  syncDropdownScrollbar();
}

async function loadAllSamples() {
  if (dropdownCache) return dropdownCache;
  const res = await fetch("/api/samples/all");
  if (!res.ok) throw new Error(`Could not load samples (${res.status})`);
  dropdownCache = await res.json();
  return dropdownCache;
}

/**
 * Open a flat sample dropdown anchored to a StemSlot.
 * Stays open until a sample is chosen, Escape, or the same label is clicked again.
 * @param {{ anchor: HTMLElement, onSelect?: (file: object) => void }} opts
 */
export async function openStemDropdown(opts = {}) {
  ensureDropdownDom();
  const { closeFxDropdown } = await import("./fx-picker.js?v=4");
  closeFxDropdown();

  // Toggle closed if the same slot is already open.
  if (
    dropdownEl &&
    !dropdownEl.hidden &&
    opts.anchor &&
    dropdownAnchor === opts.anchor
  ) {
    closeStemDropdown();
    return;
  }

  closeStemDropdown();
  closeSamplePicker();

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
  // Bind dismiss immediately (open is on click; opening pointerdown already finished).
  // Do not stopPropagation — pad/sticks still receive the same event.
  bindDropdownDismiss();

  try {
    const data = await loadAllSamples();
    // Closed while loading — don't rebuild or re-bind.
    if (dropdownEl?.hidden || dropdownAnchor !== opts.anchor) return;
    renderDropdownGroups(data.groups || []);
    positionDropdown(opts.anchor);
  } catch (err) {
    if (dropdownEl?.hidden || dropdownAnchor !== opts.anchor) return;
    dropdownListEl.replaceChildren();
    const errEl = document.createElement("p");
    errEl.className = "stem-dropdown-empty";
    errEl.textContent = err?.message || "Failed to load samples";
    dropdownListEl.appendChild(errEl);
  }
}

export function invalidateSampleCache() {
  dropdownCache = null;
}

export { closeStemDropdown };
