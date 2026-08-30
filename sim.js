/* Plasma Grid
   Continuous-CA analog of a dielectric-barrier-discharge filament lattice.
   NOT a PIC plasma solver. NOT Conway's Game of Life.
   Activator I (filament brightness) + inhibitor Q (dielectric surface charge).
   Mexican-hat / difference-of-Gaussians coupling → preferred hexagonal spacing.
   Left-edge electrodes seed or quench domains.
*/
(() => {
  "use strict";

  const N_EL = 16;
  const R = 5.6; // preferred lattice constant, in cells

  const field = document.getElementById("field");
  const ctx = field.getContext("2d", { alpha: false });
  const padsRoot = document.getElementById("pads");
  const rail = document.getElementById("rail");
  const hudV = document.getElementById("hud-v");
  const hudRegime = document.getElementById("hud-regime");
  const hudMode = document.getElementById("hud-mode");
  const hint = document.getElementById("hint");
  const vSlider = document.getElementById("v-slider");
  const btnSeed = document.getElementById("btn-seed");
  const btnKill = document.getElementById("btn-kill");
  const btnPulse = document.getElementById("btn-pulse");
  const btnReset = document.getElementById("btn-reset");

  const off = document.createElement("canvas");
  const offCtx = off.getContext("2d", { alpha: false });

  let W = 80, H = 40;
  let I = new Float32Array(W * H);
  let Q = new Float32Array(W * H);
  let I2 = new Float32Array(W * H);
  let Q2 = new Float32Array(W * H);
  let pix = null;

  let kdx, kdy, kw, kN;

  let V = 0.34;
  let mode = "seed"; // seed | kill
  const held = new Set(); // electrode indices currently held
  const ptrPad = new Map(); // pointerId -> pad index
  const paintOn = new Map(); // pointerId -> true/false while dragging

  let pulseOn = false;
  let pulseI = 0;
  let pulseDir = 1;
  let pulseAcc = 0;
  const PULSE_DT = 0.085;

  let interacted = false;
  let dpr = 1, cssW = 1, cssH = 1;

  const LUT_R = new Uint8Array(256);
  const LUT_G = new Uint8Array(256);
  const LUT_B = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const t2 = t * t;
    const t3 = t2 * t;
    const t5 = t3 * t2;
    LUT_R[i] = Math.min(255, (18 * t + 160 * t2 + 255 * t3 * t) | 0);
    LUT_G[i] = Math.min(255, (4 * t + 30 * t2 + 210 * t5) | 0);
    LUT_B[i] = Math.min(255, (40 * t + 90 * t2 + 200 * t3) | 0);
  }

  function buildKernel() {
    const rad = (R * 2.05 + 1) | 0;
    const dxs = [], dys = [], ws = [];
    const sigA = 1.12, sigI = 2.85;
    const A = 2.55, B = 0.78;
    const ring = 0.28, rsig = 0.70;
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const r = Math.hypot(dx, dy);
        let w = A * Math.exp(-(r * r) / (2 * sigA * sigA))
              - B * Math.exp(-(r * r) / (2 * sigI * sigI));
        w += ring * Math.exp(-((r - R) * (r - R)) / (2 * rsig * rsig));
        if (Math.abs(w) > 0.025) {
          dxs.push(dx);
          dys.push(dy);
          ws.push(w);
        }
      }
    }
    kN = ws.length;
    kdx = new Int8Array(dxs);
    kdy = new Int8Array(dys);
    kw = new Float32Array(ws);
  }

  function allocate(nw, nh) {
    W = nw;
    H = nh;
    I = new Float32Array(W * H);
    Q = new Float32Array(W * H);
    I2 = new Float32Array(W * H);
    Q2 = new Float32Array(W * H);
    off.width = W;
    off.height = H;
    pix = offCtx.createImageData(W, H);
    const d = pix.data;
    for (let i = 0; i < W * H; i++) d[i * 4 + 3] = 255;
  }

  function elRows(e) {
    const y0 = Math.floor((e * H) / N_EL);
    const y1 = Math.max(y0 + 1, Math.floor(((e + 1) * H) / N_EL));
    return [y0, y1];
  }

  function step(dt) {
    const n = W * H;
    const convK = 0.15 + 0.10 * V;
    const qCoef = 0.62 + 0.15 * V;
    const drive = 0.02 + 0.55 * V;
    const extraDecay = 0.38 * Math.pow(Math.max(0, 0.26 - V), 1.15);
    const noiseAmp = 0.001 + 0.012 * V * V;
    const onTh = 0.18 - 0.06 * V;

    // mexican-hat convolution
    for (let i = 0; i < n; i++) {
      const x = i % W;
      const y = (i / W) | 0;
      let s = 0;
      for (let k = 0; k < kN; k++) {
        const xx = x + kdx[k];
        const yy = y + kdy[k];
        if (xx >= 0 && xx < W && yy >= 0 && yy < H) {
          s += kw[k] * I[yy * W + xx];
        }
      }
      const F = convK * s - qCoef * Q[i] + drive;
      const u = I[i];
      const cubic = u * (1.08 - u) * (u - onTh);
      let lap = 0;
      if (x > 0) lap += I[i - 1] - u;
      if (x < W - 1) lap += I[i + 1] - u;
      if (y > 0) lap += I[i - W] - u;
      if (y < H - 1) lap += I[i + W] - u;
      const grow = F > 0 ? 0.95 * F * (1.15 - u) : 0;
      let dI = -0.22 * u - extraDecay * u + 0.62 * cubic + grow + 0.035 * lap;
      dI += (Math.random() - 0.42) * noiseAmp;
      let v = u + dt * dI;
      if (v < 0) v = 0;
      else if (v > 1.25) v = 1.25;
      I2[i] = v;
    }

    // electrodes: seed nucleates at the edge; kill dumps charge and eats inward
    if (held.size || pulseOn) {
      const active = new Set(held);
      if (pulseOn) active.add(pulseI);
      const seed = mode === "seed";
      for (const e of active) {
        const [y0, y1] = elRows(e);
        const xMax = seed ? 7 : 16;
        for (let y = y0; y < y1; y++) {
          for (let x = 0; x < xMax && x < W; x++) {
            const i = y * W + x;
            if (seed) {
              const fall = Math.exp(-x / 2.15);
              I2[i] = Math.min(1.25, I2[i] + 0.28 * fall * dt);
              Q[i] *= 1 - 0.14 * fall;
            } else {
              const fall = Math.exp(-x / 4.6);
              I2[i] *= 1 - 0.62 * fall;
              Q[i] = Math.min(1.8, Q[i] + 0.36 * fall * dt);
            }
          }
        }
      }
    }

    // surface charge: deposited by firing, slow decay, spreads (memory + exclusion halo)
    for (let i = 0; i < n; i++) {
      const x = i % W;
      const y = (i / W) | 0;
      const u = I2[i];
      let lap = 0;
      if (x > 0) lap += Q[i - 1] - Q[i];
      if (x < W - 1) lap += Q[i + 1] - Q[i];
      if (y > 0) lap += Q[i - W] - Q[i];
      if (y < H - 1) lap += Q[i + W] - Q[i];
      let q = Q[i] + dt * (0.09 * u * u - 0.032 * Q[i] + 0.10 * lap);
      if (q < 0) q = 0;
      else if (q > 1.8) q = 1.8;
      Q2[i] = q;
    }

    let tmp = I; I = I2; I2 = tmp;
    tmp = Q; Q = Q2; Q2 = tmp;
  }

  function colorIndex(u) {
    let t = u / 1.22;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    // lift a faint violet floor so hex packing reads as a glow, not binary dots
    t = t * 0.92 + (t > 0.04 ? 0.08 * Math.sqrt(t) : 0);
    return (t * 255) | 0;
  }

  function render() {
    const d = pix.data;
    const n = W * H;
    for (let i = 0; i < n; i++) {
      const c = colorIndex(I[i]);
      const p = i * 4;
      d[p] = LUT_R[c];
      d[p + 1] = LUT_G[c];
      d[p + 2] = LUT_B[c];
    }
    offCtx.putImageData(pix, 0, 0);

    const dw = field.width;
    const dh = field.height;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, dw, dh);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.drawImage(off, 0, 0, dw, dh);

    // bloom: additive upscale of the same low-res field
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.45;
    ctx.drawImage(off, 0, 0, dw, dh);
    ctx.globalAlpha = 0.28;
    ctx.drawImage(off, -dw * 0.01, -dh * 0.01, dw * 1.02, dh * 1.02);

    // electrode injection glow along the left lip
    if (held.size || pulseOn) {
      const cellW = dw / W;
      const cellH = dh / H;
      const seed = mode === "seed";
      const active = new Set(held);
      if (pulseOn) active.add(pulseI);
      ctx.globalAlpha = 0.55;
      for (const e of active) {
        const [y0, y1] = elRows(e);
        const g = ctx.createLinearGradient(0, 0, cellW * 8, 0);
        if (seed) {
          g.addColorStop(0, "rgba(230,120,255,0.85)");
          g.addColorStop(1, "rgba(120,0,180,0)");
        } else {
          g.addColorStop(0, "rgba(255,80,50,0.85)");
          g.addColorStop(1, "rgba(80,0,0,0)");
        }
        ctx.fillStyle = g;
        ctx.fillRect(0, y0 * cellH, cellW * 9, (y1 - y0) * cellH);
      }
    }

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  function regimeName() {
    if (V < 0.14) return "SPARSE";
    if (V < 0.40) return "HEX";
    if (V < 0.64) return "HONEYCOMB";
    return "CHAOS";
  }

  function updateHud() {
    hudV.textContent = "V " + V.toFixed(2);
    hudRegime.textContent = regimeName();
    hudMode.textContent = mode.toUpperCase();
    hudMode.style.color = mode === "kill" ? "#f86" : "#e9f";
  }

  function setMode(m) {
    mode = m;
    btnSeed.classList.toggle("on", m === "seed");
    btnKill.classList.toggle("on", m === "kill");
    btnSeed.setAttribute("aria-pressed", m === "seed" ? "true" : "false");
    btnKill.setAttribute("aria-pressed", m === "kill" ? "true" : "false");
    updateHud();
    refreshPads();
  }

  function setV(v) {
    V = Math.max(0, Math.min(1, v));
    vSlider.value = String(Math.round(V * 100));
    updateHud();
  }

  function refreshPads() {
    const nodes = padsRoot.children;
    for (let e = 0; e < N_EL; e++) {
      const el = nodes[e];
      if (!el) continue;
      const hot = held.has(e) || (pulseOn && pulseI === e);
      el.classList.toggle("hot", hot);
      el.classList.toggle("seed", hot && mode === "seed");
      el.classList.toggle("kill", hot && mode === "kill");
      el.classList.toggle("pulse-mark", pulseOn && pulseI === e);
    }
  }

  function buildPads() {
    padsRoot.innerHTML = "";
    for (let e = 0; e < N_EL; e++) {
      const b = document.createElement("div");
      b.className = "pad";
      b.dataset.e = String(e);
      b.setAttribute("role", "button");
      b.setAttribute("aria-label", "Electrode " + (e + 1));
      padsRoot.appendChild(b);
    }
  }

  function padFromClient(clientX, clientY) {
    const railR = rail.getBoundingClientRect();
    const fieldR = field.getBoundingClientRect();
    const inRail = clientX >= railR.left - 12 && clientX <= railR.right + 40;
    const inLip = clientX >= fieldR.left && clientX <= fieldR.left + 56
      && clientY >= fieldR.top && clientY <= fieldR.bottom;
    if (!inRail && !inLip) return -1;
    const r = padsRoot.getBoundingClientRect();
    const top = r.height > 8 ? r.top : fieldR.top;
    const h = r.height > 8 ? r.height : fieldR.height;
    if (h <= 0) return 0;
    const t = (clientY - top) / h;
    return Math.max(0, Math.min(N_EL - 1, (t * N_EL) | 0));
  }

  function kickElectrode(e) {
    const [y0, y1] = elRows(e);
    const seed = mode === "seed";
    const xMax = seed ? 6 : 12;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < xMax && x < W; x++) {
        const i = y * W + x;
        const fall = Math.exp(-x / 2.3);
        if (seed) {
          I[i] = Math.min(1.25, I[i] + 0.72 * fall);
          Q[i] *= 1 - 0.45 * fall;
        } else {
          I[i] *= 1 - 0.78 * fall;
          Q[i] = Math.min(1.8, Q[i] + 0.55 * fall);
        }
      }
    }
  }

  function setPad(e, on) {
    if (on) {
      if (!held.has(e)) {
        held.add(e);
        kickElectrode(e);
      }
    } else {
      held.delete(e);
    }
    interacted = true;
    hint.classList.add("hide");
    refreshPads();
  }

  function hold(e) {
    setPad(e, true);
  }

  function unhold(e) {
    setPad(e, false);
  }

  function startPulse(dir) {
    pulseOn = true;
    pulseDir = dir;
    pulseI = dir > 0 ? 0 : N_EL - 1;
    pulseAcc = 0;
    interacted = true;
    hint.classList.add("hide");
    btnPulse.classList.add("on");
    refreshPads();
  }

  function stopPulse() {
    pulseOn = false;
    btnPulse.classList.remove("on");
    refreshPads();
  }

  function resetField(kind) {
    I.fill(0);
    Q.fill(0);
    if (kind === "warm") {
      // a few random filaments so the first frame looks like a DBD photo
      const nBlob = 9;
      for (let b = 0; b < nBlob; b++) {
        const x = 8 + ((Math.random() * (W - 14)) | 0);
        const y = 2 + ((Math.random() * (H - 4)) | 0);
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const g = Math.exp(-(dx * dx + dy * dy) / 1.55);
            const i = yy * W + xx;
            I[i] = Math.max(I[i], 0.95 * g);
          }
        }
      }
      const oldV = V;
      V = 0.32;
      for (let s = 0; s < 70; s++) step(1);
      V = oldV;
    }
  }

  function resize() {
    const rect = field.getBoundingClientRect();
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
    field.width = Math.round(cssW * dpr);
    field.height = Math.round(cssH * dpr);

    const cell = 8;
    let nw = Math.max(48, Math.min(96, (cssW / cell) | 0));
    let nh = Math.max(24, Math.min(48, (cssH / cell) | 0));
    // keep even-ish aspect so hex domains have room
    if (nw !== W || nh !== H || !pix) {
      allocate(nw, nh);
      resetField("warm");
    }
  }

  // ---------- input ----------
  // Sticky pads: tap to arm (stays on), tap again to off. Drag paints the same on/off.
  // No setPointerCapture — iOS Safari drops capture and was releasing the pad instantly.
  function onPtrDown(ev) {
    const e = padFromClient(ev.clientX, ev.clientY);
    if (e < 0) return;
    ev.preventDefault();
    const on = !held.has(e);
    paintOn.set(ev.pointerId, on);
    ptrPad.set(ev.pointerId, e);
    setPad(e, on);
  }
  function onPtrMove(ev) {
    if (!paintOn.has(ev.pointerId)) return;
    const e = padFromClient(ev.clientX, ev.clientY);
    if (e < 0) return;
    if (e !== ptrPad.get(ev.pointerId)) {
      ptrPad.set(ev.pointerId, e);
      setPad(e, paintOn.get(ev.pointerId));
    }
  }
  function onPtrUp(ev) {
    paintOn.delete(ev.pointerId);
    ptrPad.delete(ev.pointerId);
  }
  rail.addEventListener("pointerdown", onPtrDown);
  field.addEventListener("pointerdown", onPtrDown);
  window.addEventListener("pointermove", onPtrMove);
  window.addEventListener("pointerup", onPtrUp);
  window.addEventListener("pointercancel", onPtrUp);

  btnSeed.addEventListener("click", () => setMode("seed"));
  btnKill.addEventListener("click", () => setMode("kill"));
  btnPulse.addEventListener("click", () => {
    if (pulseOn) stopPulse();
    else startPulse(1);
  });
  btnReset.addEventListener("click", () => {
    stopPulse();
    held.clear();
    refreshPads();
    resetField("empty");
    hint.classList.remove("hide");
    interacted = false;
  });

  vSlider.addEventListener("input", () => {
    setV((+vSlider.value) / 100);
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.repeat && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) return;
    const k = ev.key;
    if (k >= "1" && k <= "9") {
      hold(k.charCodeAt(0) - 49);
      ev.preventDefault();
    } else if (k === "0") {
      hold(9);
      ev.preventDefault();
    } else if (k === "ArrowDown") {
      startPulse(1);
      ev.preventDefault();
    } else if (k === "ArrowUp") {
      startPulse(-1);
      ev.preventDefault();
    } else if (k === "s" || k === "S") {
      setMode("seed");
    } else if (k === "k" || k === "K") {
      setMode("kill");
    } else if (k === "p" || k === "P" || k === " ") {
      if (pulseOn) stopPulse();
      else startPulse(1);
      ev.preventDefault();
    } else if (k === "r" || k === "R") {
      btnReset.click();
    } else if (k === "[" || k === "-") {
      setV(V - 0.03);
    } else if (k === "]" || k === "=" || k === "+") {
      setV(V + 0.03);
    }
  });
  window.addEventListener("keyup", (ev) => {
    const k = ev.key;
    if (k >= "1" && k <= "9") unhold(k.charCodeAt(0) - 49);
    else if (k === "0") unhold(9);
  });

  // Safari: no bounce, no pinch-zoom, no double-tap zoom on the stage
  const swallow = (ev) => {
    const t = ev.target;
    if (t && t.closest && t.closest("#v-wrap, #pads, #rail, #controls")) return;
    ev.preventDefault();
  };
  document.addEventListener("touchmove", swallow, { passive: false });
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("gesturechange", (e) => e.preventDefault());
  document.addEventListener("dblclick", (e) => e.preventDefault());

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 200));

  // ---------- loop ----------
  let last = 0;
  function frame(t) {
    if (!last) last = t;
    let dt = (t - last) / 1000;
    last = t;
    if (dt > 0.08) dt = 0.08;

    if (pulseOn) {
      pulseAcc += dt;
      while (pulseAcc >= PULSE_DT) {
        pulseAcc -= PULSE_DT;
        pulseI += pulseDir;
        if (pulseI < 0 || pulseI >= N_EL) {
          stopPulse();
          break;
        }
        refreshPads();
      }
    }

    // 1–2 CA steps per frame; sim dt is O(1) like the tuned prototype
    step(1);
    const budget = dt > 0.028 ? 2 : 1;
    if (budget === 2) step(1);

    render();
    requestAnimationFrame(frame);
  }

  buildKernel();
  buildPads();
  setMode("seed");
  resize();
  updateHud();
  requestAnimationFrame(frame);
})();
