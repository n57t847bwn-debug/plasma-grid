# Plasma Grid

A playable **analog** of a dielectric-barrier-discharge (DBD) filament lattice with a column of side electrodes. Built for **iPhone Safari, landscape**. Vanilla canvas — no build step.

Inspired by the phenomenology in Fan, Sheng, Dong et al., *Formation of side discharges in dielectric barrier discharge*, Sci. Rep. **7**, 8368 (2017): random spots → quasi-hexagonal packing → honeycomb superlattice (primary filaments + weaker side discharges in the gaps) → disorder as the applied voltage rises.

## What this analogizes

- **Filaments** as localized bright spots of intensity \(I\) that prefer a finite spacing (exclusion disk + invitation ring ≈ hexagonal lattice constant).
- **Dielectric memory** as a slower surface-charge field \(Q\). Firing deposits charge. Charge nearby **inhibits** (too close = overcrowding, quench). A weaker ring at the preferred spacing **invites** a neighbor — the toy version of a side discharge in the gap.
- **Global drive \(V\)** as applied AC peak. Turn it up: more filaments, then a honeycomb-ish web, then chaos.
- **Side electrodes** as a vertical strip of independent pads on the left edge. Hold a pad to **SEED** (nucleate a domain that can walk inward) or **KILL** (dump charge / suppress \(I\), eat a stable region from the edge). **PULSE** walks a signal down the row so a wave launches into the lattice.

Semi-stable hexagonal domains form and persist. Filaments can collide, die, or pair. Grain boundaries and defects are normal.

## What this is not

- **Not** a PIC / MCC / Poisson plasma solver. No electrons, ions, secondary emission, or real kV waveforms.
- **Not** Conway’s Game of Life. States are continuous; the rule is an activator–inhibitor / continuous CA (difference-of-Gaussians kernel + cubic self-activation + charge memory), not B3/S23.
- **Not** a quantitative match to gap distance, pressure, or frequency. Colors ape the purple/pink glow of the photographs, not a spectral line.

## How to run

Serve the folder over HTTP (Safari is happier than `file://`):

```bash
cd /workspace/plasma-grid
python3 -m http.server 8765
```

Then open `http://localhost:8765/` on desktop, or `http://<lan-ip>:8765/` from iPhone Safari. Rotate to **landscape**. Add to Home Screen if you want standalone.

## Controls

| Action | iPhone (landscape, fat thumbs) | Desktop |
|--------|--------------------------------|---------|
| Seed / quench a row | Hold a **metal pad** on the left rail (slide to paint several) | Mouse-hold a pad, or keys **1–9, 0** (first ten pads) |
| Drive voltage \(V\) | **DRIVE V** slider | Slider, or `[` `]` / `-` `=` |
| SEED vs KILL | **SEED** / **KILL** buttons | Buttons, or `S` / `K` |
| Traveling pulse | **PULSE** | **PULSE**, `P` / Space, or **↓** (down the row) / **↑** (up the row) |
| Clear lattice | **RESET** | **RESET** or `R` |

Safari rubber-band scroll, pinch-zoom, and text selection are blocked (`touch-action`, viewport `user-scalable=no`, `preventDefault` on `touchmove` / `gesturestart`, safe-area padding).

**Regimes (slider, left → right):** SPARSE → HEX → HONEYCOMB → CHAOS.

## Side electrodes and domains

Pads span the full left edge (~16 independent electrodes). Each one only talks to a short vertical band of cells, a few cells in from \(x=0\).

- **SEED:** raises \(I\) and bleeds off \(Q\) at the lip. If \(V\) is in the hex window, a filament nucleates and the invitation ring births neighbors **inward** — a domain front, not a global fill in one frame. At higher \(V\) the same seed can flood a honeycomb web.
- **KILL:** suppresses \(I\) and **dumps \(Q\)** with a longer inward falloff. The charge halo poisons nearby sites, so a stable patch is eaten from the edge; lost invitation can collapse a whole grain.
- **PULSE:** the hot pad walks the column. In SEED mode this launches a staggered wave into the lattice (side-discharge analog along the boundary). In KILL mode it chews a moving bite-mark down the edge.
- At very high \(V\), spontaneous nucleation and chaos wash out electrode influence. Drop \(V\) or RESET if the field is a purple soup.

## Files

- `index.html` — canvas, electrode rail, controls, iOS meta
- `style.css` — landscape layout, metal pads, fat hit targets, safe areas
- `sim.js` — kernel, \(I\)/\(Q\) step, electrodes, glow render, input
- `README.md` — this file

No build step. No dependencies.

## Known bugs / limits

- Hex domains are **semi-stable**, not a perfect crystal. Defects, grain boundaries, and slow drift are part of the analog; they are also where the toy diverges from a lab superlattice.
- **Resize / rotate rebuilds the grid** and warms a new random field (RESET is empty-on-purpose; first load is pre-warmed so it looks like a photo).
- Desktop keys **1–0** only reach the first ten of sixteen pads; use the mouse or PULSE for the rest.
- Two physics steps run on a slow frame, one on a fast frame — iPhone vs desktop can look slightly different in time.
- The convolution is a truncated DoG plus a ring, not a real electrostatic Green’s function. Overcrowding at high \(V\) can merge spots into blobs rather than a clean honeycomb framework.
- iOS chrome (address bar / home indicator) still steals height; `100dvh` and safe-area insets help but do not make every phone identical.
- No audio. No PIC particles hiding in the glow.
