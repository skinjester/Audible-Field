/**
 * Overlay scrollbar used by every scrolling pane in the visualizer.
 * Restyle it in styles.css under .ui-scroll — that updates every instance.
 */

const HIDE_MS = 700;

/** @type {WeakMap<HTMLElement, { sync: () => void, host: HTMLElement }>} */
const attached = new WeakMap();

/**
 * Hide the native scrollbar and draw a slim overlay thumb.
 * @param {HTMLElement} view
 * @returns {{ sync: () => void, host: HTMLElement } | null}
 */
export function attachUiScroll(view) {
  if (!(view instanceof HTMLElement)) return null;
  const existing = attached.get(view);
  if (existing) return existing;

  const parent = view.parentElement;
  if (!parent) return null;

  const host = document.createElement("div");
  host.className = "ui-scroll";
  parent.insertBefore(host, view);
  host.appendChild(view);
  view.classList.add("ui-scroll-view");

  const track = document.createElement("div");
  track.className = "ui-scroll-track";
  track.setAttribute("aria-hidden", "true");
  const thumb = document.createElement("div");
  thumb.className = "ui-scroll-thumb";
  track.appendChild(thumb);
  host.appendChild(track);

  /** @type {{ startY: number, startTop: number, maxTop: number } | null} */
  let drag = null;
  let hideTimer = 0;

  function metrics() {
    const viewH = view.clientHeight;
    const total = view.scrollHeight;
    const trackH = track.clientHeight;
    if (total <= viewH + 1 || trackH <= 0) return null;
    const thumbH = Math.max(28, Math.round((viewH / total) * trackH));
    const maxTop = Math.max(0, trackH - thumbH);
    const maxScroll = total - viewH;
    const top = maxScroll <= 0 ? 0 : (view.scrollTop / maxScroll) * maxTop;
    return { thumbH, maxTop, maxScroll, top };
  }

  function poke() {
    host.classList.add("is-hot");
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (drag || host.matches(":hover")) return;
      host.classList.remove("is-hot");
    }, HIDE_MS);
  }

  function sync() {
    const wasScrollable = host.classList.contains("is-scrollable");
    const next = metrics();
    host.classList.toggle("is-scrollable", !!next);
    if (!next) {
      thumb.style.height = "0px";
      return;
    }
    thumb.style.height = `${next.thumbH}px`;
    if (!drag) thumb.style.transform = `translateY(${next.top}px)`;
    if (!wasScrollable) poke();
  }

  view.addEventListener(
    "scroll",
    () => {
      if (!drag) sync();
      poke();
    },
    { passive: true }
  );

  host.addEventListener("pointerenter", poke);
  host.addEventListener("pointerleave", () => {
    if (drag) return;
    window.clearTimeout(hideTimer);
    host.classList.remove("is-hot");
  });

  thumb.addEventListener("pointerdown", (event) => {
    if (event.button != null && event.button !== 0) return;
    const next = metrics();
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    drag = { startY: event.clientY, startTop: next.top, maxTop: next.maxTop };
    thumb.classList.add("is-dragging");
    host.classList.add("is-hot");
    try {
      thumb.setPointerCapture(event.pointerId);
    } catch {
      /* ignore */
    }
  });

  thumb.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const next = metrics();
    if (!next) return;
    const top = Math.min(drag.maxTop, Math.max(0, drag.startTop + (event.clientY - drag.startY)));
    thumb.style.transform = `translateY(${top}px)`;
    view.scrollTop = drag.maxTop <= 0 ? 0 : (top / drag.maxTop) * next.maxScroll;
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    thumb.classList.remove("is-dragging");
    if (!host.matches(":hover")) host.classList.remove("is-hot");
    sync();
  };
  thumb.addEventListener("pointerup", endDrag);
  thumb.addEventListener("pointercancel", endDrag);
  thumb.addEventListener("lostpointercapture", endDrag);

  track.addEventListener("pointerdown", (event) => {
    if (event.target !== track) return;
    if (event.button != null && event.button !== 0) return;
    const next = metrics();
    if (!next) return;
    event.preventDefault();
    const rect = track.getBoundingClientRect();
    const y = event.clientY - rect.top - next.thumbH / 2;
    const top = Math.min(next.maxTop, Math.max(0, y));
    view.scrollTop = next.maxTop <= 0 ? 0 : (top / next.maxTop) * next.maxScroll;
    poke();
  });

  const dialog = view.closest("dialog");
  if (dialog) {
    dialog.addEventListener("toggle", () => {
      window.requestAnimationFrame(sync);
    });
  }

  const resize = new ResizeObserver(() => sync());
  resize.observe(host);
  resize.observe(view);
  const mutations = new MutationObserver(() => sync());
  mutations.observe(view, { childList: true, subtree: true, characterData: true });

  sync();
  const api = { sync, host };
  attached.set(view, api);
  return api;
}

/** Attach every [data-ui-scroll] element under root. */
export function mountUiScrolls(root = document) {
  for (const el of root.querySelectorAll("[data-ui-scroll]")) {
    if (el instanceof HTMLElement) attachUiScroll(el);
  }
}
