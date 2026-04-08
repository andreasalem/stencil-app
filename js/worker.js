/*  Stencil Maker — Processing Worker
 *  Runs off the main thread: preprocess → quantize → dither → extract layers
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
  if (params.blur > 0) data = boxBlur3Pass(data, width, height, params.blur);

  // --- 2. Quantize (k-means on subsampled pixels) ---
  const { assignments, palette } = kmeansQuantize(data, width, height, params.n);

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

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

/* ============================
 *  Box blur (3-pass ≈ Gaussian)
 * ============================ */

function boxBlur3Pass(px, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  // Work on separate channels
  const channels = [
    new Float32Array(w * h),
    new Float32Array(w * h),
    new Float32Array(w * h)
  ];
  const tmp = [
    new Float32Array(w * h),
    new Float32Array(w * h),
    new Float32Array(w * h)
  ];
  // Extract channels
  for (let i = 0; i < w * h; i++) {
    channels[0][i] = px[i * 4];
    channels[1][i] = px[i * 4 + 1];
    channels[2][i] = px[i * 4 + 2];
  }
  // 3 passes per channel
  for (let c = 0; c < 3; c++) {
    boxBlurH(channels[c], tmp[c], w, h, r);
    boxBlurV(tmp[c], channels[c], w, h, r);
    boxBlurH(channels[c], tmp[c], w, h, r);
    boxBlurV(tmp[c], channels[c], w, h, r);
    boxBlurH(channels[c], tmp[c], w, h, r);
    boxBlurV(tmp[c], channels[c], w, h, r);
  }
  // Reassemble
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
 *  K-means color quantization
 * ============================ */

function kmeansQuantize(px, w, h, k, maxIter) {
  maxIter = maxIter || 20;
  const numPx = w * h;

  // Subsample for speed (up to 15 000 pixels)
  const sampleSize = Math.min(numPx, 15000);
  const step = Math.max(1, Math.floor(numPx / sampleSize));
  const sIdx = [];
  for (let i = 0; i < numPx; i += step) sIdx.push(i);

  // Extract sample RGB
  const sLen = sIdx.length;
  const sR = new Float32Array(sLen);
  const sG = new Float32Array(sLen);
  const sB = new Float32Array(sLen);
  for (let i = 0; i < sLen; i++) {
    const p = sIdx[i] * 4;
    sR[i] = px[p]; sG[i] = px[p + 1]; sB[i] = px[p + 2];
  }

  // K-means++ init
  const cR = new Float32Array(k);
  const cG = new Float32Array(k);
  const cB = new Float32Array(k);

  let first = Math.floor(Math.random() * sLen);
  cR[0] = sR[first]; cG[0] = sG[first]; cB[0] = sB[first];

  const dist = new Float32Array(sLen);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < sLen; i++) {
      let minD = Infinity;
      for (let j = 0; j < c; j++) {
        const dr = sR[i] - cR[j], dg = sG[i] - cG[j], db = sB[i] - cB[j];
        const d = dr * dr + dg * dg + db * db;
        if (d < minD) minD = d;
      }
      dist[i] = minD;
      total += minD;
    }
    let target = Math.random() * total;
    for (let i = 0; i < sLen; i++) {
      target -= dist[i];
      if (target <= 0) { cR[c] = sR[i]; cG[c] = sG[i]; cB[c] = sB[i]; break; }
    }
  }

  // Iterate on samples
  const sAssign = new Uint8Array(sLen);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < sLen; i++) {
      let minD = Infinity, best = 0;
      for (let j = 0; j < k; j++) {
        const dr = sR[i] - cR[j], dg = sG[i] - cG[j], db = sB[i] - cB[j];
        const d = dr * dr + dg * dg + db * db;
        if (d < minD) { minD = d; best = j; }
      }
      if (sAssign[i] !== best) { sAssign[i] = best; changed = true; }
    }
    if (!changed) break;

    // Update centroids
    const sumR = new Float64Array(k), sumG = new Float64Array(k), sumB = new Float64Array(k);
    const cnt = new Uint32Array(k);
    for (let i = 0; i < sLen; i++) {
      const a = sAssign[i];
      sumR[a] += sR[i]; sumG[a] += sG[i]; sumB[a] += sB[i]; cnt[a]++;
    }
    for (let j = 0; j < k; j++) {
      if (cnt[j] > 0) { cR[j] = sumR[j] / cnt[j]; cG[j] = sumG[j] / cnt[j]; cB[j] = sumB[j] / cnt[j]; }
    }
  }

  // Assign ALL pixels
  const assignments = new Uint8Array(numPx);
  for (let i = 0; i < numPx; i++) {
    const p = i * 4;
    const r = px[p], g = px[p + 1], b = px[p + 2];
    let minD = Infinity, best = 0;
    for (let j = 0; j < k; j++) {
      const dr = r - cR[j], dg = g - cG[j], db = b - cB[j];
      const d = dr * dr + dg * dg + db * db;
      if (d < minD) { minD = d; best = j; }
    }
    assignments[i] = best;
  }

  // Sort palette by luminance (dark → light)
  const pal = [];
  for (let j = 0; j < k; j++) {
    pal.push({ idx: j, r: Math.round(cR[j]), g: Math.round(cG[j]), b: Math.round(cB[j]),
      lum: 0.299 * cR[j] + 0.587 * cG[j] + 0.114 * cB[j] });
  }
  pal.sort((a, b) => a.lum - b.lum);

  const remap = new Uint8Array(k);
  pal.forEach((p, i) => { remap[p.idx] = i; });
  for (let i = 0; i < numPx; i++) assignments[i] = remap[assignments[i]];

  const palette = pal.map(p => [p.r, p.g, p.b]);
  return { assignments, palette };
}

/* ============================
 *  Floyd-Steinberg dithering
 * ============================ */

function floydSteinberg(px, w, h, palette, assignments) {
  // Work on a float copy of preprocessed pixel data
  const numPx = w * h;
  const errR = new Float32Array(numPx);
  const errG = new Float32Array(numPx);
  const errB = new Float32Array(numPx);
  for (let i = 0; i < numPx; i++) {
    errR[i] = px[i * 4];
    errG[i] = px[i * 4 + 1];
    errB[i] = px[i * 4 + 2];
  }

  const k = palette.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const or = errR[i], og = errG[i], ob = errB[i];

      // Find nearest palette color
      let minD = Infinity, best = 0;
      for (let j = 0; j < k; j++) {
        const dr = or - palette[j][0], dg = og - palette[j][1], db = ob - palette[j][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < minD) { minD = d; best = j; }
      }
      assignments[i] = best;

      // Error
      const er = or - palette[best][0];
      const eg = og - palette[best][1];
      const eb = ob - palette[best][2];

      // Distribute error
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
