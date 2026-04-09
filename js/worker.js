/*  Stencil Maker — Processing Worker
 *  Runs off the main thread: preprocess → quantize (CIELAB) → dither → extract layers
 */

self.onmessage = function (e) {
  const { type, pixels, width, height, params, gen } = e.data;
  if (type !== 'process') return;

  // pixels arrives as Uint8ClampedArray with transferred buffer
  let data = pixels;

  // --- 1. Preprocess ---
  if (params.grayscale) toGrayscale(data);
  if (params.contrast !== 0) adjustContrast(data, params.contrast);
  if (params.brightness !== 0) adjustBrightness(data, params.brightness);
  if (params.saturation !== 0) adjustSaturation(data, params.saturation);
  if (params.blur > 0) data = boxBlur3Pass(data, width, height, params.blur);

  // --- 2. Quantize in CIELAB space ---
  const { assignments, palette } = kmeansQuantizeLab(data, width, height, params.n);

  // --- 3. Optional Floyd-Steinberg dithering ---
  if (params.dither) {
    floydSteinberg(data, width, height, palette, assignments);
  }

  // --- 4. Build quantized image ---
  const numPx = width * height;
  const quantized = new Uint8ClampedArray(numPx * 4);
  for (let i = 0; i < numPx; i++) {
    const c = palette[assignments[i]];
    quantized[i * 4] = c[0];
    quantized[i * 4 + 1] = c[1];
    quantized[i * 4 + 2] = c[2];
    quantized[i * 4 + 3] = 255;
  }

  // --- 5. Extract layer masks ---
  const layers = [];
  for (let j = 0; j < params.n; j++) {
    const mask = new Uint8Array(numPx);
    let count = 0;
    for (let i = 0; i < numPx; i++) {
      if (assignments[i] === j) { mask[i] = 255; count++; }
    }
    layers.push({ color: palette[j], mask: mask.buffer, pct: ((count / numPx) * 100).toFixed(1) });
  }

  // --- 6. Post results (transferable) ---
  const transferables = [quantized.buffer, ...layers.map(l => l.mask)];
  self.postMessage({ type: 'result', quantized: quantized.buffer, width, height, layers, palette, gen }, transferables);
};

/* ============================
 *  Preprocessing functions
 * ============================ */

function toGrayscale(px) {
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = px[i + 1] = px[i + 2] = g;
  }
}

function adjustContrast(px, value) {
  const f = (259 * (value + 255)) / (255 * (259 - value));
  for (let i = 0; i < px.length; i += 4) {
    px[i] = clamp(f * (px[i] - 128) + 128);
    px[i + 1] = clamp(f * (px[i + 1] - 128) + 128);
    px[i + 2] = clamp(f * (px[i + 2] - 128) + 128);
  }
}

function adjustBrightness(px, value) {
  const b = value * 2.55;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = clamp(px[i] + b);
    px[i + 1] = clamp(px[i + 1] + b);
    px[i + 2] = clamp(px[i + 2] + b);
  }
}

function adjustSaturation(px, value) {
  // value: -100 to 100. Boost/reduce saturation in HSL space.
  const factor = 1 + value / 100; // 0..2
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;

    if (max === min) continue; // achromatic, skip

    const d = max - min;
    let s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;

    s = Math.min(1, Math.max(0, s * factor));

    // HSL → RGB
    let nr, ng, nb;
    if (s === 0) {
      nr = ng = nb = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      nr = hue2rgb(p, q, h + 1 / 3);
      ng = hue2rgb(p, q, h);
      nb = hue2rgb(p, q, h - 1 / 3);
    }
    px[i] = clamp(nr * 255);
    px[i + 1] = clamp(ng * 255);
    px[i + 2] = clamp(nb * 255);
  }
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

/* ============================
 *  RGB ↔ CIELAB conversion
 * ============================ */

function rgb2lab(r, g, b) {
  // sRGB → linear
  let lr = r / 255, lg = g / 255, lb = b / 255;
  lr = lr > 0.04045 ? Math.pow((lr + 0.055) / 1.055, 2.4) : lr / 12.92;
  lg = lg > 0.04045 ? Math.pow((lg + 0.055) / 1.055, 2.4) : lg / 12.92;
  lb = lb > 0.04045 ? Math.pow((lb + 0.055) / 1.055, 2.4) : lb / 12.92;

  // Linear RGB → XYZ (D65)
  let x = (lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375) / 0.95047;
  let y = (lr * 0.2126729 + lg * 0.7151522 + lb * 0.0721750);
  let z = (lr * 0.0193339 + lg * 0.1191920 + lb * 0.9503041) / 1.08883;

  // XYZ → Lab
  x = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
  y = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  z = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;

  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function lab2rgb(L, a, b) {
  // Lab → XYZ
  let y = (L + 16) / 116;
  let x = a / 500 + y;
  let z = y - b / 200;

  const x3 = x * x * x, y3 = y * y * y, z3 = z * z * z;
  x = (x3 > 0.008856 ? x3 : (x - 16 / 116) / 7.787) * 0.95047;
  y = y3 > 0.008856 ? y3 : (y - 16 / 116) / 7.787;
  z = (z3 > 0.008856 ? z3 : (z - 16 / 116) / 7.787) * 1.08883;

  // XYZ → linear RGB
  let lr = x * 3.2404542 + y * -1.5371385 + z * -0.4985314;
  let lg = x * -0.9692660 + y * 1.8760108 + z * 0.0415560;
  let lb = x * 0.0556434 + y * -0.2040259 + z * 1.0572252;

  // Linear → sRGB
  lr = lr > 0.0031308 ? 1.055 * Math.pow(lr, 1 / 2.4) - 0.055 : 12.92 * lr;
  lg = lg > 0.0031308 ? 1.055 * Math.pow(lg, 1 / 2.4) - 0.055 : 12.92 * lg;
  lb = lb > 0.0031308 ? 1.055 * Math.pow(lb, 1 / 2.4) - 0.055 : 12.92 * lb;

  return [
    Math.max(0, Math.min(255, Math.round(lr * 255))),
    Math.max(0, Math.min(255, Math.round(lg * 255))),
    Math.max(0, Math.min(255, Math.round(lb * 255)))
  ];
}

/* ============================
 *  Box blur (3-pass ≈ Gaussian)
 * ============================ */

function boxBlur3Pass(px, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const channels = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  const tmp = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  for (let i = 0; i < w * h; i++) {
    channels[0][i] = px[i * 4];
    channels[1][i] = px[i * 4 + 1];
    channels[2][i] = px[i * 4 + 2];
  }
  for (let c = 0; c < 3; c++) {
    boxBlurH(channels[c], tmp[c], w, h, r);
    boxBlurV(tmp[c], channels[c], w, h, r);
    boxBlurH(channels[c], tmp[c], w, h, r);
    boxBlurV(tmp[c], channels[c], w, h, r);
    boxBlurH(channels[c], tmp[c], w, h, r);
    boxBlurV(tmp[c], channels[c], w, h, r);
  }
  const out = new Uint8ClampedArray(px.length);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = clamp(channels[0][i]);
    out[i * 4 + 1] = clamp(channels[1][i]);
    out[i * 4 + 2] = clamp(channels[2][i]);
    out[i * 4 + 3] = 255;
  }
  return out;
}

function boxBlurH(src, dst, w, h, r) {
  const d = r + r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = src[row] * (r + 1);
    for (let j = 0; j < r; j++) sum += src[row + Math.min(j, w - 1)];
    for (let x = 0; x < w; x++) {
      sum += src[row + Math.min(x + r, w - 1)];
      sum -= src[row + Math.max(x - r - 1, 0)];
      dst[row + x] = sum / d;
    }
  }
}

function boxBlurV(src, dst, w, h, r) {
  const d = r + r + 1;
  for (let x = 0; x < w; x++) {
    let sum = src[x] * (r + 1);
    for (let j = 0; j < r; j++) sum += src[Math.min(j, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      sum += src[Math.min(y + r, h - 1) * w + x];
      sum -= src[Math.max(y - r - 1, 0) * w + x];
      dst[y * w + x] = sum / d;
    }
  }
}

/* ============================
 *  K-means quantization in CIELAB
 * ============================ */

function kmeansQuantizeLab(px, w, h, k, maxIter) {
  maxIter = maxIter || 20;
  const numPx = w * h;

  // --- Convert ALL pixels to Lab (needed for final assignment) ---
  const allL = new Float32Array(numPx);
  const allA = new Float32Array(numPx);
  const allB = new Float32Array(numPx);
  for (let i = 0; i < numPx; i++) {
    const lab = rgb2lab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    allL[i] = lab[0]; allA[i] = lab[1]; allB[i] = lab[2];
  }

  // --- Subsample for speed (up to 20 000 pixels) ---
  const sampleSize = Math.min(numPx, 20000);
  const step = Math.max(1, Math.floor(numPx / sampleSize));
  const sIdx = [];
  for (let i = 0; i < numPx; i += step) sIdx.push(i);
  const sLen = sIdx.length;

  // Extract sample Lab values
  const sL = new Float32Array(sLen);
  const sA = new Float32Array(sLen);
  const sB = new Float32Array(sLen);
  for (let i = 0; i < sLen; i++) {
    sL[i] = allL[sIdx[i]]; sA[i] = allA[sIdx[i]]; sB[i] = allB[sIdx[i]];
  }

  // --- K-means++ init in Lab space ---
  const cL = new Float32Array(k);
  const cA = new Float32Array(k);
  const cB = new Float32Array(k);

  let first = Math.floor(Math.random() * sLen);
  cL[0] = sL[first]; cA[0] = sA[first]; cB[0] = sB[first];

  const dist = new Float32Array(sLen);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < sLen; i++) {
      let minD = Infinity;
      for (let j = 0; j < c; j++) {
        const dL = sL[i] - cL[j], dA = sA[i] - cA[j], dB = sB[i] - cB[j];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < minD) minD = d;
      }
      dist[i] = minD;
      total += minD;
    }
    let target = Math.random() * total;
    for (let i = 0; i < sLen; i++) {
      target -= dist[i];
      if (target <= 0) { cL[c] = sL[i]; cA[c] = sA[i]; cB[c] = sB[i]; break; }
    }
  }

  // --- Iterate on samples ---
  const sAssign = new Uint8Array(sLen);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < sLen; i++) {
      let minD = Infinity, best = 0;
      for (let j = 0; j < k; j++) {
        const dL = sL[i] - cL[j], dA = sA[i] - cA[j], dB = sB[i] - cB[j];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < minD) { minD = d; best = j; }
      }
      if (sAssign[i] !== best) { sAssign[i] = best; changed = true; }
    }
    if (!changed) break;

    // Update centroids in Lab space
    const sumL = new Float64Array(k), sumA = new Float64Array(k), sumB = new Float64Array(k);
    const cnt = new Uint32Array(k);
    for (let i = 0; i < sLen; i++) {
      const a = sAssign[i];
      sumL[a] += sL[i]; sumA[a] += sA[i]; sumB[a] += sB[i]; cnt[a]++;
    }
    for (let j = 0; j < k; j++) {
      if (cnt[j] > 0) { cL[j] = sumL[j] / cnt[j]; cA[j] = sumA[j] / cnt[j]; cB[j] = sumB[j] / cnt[j]; }
    }
  }

  // --- Assign ALL pixels in Lab space ---
  const assignments = new Uint8Array(numPx);
  for (let i = 0; i < numPx; i++) {
    const pL = allL[i], pA = allA[i], pB = allB[i];
    let minD = Infinity, best = 0;
    for (let j = 0; j < k; j++) {
      const dL = pL - cL[j], dA = pA - cA[j], dB = pB - cB[j];
      const d = dL * dL + dA * dA + dB * dB;
      if (d < minD) { minD = d; best = j; }
    }
    assignments[i] = best;
  }

  // --- Convert centroids back to RGB ---
  const palRGB = [];
  for (let j = 0; j < k; j++) {
    palRGB.push({ idx: j, rgb: lab2rgb(cL[j], cA[j], cB[j]), lum: cL[j] });
  }

  // Sort palette by luminance (dark → light)
  palRGB.sort((a, b) => a.lum - b.lum);
  const remap = new Uint8Array(k);
  palRGB.forEach((p, i) => { remap[p.idx] = i; });
  for (let i = 0; i < numPx; i++) assignments[i] = remap[assignments[i]];

  const palette = palRGB.map(p => p.rgb);
  return { assignments, palette };
}

/* ============================
 *  Floyd-Steinberg dithering
 * ============================ */

function floydSteinberg(px, w, h, palette, assignments) {
  const numPx = w * h;
  const errR = new Float32Array(numPx);
  const errG = new Float32Array(numPx);
  const errB = new Float32Array(numPx);
  for (let i = 0; i < numPx; i++) {
    errR[i] = px[i * 4];
    errG[i] = px[i * 4 + 1];
    errB[i] = px[i * 4 + 2];
  }

  // Pre-convert palette to Lab for perceptual nearest-neighbor
  const palLab = palette.map(c => rgb2lab(c[0], c[1], c[2]));
  const k = palette.length;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const or = errR[i], og = errG[i], ob = errB[i];

      // Find nearest palette color in Lab space
      const pLab = rgb2lab(clamp(or), clamp(og), clamp(ob));
      let minD = Infinity, best = 0;
      for (let j = 0; j < k; j++) {
        const dL = pLab[0] - palLab[j][0], dA = pLab[1] - palLab[j][1], dB = pLab[2] - palLab[j][2];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < minD) { minD = d; best = j; }
      }
      assignments[i] = best;

      // Error diffusion in RGB (standard FS)
      const er = or - palette[best][0];
      const eg = og - palette[best][1];
      const eb = ob - palette[best][2];

      if (x + 1 < w) {
        const n = i + 1;
        errR[n] += er * 7 / 16; errG[n] += eg * 7 / 16; errB[n] += eb * 7 / 16;
      }
      if (y + 1 < h) {
        if (x > 0) {
          const n = i + w - 1;
          errR[n] += er * 3 / 16; errG[n] += eg * 3 / 16; errB[n] += eb * 3 / 16;
        }
        {
          const n = i + w;
          errR[n] += er * 5 / 16; errG[n] += eg * 5 / 16; errB[n] += eb * 5 / 16;
        }
        if (x + 1 < w) {
          const n = i + w + 1;
          errR[n] += er * 1 / 16; errG[n] += eg * 1 / 16; errB[n] += eb * 1 / 16;
        }
      }
    }
  }
}
