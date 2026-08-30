/* Plasma Grid
   Continuous-CA analog of a dielectric-barrier-discharge filament lattice.
   NOT a PIC plasma solver. NOT Conway's Game of Life.
   Left stick: center = 0, right attracts plasma, left is off.
   Diagonal swipe paints a group. ON/0 slams the pattern. WAVE travels.
*/
(() => {
  "use strict";

  const N_EL = 16;
  const R = 5.6;

  const field = document.getElementById("field");
  const ctx = field.getContext("2d", { alpha: false });
  const rail = document.getElementById("rail");
  const stick = document.getElementById("stick");
  const rowsRoot = document.getElementById("rows");
  const thumb = document.getElementById("thumb");
  const hudV = document.getElementById("hud-v");
  const hudRegime = document.getElementById("hud-regime");
  const hudMode = document.getElementById("hud-mode");
  const hint = document.getElementById("hint");
  const vSlider = document.getElementById("v-slider");
  const btnOn = document.getElementById("btn-on");
  const btnZero = document.getElementById("btn-zero");
  const btnWave = document.getElementById("btn-wave");
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
  const elV = new Float32Array(N_EL);
  const memory = new Float32Array(N_EL);
  let gateOn = true;

  let waveOn = false;
  let wavePos = 0;
  let waveDir = 1;
  let waveAcc = 0;
  const WAVE_SPEED = 7.5; // electrodes per second

  const dragging = new Map(); // pointerId -> { e, on }

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

  function waveAmp(e) {
    if (!waveOn) return 0;
    const d = e - wavePos;
    return Math.exp(-(d * d) / (2 * 1.55 * 1.55));
  }

  function writeAmp(e) {
    const g = gateOn ? elV[e] : 0;
    const w = waveAmp(e);
    return g > w ? g : w;
  }

  function attractAt(e, amp, dt, kick) {
    if (amp < 0.04) return;
    const [y0, y1] = elRows(e);
    const xMax = kick ? 8 : 7;
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < xMax && x < W; x++) {
        const i = y * W + x;
        const fall = Math.exp(-x / (kick ? 2.6 : 2.15)) * amp;
        I[i] = Math.min(1.25, I[i] + (kick ? 0.85 : 0.36 * dt) * fall);
        Q[i] *= 1 - 0.18 * fall;
      }
    }
  }

  function quenchAt(e, amp) {
    const [y0, y1] = elRows(e);
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < 12 && x < W; x++) {
        const i = y * W + x;
        const fall = Math.exp(-x / 4.2) * amp;
        I[i] *= 1 - 0.72 * fall;
        Q[i] = Math.min(1.8, Q[i] + 0.4 * fall);
      }
    }
  }

  function step(dt) {
    const n = W * H;
    const convK = 0.15 + 0.10 * V;
    const qCoef = 0.62 + 0.15 * V;
    const drive = 0.02 + 0.55 * V;
    const extraDecay = 0.38 * Math.pow(Math.max(0, 0.26 - V), 1.15);
    const noiseAmp = 0.001 + 0.012 * V * V;
    const onTh = 0.18 - 0.06 * V;

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

    // right side of the stick attracts plasma at the lip; wave is a traveling bump
    for (let e = 0; e < N_EL; e++) {
      const amp = writeAmp(e);
      if (amp < 0.04) continue;
      const [y0, y1] = elRows(e);
      const deep = waveOn ? 10 : 7;
      for (let y = y0; y < y1; y++) {
        for (let x = 0; x < deep && x < W; x++) {
          const i = y * W + x;
          const fall = Math.exp(-x / (waveOn ? 3.1 : 2.15)) * amp;
          I2[i] = Math.min(1.25, I2[i] + 0.38 * fall * dt);
          Q[i] *= 1 - 0.16 * fall;
        }
      }
    }

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

    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.45;
    ctx.drawImage(off, 0, 0, dw, dh);
    ctx.globalAlpha = 0.28;
    ctx.drawImage(off, -dw * 0.01, -dh * 0.01, dw * 1.02, dh * 1.02);

    const cellW = dw / W;
    const cellH = dh / H;
    for (let e = 0; e < N_EL; e++) {
      const amp = writeAmp(e);
      if (amp < 0.04) continue;
      const [y0, y1] = elRows(e);
      const g = ctx.createLinearGradient(0, 0, cellW * 10, 0);
      g.addColorStop(0, "rgba(230,120,255," + (0.3 + 0.6 * amp).toFixed(3) + ")");
      g.addColorStop(1, "rgba(120,0,180,0)");
      ctx.fillStyle = g;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(0, y0 * cellH, cellW * 11, (y1 - y0) * cellH);
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
    hudMode.textContent = waveOn ? "WAVE" : (gateOn ? "GATE ON" : "GATE 0");
    hudMode.style.color = waveOn ? "#fef" : (gateOn ? "#e9f" : "#888");
  }

  function setV(v) {
    V = Math.max(0, Math.min(1, v));
    vSlider.value = String(Math.round(V * 100));
    updateHud();
  }

  function snapshot() {
    let any = false;
    for (let e = 0; e < N_EL; e++) if (elV[e] > 0.06) { any = true; break; }
    if (any) memory.set(elV);
  }

  function refreshStick() {
    const nodes = rowsRoot.children;
    for (let e = 0; e < N_EL; e++) {
      const el = nodes[e];
      if (!el) continue;
      const shown = gateOn ? elV[e] : 0;
      const w = waveAmp(e);
      el.style.setProperty("--v", shown.toFixed(3));
      el.style.setProperty("--w", w.toFixed(3));
      el.classList.toggle("hot", shown > 0.06);
      el.classList.toggle("wave", w > 0.18);
    }
    const y = ((waveOn ? wavePos : thumbE) + 0.5) / N_EL;
    thumb.style.top = (y * 100) + "%";
    thumb.classList.toggle("on", waveOn || gateOn);
  }

  let thumbE = 7.5;

  function buildRows() {
    rowsRoot.innerHTML = "";
    for (let e = 0; e < N_EL; e++) {
      const row = document.createElement("div");
      row.className = "el-row";
      row.dataset.e = String(e);
      const fill = document.createElement("div");
      fill.className = "el-fill";
      row.appendChild(fill);
      rowsRoot.appendChild(row);
    }
  }

  function rowFromY(clientY) {
    const r = stick.getBoundingClientRect();
    if (r.height <= 0) return 0;
    const t = (clientY - r.top) / r.height;
    return Math.max(0, Math.min(N_EL - 1, (t * N_EL) | 0));
  }

  function polarityFromX(clientX) {
    const r = stick.getBoundingClientRect();
    const mid = r.left + r.width * 0.5;
    const dx = clientX - mid;
    const dead = Math.max(10, r.width * 0.08);
    if (dx > dead) return 1;   // right = attract / on
    if (dx < -dead) return 0;  // left = off
    return -1;                 // center = 0, ignore
  }

  function paintGroup(eCenter, on) {
    // a short brush so a diagonal swipe turns a group, not one sliver
    for (let d = -1; d <= 1; d++) {
      const e = eCenter + d;
      if (e < 0 || e >= N_EL) continue;
      const fall = d === 0 ? 1 : 0.55;
      if (on) {
        const v = Math.max(elV[e], fall);
        if (v > elV[e]) {
          elV[e] = v;
          if (gateOn) attractAt(e, v, 1, true);
        }
      } else {
        if (elV[e] > 0.04) quenchAt(e, 0.9 * fall);
        elV[e] = 0;
      }
    }
    thumbE = eCenter;
    interacted = true;
    hint.classList.add("hide");
    refreshStick();
    updateHud();
  }

  function patternOn() {
    gateOn = true;
    let any = false;
    for (let e = 0; e < N_EL; e++) if (elV[e] > 0.06) any = true;
    if (!any) elV.set(memory);
    for (let e = 0; e < N_EL; e++) if (elV[e] > 0.06) attractAt(e, elV[e], 1, true);
    btnOn.classList.add("on");
    btnOn.setAttribute("aria-pressed", "true");
    refreshStick();
    updateHud();
  }

  function patternZero() {
    snapshot();
    for (let e = 0; e < N_EL; e++) {
      if (elV[e] > 0.06) quenchAt(e, 0.55);
      elV[e] = 0;
    }
    gateOn = false;
    btnOn.classList.remove("on");
    btnOn.setAttribute("aria-pressed", "false");
    refreshStick();
    updateHud();
  }

  function startWave() {
    waveOn = true;
    wavePos = 0;
    waveDir = 1;
    waveAcc = 0;
    btnWave.classList.add("on");
    interacted = true;
    hint.classList.add("hide");
    refreshStick();
    updateHud();
  }

  function stopWave() {
    waveOn = false;
    btnWave.classList.remove("on");
    refreshStick();
    updateHud();
  }

  function resetField(kind) {
    I.fill(0);
    Q.fill(0);
    if (kind === "warm") {
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
    if (nw !== W || nh !== H || !pix) {
      allocate(nw, nh);
      resetField("warm");
    }
  }

  function onPtrDown(ev) {
    const r = stick.getBoundingClientRect();
    if (ev.clientX < r.left - 8 || ev.clientX > r.right + 8) return;
    if (ev.clientY < r.top - 8 || ev.clientY > r.bottom + 8) return;
    ev.preventDefault();
    const e = rowFromY(ev.clientY);
    let on = polarityFromX(ev.clientX);
    if (on < 0) on = 1; // tap on the center line still attracts that row
    dragging.set(ev.pointerId, { e, on: !!on });
    paintGroup(e, !!on);
  }
  function onPtrMove(ev) {
    const st = dragging.get(ev.pointerId);
    if (!st) return;
    ev.preventDefault();
    const e = rowFromY(ev.clientY);
    const pol = polarityFromX(ev.clientX);
    if (pol >= 0) st.on = !!pol;
    st.e = e;
    paintGroup(e, st.on);
  }
  function onPtrUp(ev) {
    dragging.delete(ev.pointerId);
  }

  stick.addEventListener("pointerdown", onPtrDown);
  window.addEventListener("pointermove", onPtrMove, { passive: false });
  window.addEventListener("pointerup", onPtrUp);
  window.addEventListener("pointercancel", onPtrUp);

  btnOn.addEventListener("click", () => patternOn());
  btnZero.addEventListener("click", () => patternZero());
  btnWave.addEventListener("click", () => {
    if (waveOn) stopWave();
    else startWave();
  });
  btnReset.addEventListener("click", () => {
    stopWave();
    elV.fill(0);
    memory.fill(0);
    gateOn = true;
    btnOn.classList.add("on");
    resetField("empty");
    hint.classList.remove("hide");
    interacted = false;
    refreshStick();
    updateHud();
  });

  vSlider.addEventListener("input", () => setV((+vSlider.value) / 100));

  window.addEventListener("keydown", (ev) => {
    const k = ev.key;
    if (k >= "1" && k <= "9") {
      paintGroup(k.charCodeAt(0) - 49, true);
      ev.preventDefault();
    } else if (k === "0") {
      patternZero();
    } else if (k === "ArrowDown") {
      startWave();
      waveDir = 1;
      ev.preventDefault();
    } else if (k === "ArrowUp") {
      startWave();
      waveDir = -1;
      wavePos = N_EL - 1;
      ev.preventDefault();
    } else if (k === "o" || k === "O") {
      patternOn();
    } else if (k === "w" || k === "W" || k === "p" || k === "P" || k === " ") {
      if (waveOn) stopWave();
      else startWave();
      ev.preventDefault();
    } else if (k === "r" || k === "R") {
      btnReset.click();
    } else if (k === "[" || k === "-") {
      setV(V - 0.03);
    } else if (k === "]" || k === "=" || k === "+") {
      setV(V + 0.03);
    }
  });

  const swallow = (ev) => {
    const t = ev.target;
    if (t && t.closest && t.closest("#v-wrap, #stick, #rail, #controls")) return;
    ev.preventDefault();
  };
  document.addEventListener("touchmove", swallow, { passive: false });
  document.addEventListener("gesturestart", (e) => e.preventDefault());
  document.addEventListener("gesturechange", (e) => e.preventDefault());
  document.addEventListener("dblclick", (e) => e.preventDefault());

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => setTimeout(resize, 200));

  let last = 0;
  function frame(t) {
    if (!last) last = t;
    let dt = (t - last) / 1000;
    last = t;
    if (dt > 0.08) dt = 0.08;

    if (waveOn) {
      wavePos += waveDir * WAVE_SPEED * dt;
      if (wavePos >= N_EL - 0.5) { wavePos = N_EL - 0.5; waveDir = -1; }
      if (wavePos < 0.5) { wavePos = 0.5; waveDir = 1; }
      refreshStick();
    }

    step(1);
    const budget = dt > 0.028 ? 2 : 1;
    if (budget === 2) step(1);

    render();
    requestAnimationFrame(frame);
  }

  buildKernel();
  buildRows();
  resize();
  updateHud();
  refreshStick();
  requestAnimationFrame(frame);
})();
