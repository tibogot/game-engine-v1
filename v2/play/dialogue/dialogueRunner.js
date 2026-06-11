import * as THREE from "three";
import { getDialogueGraph } from "./dialogueGraphs.js";

const _headPos = new THREE.Vector3();

/**
 * Play-mode dialogue UI + input. Engine-style runner over JSON-like graphs.
 */
export class DialogueRunner {
  constructor({ toolState, actorSystem, playMode, camera, domElement }) {
    this.toolState = toolState;
    this.actorSystem = actorSystem;
    this.playMode = playMode;
    this.camera = camera;
    this.domElement = domElement ?? document.body;
    this.active = false;
    this.graph = null;
    this.nodeId = null;
    this.targetInst = null;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._buildDom();
  }

  get blocksMovement() {
    return this.active;
  }

  get settings() {
    return this.toolState.actors.dialogue;
  }

  _buildDom() {
    const root = document.createElement("div");
    root.id = "dialogue-overlay";
    root.style.cssText = [
      "display:none",
      "position:fixed",
      "left:0;right:0;bottom:0",
      "z-index:9500",
      "pointer-events:none",
      "font-family:var(--font-sans,system-ui,sans-serif)",
    ].join(";");

    const prompt = document.createElement("div");
    prompt.id = "dialogue-prompt";
    prompt.style.cssText = [
      "display:none",
      "position:fixed",
      "left:0",
      "top:0",
      "transform:translate(-50%, calc(-100% - 10px))",
      "padding:6px 12px",
      "border-radius:6px",
      "font-size:12px",
      "font-weight:700",
      "color:#f2fff0",
      "background:rgba(10,22,14,0.88)",
      "border:1px solid rgba(130,210,150,0.45)",
      "box-shadow:0 4px 16px rgba(0,0,0,0.35)",
      "letter-spacing:0.06em",
      "white-space:nowrap",
      "pointer-events:none",
      "z-index:9600",
      "transition:opacity 0.12s ease",
    ].join(";");
    prompt.textContent = "Press E to talk";

    const panel = document.createElement("div");
    panel.id = "dialogue-panel";
    panel.style.cssText = [
      "margin:0 auto 28px",
      "max-width:720px",
      "padding:18px 22px 16px",
      "border-radius:12px",
      "background:rgba(8,14,22,0.92)",
      "border:1px solid rgba(100,160,200,0.28)",
      "box-shadow:0 12px 40px rgba(0,0,0,0.45)",
      "pointer-events:auto",
    ].join(";");

    const speaker = document.createElement("div");
    speaker.id = "dialogue-speaker";
    speaker.style.cssText =
      "font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:rgba(140,200,255,0.9);margin-bottom:8px;";

    const text = document.createElement("div");
    text.id = "dialogue-text";
    text.style.cssText =
      "font-size:17px;line-height:1.45;color:#f0f6fc;min-height:2.9em;white-space:pre-wrap;";

    const choices = document.createElement("div");
    choices.id = "dialogue-choices";
    choices.style.cssText = "margin-top:14px;display:flex;flex-direction:column;gap:8px;";

    const hint = document.createElement("div");
    hint.id = "dialogue-hint";
    hint.style.cssText =
      "margin-top:12px;font-size:11px;color:rgba(160,180,200,0.65);letter-spacing:0.06em;";
    hint.textContent = "E / Space — continue   Esc — close";

    panel.append(speaker, text, choices, hint);
    root.append(panel);
    document.body.append(root, prompt);

    this._root = root;
    this._prompt = prompt;
    this._panel = panel;
    this._speakerEl = speaker;
    this._textEl = text;
    this._choicesEl = choices;
    this._hintEl = hint;
  }

  attach() {
    document.addEventListener("keydown", this._onKeyDown, true);
  }

  detach() {
    document.removeEventListener("keydown", this._onKeyDown, true);
    this.end();
  }

  dispose() {
    this.detach();
    this._root?.remove();
    this._prompt?.remove();
  }

  _setMovementLock(on) {
    this.playMode.dialogueMovementLock = !!on;
  }

  _freezeTarget(freeze) {
    if (this.targetInst?.playRuntime) {
      this.targetInst.playRuntime.frozen = !!freeze;
    }
  }

  findNpcInRange(playerPos) {
    return this.actorSystem.findInteractableNpc(playerPos);
  }

  _npcHeadWorldPos(inst, out = _headPos) {
    const mesh = inst.playMesh;
    const p = this.toolState.actors;
    const above =
      (p.capsuleRadius ?? 0.35) * 2 + (p.capsuleHeight ?? 1) + 0.45;
    out.copy(mesh.position);
    out.y += above;
    return out;
  }

  _positionPromptOverNpc(inst) {
    const cam = this.camera;
    const el = this.domElement;
    if (!cam || !inst?.playMesh) return false;

    const head = this._npcHeadWorldPos(inst);
    head.project(cam);

    if (head.z > 1 || head.z < -1) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    const sx = (head.x * 0.5 + 0.5) * rect.width + rect.left;
    const sy = (-head.y * 0.5 + 0.5) * rect.height + rect.top;

    const margin = 48;
    if (
      sx < rect.left - margin ||
      sx > rect.right + margin ||
      sy < rect.top - margin ||
      sy > rect.bottom + margin
    ) {
      return false;
    }

    this._prompt.style.left = `${sx}px`;
    this._prompt.style.top = `${sy}px`;
    const fade = THREE.MathUtils.smoothstep(0.92, 1, head.z);
    this._prompt.style.opacity = String(1 - fade * 0.65);
    return true;
  }

  update(playerPos) {
    const dlg = this.settings;
    if (!dlg.enabled || this.active || !this.playMode.active) {
      this._prompt.style.display = "none";
      return;
    }
    const target = this.findNpcInRange(playerPos);
    if (!target) {
      this._prompt.style.display = "none";
      return;
    }

    const name = target.label?.trim();
    this._prompt.textContent = name
      ? `Press E — talk to ${name}`
      : "Press E to talk";

    if (this._positionPromptOverNpc(target)) {
      this._prompt.style.display = "block";
    } else {
      this._prompt.style.display = "none";
    }
  }

  start(inst) {
    const dlg = this.settings;
    const graphId = inst.dialogueId || dlg.defaultDialogueId;
    const graph = getDialogueGraph(graphId);
    if (!graph) {
      console.warn(`[Dialogue] Unknown graph: ${graphId}`);
      return false;
    }

    this.active = true;
    this.graph = graph;
    this.nodeId = graph.start;
    this.targetInst = inst;
    this._freezeTarget(true);
    this._setMovementLock(true);
    this._root.style.display = "block";
    this._prompt.style.display = "none";
    this._renderNode();
    return true;
  }

  end() {
    if (!this.active) return;
    this.active = false;
    this.graph = null;
    this.nodeId = null;
    this._freezeTarget(false);
    this.targetInst = null;
    this._setMovementLock(false);
    this._root.style.display = "none";
    this._choicesEl.innerHTML = "";
  }

  _currentNode() {
    return this.graph?.nodes?.[this.nodeId] ?? null;
  }

  _renderNode() {
    const node = this._currentNode();
    if (!node) {
      this.end();
      return;
    }

    const speaker =
      node.speaker ||
      this.targetInst?.label?.trim() ||
      (this.targetInst?.role === "enemy" ? "Enemy" : "NPC");
    this._speakerEl.textContent = speaker;
    this._textEl.textContent = node.text ?? "";
    this._choicesEl.innerHTML = "";

    if (node.choices?.length) {
      this._hintEl.textContent = "1 / 2 — pick a response   Esc — close";
      node.choices.forEach((choice, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.style.cssText = [
          "text-align:left",
          "padding:10px 12px",
          "border-radius:8px",
          "border:1px solid rgba(100,160,220,0.35)",
          "background:rgba(30,50,80,0.5)",
          "color:#e8f2fc",
          "font-size:14px",
          "cursor:pointer",
        ].join(";");
        btn.textContent = `${i + 1}. ${choice.text}`;
        btn.addEventListener("click", () => this._pickChoice(i));
        this._choicesEl.appendChild(btn);
      });
    } else {
      this._hintEl.textContent = "E / Space — continue   Esc — close";
    }
  }

  _advance() {
    const node = this._currentNode();
    if (!node) {
      this.end();
      return true;
    }
    if (node.choices?.length) return false;
    const next = node.next ?? null;
    if (!next) {
      this.end();
      return true;
    }
    this.nodeId = next;
    this._renderNode();
    return true;
  }

  _pickChoice(index) {
    const node = this._currentNode();
    const choice = node?.choices?.[index];
    if (!choice) return;
    const next = choice.next ?? null;
    if (!next) {
      this.end();
      return;
    }
    this.nodeId = next;
    this._renderNode();
  }

  _onKeyDown(event) {
    if (!this.playMode.active) return;

    const dlg = this.settings;
    if (!dlg.enabled) return;

    if (this.active) {
      if (event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.end();
        return;
      }
      if (event.repeat) return;

      const node = this._currentNode();
      if (node?.choices?.length) {
        if (event.code === "Digit1") {
          event.preventDefault();
          event.stopPropagation();
          this._pickChoice(0);
          return;
        }
        if (event.code === "Digit2") {
          event.preventDefault();
          event.stopPropagation();
          this._pickChoice(1);
          return;
        }
        return;
      }

      if (
        event.code === "KeyE" ||
        event.code === "Space" ||
        event.code === "Enter"
      ) {
        event.preventDefault();
        event.stopPropagation();
        this._advance();
      }
      return;
    }

    if (event.repeat || event.code !== "KeyE") return;
    if (this.playMode.flying || this.playMode.moveMode === "rts") return;

    const target = this.findNpcInRange(this.playMode.playerPos);
    if (!target) return;

    event.preventDefault();
    event.stopPropagation();
    this.start(target);
  }
}
