// Color tables.
//
// Every built-in palette is written in the GR color-table (.pal) format used by
// GRLevelX, Supercell Wx and RadarOmega, so the same parser handles ours and any
// table a user imports. Supported lines:
//   Color: value r g b [r2 g2 b2]        gradient from (r,g,b) at value to (r2,g2,b2) at the next value
//   Color4: value r g b a [r2 g2 b2 a2]  same with alpha
//   SolidColor: / SolidColor4:          one flat color up to the next value
//   Scale: s   Offset: o                 palette units = data units * s + o
//   RF: r g b                            range-folded color
//   Units: / Product: / Step:            informational

export const TEX_WIDTH = 1024;

// Data domain (native units) each product kind is drawn over.
export const DOMAINS = {
  REF: [-32, 95], VEL: [-100, 100], CC: [0.2, 1.06], ZDR: [-8, 8], KDP: [-3, 10],
  HC: [0, 16], VIL: [0, 90], ET: [0, 80], PRECIP: [0, 30],
};

export const BUILTIN = {
  REF: `Product: BR
Units: dBZ
Step: 5
Color4: -10  70  80 100   0    90 110 140 150
Color:    5  70 105 160    50 185 230
Color:   20  50 230  90    10 135  40
Color:   35 255 235  60   255 145  20
Color:   45 255  60  45   170   5  15
Color:   55 255  70 220   140  20 190
Color:   65 245 240 255   170 150 255
Color:   75  90 250 255    30 200 255
Color:   85  30 200 255`,

  VEL: `Product: BV
Units: KTS
Scale: 1.943844
Step: 10
RF: 125 50 160
Color: -140 245 250 255    95 245 255
Color:  -90   0 255 110     0 160  60
Color:  -50   0 120  45    20  60  30
Color:  -10  45  70  55   105 110 105
Color:    0 110 105 105    80  40  40
Color:   10  75  20  25   170  10  25
Color:   50 215  15  30   255  90  70
Color:   90 255 180 170   255 245 120
Color:  140 255 245 120`,

  CC: `Product: CC
Units: none
Step: 0.05
Color: 0.20  45  40  70    70  70 130
Color: 0.45  90  70 190   160  80 220
Color: 0.65  60 140 235    40 200 215
Color: 0.80  50 215 120   175 230  60
Color: 0.90 255 220  60   255 140  40
Color: 0.95 240  70  55   175  35  60
Color: 0.98 150  35  70   110  35  75
Color: 1.01 185 165 205   230 220 240
Color: 1.06 235 230 250`,

  ZDR: `Product: ZDR
Units: dB
Step: 1
Color: -4  55  55  90    90  90 140
Color: -1 135 135 160   195 195 205
Color:  0  60 155 225    45 210 225
Color:  1  45 225 120   145 230  60
Color:  2 255 240  75   255 180  45
Color:  3 255 105  45   225  30  45
Color:  4 255  75 210   160  30 200
Color:  6 240 225 255   255 255 255
Color:  8 255 255 255`,

  KDP: `Product: KDP
Units: deg/km
Step: 1
Color4: -2  90  90 100 120   150 150 160 160
Color:   0  70 120 200    60 185 225
Color: 0.5  50 210 110   150 230  60
Color: 1.5 255 235  70   255 170  40
Color: 2.5 255  95  45   200  20  40
Color:   4 255  80 220   150  30 200
Color:   7 240 225 255   255 255 255
Color:  10 255 255 255`,

  HC: `Product: HC
Units: class
SolidColor: 0.5  140 140 140
SolidColor: 1.5  120  80  40
SolidColor: 2.5  245 170 255
SolidColor: 3.5  140 185 255
SolidColor: 4.5   45  95 255
SolidColor: 5.5   80 215 100
SolidColor: 6.5   25 145  45
SolidColor: 7.5  255 210  60
SolidColor: 8.5  190 145 210
SolidColor: 9.5  255  60  50
SolidColor: 10.5 180   0  10
SolidColor: 11.5 255   0 220
SolidColor: 12.5 140 140 140
SolidColor: 13.5 230 230 230
SolidColor: 14.5   0   0   0`,

  VIL: `Product: VIL
Units: kg/m2
Step: 5
Color4: 0.5  70 100 160 140    60 170 225 230
Color:   5  50 220  90    15 140  45
Color:  15 255 235  65   255 150  30
Color:  30 255  65  45   170   5  20
Color:  45 255  70 220   140  20 190
Color:  60 245 240 255   170 150 255
Color:  80 170 150 255`,

  ET: `Product: ET
Units: kft
Step: 5
Color4: 2  70 100 160 140    60 170 225 230
Color: 20  50 220  90    15 140  45
Color: 30 255 235  65   255 150  30
Color: 40 255  65  45   170   5  20
Color: 50 255  70 220   140  20 190
Color: 60 245 240 255   170 150 255
Color: 75 170 150 255`,

  PRECIP: `Product: PRECIP
Units: in
Color4: 0.01 120 140 170 90    90 150 210 170
Color:  0.10  60 120 220    40 175 235
Color:  0.25  40 200 225    35 215 150
Color:  0.50  45 220  80    20 150  45
Color:  1.00 255 235  70   255 185  40
Color:  2.00 255 140  40   255  60  40
Color:  3.00 220  20  40   150  10  40
Color:  4.00 255  60 220   170  30 200
Color:  6.00 225 180 255   150 120 255
Color: 10.00 245 245 255   255 255 255
Color: 30.00 255 255 255`,
};

// Hydrometeor classes, indexed by decoded value (code / 10).
export const HC_CLASSES = [
  null,
  ['BI', 'Biological'], ['GC', 'Ground clutter / AP'], ['IC', 'Ice crystals'], ['DS', 'Dry snow'],
  ['WS', 'Wet snow'], ['RA', 'Light / moderate rain'], ['HR', 'Heavy rain'], ['BD', 'Big drops'],
  ['GR', 'Graupel'], ['HA', 'Hail and rain'], ['LH', 'Large hail'], ['GH', 'Giant hail'],
  null, ['UK', 'Unknown'],
];

export function parsePal(text) {
  const out = { entries: [], scale: 1, offset: 0, units: '', product: '', rf: [125, 50, 160, 255], step: null };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z0-9]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const rest = m[2].trim();
    const nums = rest.split(/[\s,]+/).map(Number);
    switch (key) {
      case 'scale': out.scale = nums[0] || 1; break;
      case 'offset': out.offset = nums[0] || 0; break;
      case 'units': out.units = rest; break;
      case 'product': out.product = rest; break;
      case 'step': out.step = nums[0]; break;
      case 'rf': if (nums.length >= 3) out.rf = [nums[0], nums[1], nums[2], 255]; break;
      case 'color': case 'solidcolor': case 'color4': case 'solidcolor4': {
        const alpha = key.endsWith('4');
        const n = alpha ? 4 : 3;
        if (nums.length < 1 + n || nums.some(Number.isNaN)) break;
        const c1 = nums.slice(1, 1 + n);
        let c2 = nums.length >= 1 + 2 * n ? nums.slice(1 + n, 1 + 2 * n) : null;
        if (!alpha) { c1.push(255); if (c2) c2.push(255); }
        out.entries.push({ v: nums[0], c1, c2, solid: key.startsWith('solid') });
        break;
      }
    }
  }
  out.entries.sort((a, b) => a.v - b.v);
  if (!out.entries.length) throw new Error('No Color lines found in this color table.');
  return out;
}

/** RGBA (0-255) for a value in palette units, or null when the palette leaves it blank. */
export function colorAt(pal, x) {
  const e = pal.entries;
  if (x < e[0].v) return null;
  let i = e.length - 1;
  while (i > 0 && e[i].v > x) i--;
  const a = e[i];
  if (i === e.length - 1) return a.c1;
  if (a.solid) return a.c1;
  const b = e[i + 1];
  const t = (x - a.v) / (b.v - a.v);
  const end = a.c2 || b.c1;
  return a.c1.map((c, k) => c + (end[k] - c) * t);
}

/** Palette texture data: TEX_WIDTH RGBA texels over the domain [vmin, vmax] in data units. */
export function paletteTexture(pal, vmin, vmax) {
  const px = new Uint8Array(TEX_WIDTH * 4);
  for (let i = 0; i < TEX_WIDTH; i++) {
    const v = vmin + ((i + 0.5) / TEX_WIDTH) * (vmax - vmin);
    const c = colorAt(pal, v * pal.scale + pal.offset);
    if (!c) continue;
    const a = c[3] / 255;
    // Premultiplied alpha, which MapLibre's blending expects.
    px[i * 4] = Math.round(c[0] * a);
    px[i * 4 + 1] = Math.round(c[1] * a);
    px[i * 4 + 2] = Math.round(c[2] * a);
    px[i * 4 + 3] = Math.round(c[3]);
  }
  return px;
}

/** CSS gradient for the legend between two data values. */
export function cssGradient(pal, lo, hi, steps = 48) {
  const stops = [];
  for (let i = 0; i <= steps; i++) {
    const v = lo + (i / steps) * (hi - lo);
    const c = colorAt(pal, v * pal.scale + pal.offset) || [0, 0, 0, 0];
    const p = ((i / steps) * 100).toFixed(2);
    stops.push(`rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${(c[3] / 255).toFixed(3)}) ${p}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

export function rgbCss(c) {
  return c ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : 'transparent';
}
