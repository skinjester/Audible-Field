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
