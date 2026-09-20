/**
 * LAB GUI — the small tweak panel the lab pages use, in place of lil-gui.
 *
 * WHY IT EXISTS. The v3 labs used to import
 * `three/addons/libs/lil-gui.module.min.js`. The editor draws all its own
 * controls, so a third-party widget set for a couple of pages is import
 * surface we do not need, and it never matched the lab HUD sitting next to it.
 *
 * SCOPE: v3/vegetation-lab.html and v3/susuki-lab.html use this today. The
 * modular-road labs (asphalt, tube, wet-road, world-rain and friends) and
 * v3/ui/buildPlayPhysicsPanel.js still import lil-gui — point them here when
 * they are next touched; the API below is deliberately call-compatible.
 *
 * It implements the slice of lil-gui's API the labs actually call, so the call
 * sites did not have to change:
 *
 *   const gui = new GUI({ title })        gui.domElement
 *   gui.addFolder(name)  → folder, .close() chainable
 *   f.add(obj, key, min, max, step)       number  → slider + editable value
 *   f.add(obj, key, [a, b, c])            choice  → select
 *   f.add(obj, key)                       boolean → checkbox
 *   f.add(obj, key)  (value is fn)        action  → button
 *   f.addColor(obj, key)                  colour  → native picker
 *   c.name(s) · c.onChange(fn) · c.onFinishChange(fn)
 *   c.updateDisplay() · c.destroy() · f.controllers
 *
 * `onChange` fires while dragging; `onFinishChange` fires on release — the
 * distinction matters because the labs rebuild geometry on the second one and
 * only push a uniform on the first.
 */

let cssInjected = false;
let rowSeq = 0;

const CSS = `
.labgui {
  position: fixed; top: 10px; right: 10px; z-index: 20;
  width: 282px; max-height: 92vh; overflow-y: auto;
  background: rgba(10, 16, 12, 0.92); border: 1px solid #27352a;
  border-radius: 8px; color: #dfe6ea;
  font: 12px/1.45 system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.labgui::-webkit-scrollbar { width: 8px; }
.labgui::-webkit-scrollbar-thumb { background: #27352a; border-radius: 4px; }
.labgui > h2 {
  margin: 0; padding: 9px 11px; font-size: 11px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase; color: #cfd8b8;
  border-bottom: 1px solid #27352a;
}
.labgui-folder > h3 {
  margin: 0; padding: 7px 11px; font-size: 11px; font-weight: 600;
  letter-spacing: .04em; color: #9fb39f; cursor: pointer; user-select: none;
  border-top: 1px solid #1d2a20; display: flex; align-items: center; gap: 6px;
}
.labgui-folder > h3:hover { color: #d8e4c8; background: rgba(255,255,255,0.03); }
.labgui-folder > h3::before {
  content: "▾"; font-size: 9px; width: 9px; color: #6f7f6f;
}
.labgui-folder.closed > h3::before { content: "▸"; }
.labgui-folder.closed > .labgui-rows { display: none; }
.labgui-rows { padding: 2px 0 5px; }

.labgui-row {
  display: grid; grid-template-columns: 84px minmax(0, 1fr); align-items: center;
  gap: 8px; padding: 2px 11px; min-height: 22px;
}
/* Grid and flex children default to min-width:auto, so without this the number
   box cannot shrink and gets pushed off the panel instead of the slider giving
   way. */
.labgui-row > * { min-width: 0; }
.labgui-row > label {
  color: #8b998b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.labgui-row.wide { grid-template-columns: minmax(0, 1fr); }

.labgui-num { display: flex; align-items: center; gap: 6px; }
.labgui-num input[type=range] {
  flex: 1; min-width: 0; height: 14px; accent-color: #7fa848; cursor: pointer;
}
.labgui-num input[type=number] {
  width: 46px; flex: 0 0 auto; background: #121a14; color: #fff;
  border: 1px solid #27352a; border-radius: 3px; padding: 1px 3px;
  font: inherit; font-variant-numeric: tabular-nums; text-align: right;
}
.labgui-num input[type=number]::-webkit-outer-spin-button,
.labgui-num input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

.labgui select {
  width: 100%; background: #121a14; color: #dfe6ea; border: 1px solid #27352a;
  border-radius: 3px; padding: 2px 4px; font: inherit; cursor: pointer;
}
.labgui input[type=color] {
  width: 100%; height: 19px; padding: 0; background: #121a14; cursor: pointer;
  border: 1px solid #27352a; border-radius: 3px;
}
.labgui input[type=checkbox] { accent-color: #7fa848; cursor: pointer; margin: 0; }
.labgui button {
  width: 100%; background: #1a2a1d; color: #d8e4c8; border: 1px solid #27352a;
  border-radius: 3px; padding: 4px 6px; font: inherit; cursor: pointer;
}
.labgui button:hover { background: #24382a; border-color: #3c5142; }
`;

function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  const el = document.createElement("style");
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** One row. `read`/`write` bridge the widget and obj[key]. */
class Controller {
  constructor(folder, obj, key, row, labelEl, apply) {
    this.folder = folder;
    this.object = obj;                 // lil-gui calls it `object`; a lab reads it
    this.property = key;
    this.domElement = row;
    this._label = labelEl;
    this._apply = apply;               // (value) => void, pushes obj -> widget
    this._onChange = null;
    this._onFinish = null;
  }
  name(text) { if (this._label) this._label.textContent = text; return this; }
  onChange(fn) { this._onChange = fn; return this; }
  onFinishChange(fn) { this._onFinish = fn; return this; }
  updateDisplay() { this._apply(this.object[this.property]); return this; }
  destroy() {
    this.domElement.remove();
    const i = this.folder.controllers.indexOf(this);
    if (i >= 0) this.folder.controllers.splice(i, 1);
  }
  /** Commit a new value: store it, then fire the right callback. */
  _set(v, finished) {
    this.object[this.property] = v;
    this._onChange?.(v);
    if (finished) this._onFinish?.(v);
  }
}

class Folder {
  constructor(parentEl, title) {
    this.controllers = [];
    this.folders = [];
    this.domElement = document.createElement("div");
    this.domElement.className = "labgui-folder";
    if (title != null) {
      const h = document.createElement("h3");
      h.textContent = title;
      h.addEventListener("click", () => this.domElement.classList.toggle("closed"));
      this.domElement.appendChild(h);
    }
    this._rows = document.createElement("div");
    this._rows.className = "labgui-rows";
    this.domElement.appendChild(this._rows);
    parentEl.appendChild(this.domElement);
  }

  close() { this.domElement.classList.add("closed"); return this; }
  open()  { this.domElement.classList.remove("closed"); return this; }

  addFolder(title) {
    const f = new Folder(this._rows, title);
    this.folders.push(f);
    return f;
  }

  _row(labelText, wide = false) {
    const row = document.createElement("div");
    row.className = wide ? "labgui-row wide" : "labgui-row";
    let label = null;
    // `id` so the <label> can point at the control: without it every row logs
    // an accessibility issue, and clicking the name does not focus the widget.
    const id = `labgui-${++rowSeq}`;
    if (!wide) {
      label = document.createElement("label");
      label.textContent = labelText;
      label.htmlFor = id;
      row.appendChild(label);
    }
    this._rows.appendChild(row);
    return { row, label, id };
  }

  /**
   * Number (min/max/step), choice (array), boolean, or action (the property is
   * a function) — picked the same way lil-gui picks it, from the arguments and
   * the current value.
   */
  add(obj, key, a, b, c) {
    const value = obj[key];
    if (typeof value === "function")             return this._addButton(obj, key);
    if (Array.isArray(a))                        return this._addSelect(obj, key, a);
    if (typeof value === "boolean")              return this._addBoolean(obj, key);
    return this._addNumber(obj, key, a, b, c);
  }

  _addNumber(obj, key, min = 0, max = 1, step) {
    const { row, label, id } = this._row(key);
    const wrap = document.createElement("div");
    wrap.className = "labgui-num";
    const slider = document.createElement("input");
    slider.type = "range";
    const num = document.createElement("input");
    num.type = "number";
    // No step given: pick one fine enough that the slider is not chunky.
    const st = step ?? ((max - min) / 200 || 0.01);
    for (const el of [slider, num]) { el.min = min; el.max = max; el.step = st; }
    slider.id = id;
    num.name = `${id}-value`;
    num.setAttribute("aria-label", `${key} value`);
    wrap.append(slider, num);
    row.appendChild(wrap);

    const dp = Math.max(0, Math.min(4, Math.ceil(-Math.log10(st))));
    const apply = (v) => {
      slider.value = String(v);
      num.value = Number(v).toFixed(Number.isInteger(st) ? 0 : dp);
    };
    const ctrl = new Controller(this, obj, key, row, label, apply);
    const read = (el) => {
      const v = parseFloat(el.value);
      return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : obj[key];
    };
    // 'input' is the drag, 'change' is the release — the labs rely on both.
    slider.addEventListener("input", () => { const v = read(slider); apply(v); ctrl._set(v, false); });
    slider.addEventListener("change", () => { const v = read(slider); apply(v); ctrl._set(v, true); });
    num.addEventListener("change", () => { const v = read(num); apply(v); ctrl._set(v, true); });
    apply(obj[key]);
    this.controllers.push(ctrl);
    return ctrl;
  }

  _addSelect(obj, key, options) {
    const { row, label, id } = this._row(key);
    const sel = document.createElement("select");
    sel.id = id;
    for (const o of options) {
      const opt = document.createElement("option");
      opt.value = String(o);
      opt.textContent = String(o);
      sel.appendChild(opt);
    }
    row.appendChild(sel);
    const apply = (v) => { sel.value = String(v); };
    const ctrl = new Controller(this, obj, key, row, label, apply);
    sel.addEventListener("change", () => {
      // Keep the stored type: a numeric option list must not become strings.
      const raw = sel.value;
      const match = options.find((o) => String(o) === raw);
      ctrl._set(match !== undefined ? match : raw, true);
    });
    apply(obj[key]);
    this.controllers.push(ctrl);
    return ctrl;
  }

  _addBoolean(obj, key) {
    const { row, label, id } = this._row(key);
    const box = document.createElement("input");
    box.id = id;
    box.type = "checkbox";
    row.appendChild(box);
    const apply = (v) => { box.checked = !!v; };
    const ctrl = new Controller(this, obj, key, row, label, apply);
    box.addEventListener("change", () => ctrl._set(box.checked, true));
    apply(obj[key]);
    this.controllers.push(ctrl);
    return ctrl;
  }

  _addButton(obj, key) {
    const { row } = this._row(key, true);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = key;
    row.appendChild(btn);
    const ctrl = new Controller(this, obj, key, row, null, () => {});
    ctrl.name = (text) => { btn.textContent = text; return ctrl; };
    btn.addEventListener("click", () => obj[key]());
    this.controllers.push(ctrl);
    return ctrl;
  }

  addColor(obj, key) {
    const { row, label, id } = this._row(key);
    const input = document.createElement("input");
    input.id = id;
    input.type = "color";
    row.appendChild(input);
    const apply = (v) => { input.value = normaliseHex(v); };
    const ctrl = new Controller(this, obj, key, row, label, apply);
    input.addEventListener("input",  () => ctrl._set(input.value, false));
    input.addEventListener("change", () => ctrl._set(input.value, true));
    apply(obj[key]);
    this.controllers.push(ctrl);
    return ctrl;
  }
}

/** `#rgb`, `0xRRGGBB` and plain numbers all reach these panels. */
function normaliseHex(v) {
  if (typeof v === "number") return `#${v.toString(16).padStart(6, "0")}`;
  const s = String(v ?? "#000000").trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return "#000000";
}

export default class GUI extends Folder {
  constructor({ title = "Settings", parent = document.body } = {}) {
    injectCss();
    const root = document.createElement("div");
    root.className = "labgui";
    parent.appendChild(root);
    super(root, null);                 // the root has no folder header of its own
    const h = document.createElement("h2");
    h.textContent = title;
    root.insertBefore(h, root.firstChild);
    // `domElement` is the panel, so a lab can still set maxHeight on it.
    this.domElement = root;
    this._panel = root;
  }
  destroy() { this._panel.remove(); }
}
