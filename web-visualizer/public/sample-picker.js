/**
 * Shared sample library picker (shell-level <dialog>).
 * Browse samples/ by folder; callers bind selection via onSelect.
 */

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
      <div class="sample-picker-list" data-picker-list role="list"></div>
      <p class="sample-picker-hint">${AUDIO_HINT}</p>
    </form>
  `;
  document.body.appendChild(dialogEl);

  titleEl = dialogEl.querySelector("[data-picker-title]");
  crumbsEl = dialogEl.querySelector("[data-picker-crumbs]");
  listEl = dialogEl.querySelector("[data-picker-list]");
  errorEl = dialogEl.querySelector("[data-picker-error]");

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

function sampleUrl(folder, name) {
  const rel = folder ? `${folder}/${name}` : name;
  return `/samples/${rel.split("/").map(encodeURIComponent).join("/")}`;
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

function ensureDropdownDom() {
  if (dropdownEl) return;
  dropdownEl = document.createElement("div");
  dropdownEl.className = "stem-dropdown";
  dropdownEl.hidden = true;
  dropdownEl.setAttribute("role", "listbox");
  dropdownEl.setAttribute("aria-hidden", "true");
  dropdownEl.innerHTML = `<div class="stem-dropdown-list" data-stem-dropdown-list></div>`;
  document.body.appendChild(dropdownEl);
  dropdownListEl = dropdownEl.querySelector("[data-stem-dropdown-list]");

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
}

function renderDropdownGroups(groups) {
  if (!dropdownListEl) return;
  dropdownListEl.replaceChildren();

  if (!groups?.length) {
    const empty = document.createElement("p");
    empty.className = "stem-dropdown-empty";
    empty.textContent = "No samples found";
    dropdownListEl.appendChild(empty);
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
      const label = name.replace(/\.[^.]+$/, "");
      btn.textContent = label;
      btn.title = name;
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const file = {
          name,
          path: group.folder ? `${group.folder}/${name}` : name,
          url: sampleUrl(group.folder, name),
          label,
        };
        const cb = dropdownOnSelect;
        closeStemDropdown();
        if (typeof cb === "function") cb(file);
      });
      dropdownListEl.appendChild(btn);
    }
  }
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
 * @param {{ anchor: HTMLElement, onSelect?: (file: object) => void }} opts
 */
export async function openStemDropdown(opts = {}) {
  ensureDropdownDom();
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

  try {
    const data = await loadAllSamples();
    renderDropdownGroups(data.groups || []);
    positionDropdown(opts.anchor);
    // #region agent log
    {
      const list = dropdownListEl;
      const item = list?.querySelector(".stem-dropdown-item");
      const header = list?.querySelector(".stem-dropdown-header");
      const csItem = item ? getComputedStyle(item) : null;
      const csList = list ? getComputedStyle(list) : null;
      const csDrop = dropdownEl ? getComputedStyle(dropdownEl) : null;
      fetch("http://127.0.0.1:7713/ingest/37fe76df-e741-4e85-9753-370c8a5ff593", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "6e0f59",
        },
        body: JSON.stringify({
          sessionId: "6e0f59",
          runId: "post-fix",
          hypothesisId: "A-B-C-D",
          location: "sample-picker.js:openStemDropdown",
          message: "dropdown item/list computed metrics after render",
          data: {
            itemCount: list ? list.querySelectorAll(".stem-dropdown-item").length : 0,
            list: list
              ? {
                  clientH: list.clientHeight,
                  scrollH: list.scrollHeight,
                  display: csList.display,
                  flexDir: csList.flexDirection,
                  overflow: csList.overflow,
                  mask: csList.maskImage || csList.webkitMaskImage,
                }
              : null,
            dropdown: dropdownEl
              ? {
                  maxH: dropdownEl.style.maxHeight,
                  clientH: dropdownEl.clientHeight,
                  display: csDrop.display,
                  overflow: csDrop.overflow,
                  backdrop: csDrop.backdropFilter,
                }
              : null,
            item: item
              ? {
                  text: item.textContent,
                  offsetH: item.offsetHeight,
                  scrollH: item.scrollHeight,
                  clientH: item.clientHeight,
                  lineHeight: csItem.lineHeight,
                  fontSize: csItem.fontSize,
                  overflow: csItem.overflow,
                  flexShrink: csItem.flexShrink,
                  mask: csItem.maskImage || csItem.webkitMaskImage,
                  padding: csItem.padding,
                  display: csItem.display,
                  className: item.className,
                }
              : null,
            header: header
              ? {
                  offsetH: header.offsetHeight,
                  lineHeight: getComputedStyle(header).lineHeight,
                }
              : null,
          },
          timestamp: Date.now(),
        }),
      }).catch(() => {});
    }
    // #endregion
  } catch (err) {
    dropdownListEl.replaceChildren();
    const errEl = document.createElement("p");
    errEl.className = "stem-dropdown-empty";
    errEl.textContent = err?.message || "Failed to load samples";
    dropdownListEl.appendChild(errEl);
  }

  dropdownOutsideHandler = (event) => {
    if (!dropdownEl || dropdownEl.hidden) return;
    if (dropdownEl.contains(event.target)) return;
    if (dropdownAnchor && dropdownAnchor.contains(event.target)) return;
    closeStemDropdown();
  };
  dropdownKeyHandler = (event) => {
    if (event.key === "Escape") closeStemDropdown();
  };
  // Next tick so the opening click does not immediately close
  window.setTimeout(() => {
    document.addEventListener("pointerdown", dropdownOutsideHandler, true);
    document.addEventListener("keydown", dropdownKeyHandler, true);
  }, 0);
}

export function invalidateSampleCache() {
  dropdownCache = null;
}
