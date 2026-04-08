/*  Stencil Maker — Main thread
 *  Handles UI, drag/drop, worker communication, rendering
 */

import { downloadLayerPNG, downloadAllZIP, downloadPDF } from './export.js';

/* ============================
 *  State
 * ============================ */

let originalImageData = null;   // raw ImageData from loaded image
let quantizedImageData = null;  // ImageData after quantization
let layerData = [];             // [{ color, mask (Uint8Array), pct }]
let imgWidth = 0;
let imgHeight = 0;
let worker = null;
let processing = false;
let activeTab = 'original';
let generation = 0; // track latest request to ignore stale results

const MAX_DIM = 2000; // cap image size for performance

const params = {
  n: 4,
  contrast: 0,
  brightness: 0,
  blur: 0,
  grayscale: false,
  dither: false,
};

/* ============================
 *  DOM refs
 * ============================ */

const $ = (s) => document.querySelector(s);
const dropzone = $('#dropzone');
const fileInput = $('#file-input');
const app = $('#app');
const previewCanvas = $('#preview-canvas');
const ctx = previewCanvas.getContext('2d');
const processingEl = $('#processing');
const layersGrid = $('#layers-grid');
const layerCount = $('#layer-count');
const exportAllBtn = $('#export-all-btn');
const exportPdfBtn = $('#export-pdf-btn');
const newImageBtn = $('#new-image-btn');

/* ============================
 *  Init
 * ============================ */

function init() {
  worker = new Worker('js/worker.js');
  worker.onmessage = handleWorkerResult;
  initDropzone();
  initControls();
  initTabs();
  initButtons();
}

/* ============================
 *  Dropzone
 * ============================ */

function initDropzone() {
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) loadImage(file);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadImage(fileInput.files[0]);
  });

  // Also support paste
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        loadImage(item.getAsFile());
        break;
      }
    }
  });
}

/* ============================
 *  Load image
 * ============================ */

function loadImage(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > MAX_DIM || h > MAX_DIM) {
        const scale = MAX_DIM / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      // Draw to offscreen canvas
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const offCtx = off.getContext('2d');
      offCtx.drawImage(img, 0, 0, w, h);
      originalImageData = offCtx.getImageData(0, 0, w, h);
      imgWidth = w;
      imgHeight = h;

      // Switch from dropzone to app
      dropzone.classList.add('hidden');
      app.classList.remove('hidden');

      // Set canvas size
      previewCanvas.width = w;
      previewCanvas.height = h;

      // Show original first
      activeTab = 'original';
      updateTabs();
      renderOriginal();

      // Kick off first processing
      processImage();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* ============================
 *  Controls
 * ============================ */

function initControls() {
  const sliders = [
    { id: 'n-slider', param: 'n', display: 'n-value', parse: parseInt },
    { id: 'contrast-slider', param: 'contrast', display: 'contrast-value', parse: parseInt },
    { id: 'brightness-slider', param: 'brightness', display: 'brightness-value', parse: parseInt },
    { id: 'blur-slider', param: 'blur', display: 'blur-value', parse: parseFloat },
  ];

  const debouncedProcess = debounce(processImage, 150);

  for (const s of sliders) {
    const el = $(`#${s.id}`);
    const disp = $(`#${s.display}`);
    el.addEventListener('input', () => {
      const v = s.parse(el.value);
      disp.textContent = el.value;
      params[s.param] = v;
      debouncedProcess();
    });
  }

  $('#grayscale-toggle').addEventListener('change', (e) => {
    params.grayscale = e.target.checked;
    debouncedProcess();
  });
  $('#dither-toggle').addEventListener('change', (e) => {
    params.dither = e.target.checked;
    debouncedProcess();
  });
}

/* ============================
 *  Tabs
 * ============================ */

function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      updateTabs();
      render();
    });
  });
}

function updateTabs() {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === activeTab);
  });
}

/* ============================
 *  Buttons
 * ============================ */

function initButtons() {
  exportAllBtn.addEventListener('click', () => {
    if (layerData.length > 0) downloadAllZIP(layerData, imgWidth, imgHeight);
  });
  exportPdfBtn.addEventListener('click', () => {
    if (layerData.length > 0) downloadPDF(layerData, imgWidth, imgHeight);
  });
  newImageBtn.addEventListener('click', () => {
    // Reset state
    originalImageData = null;
    quantizedImageData = null;
    layerData = [];
    layersGrid.innerHTML = '';
    layerCount.textContent = '';
    exportAllBtn.disabled = true;
    exportPdfBtn.disabled = true;
    app.classList.add('hidden');
    dropzone.classList.remove('hidden');
    fileInput.value = '';
  });
}

/* ============================
 *  Worker communication
 * ============================ */

function processImage() {
  if (!originalImageData) return;
  processing = true;
  generation++;
  processingEl.classList.remove('hidden');

  // Copy pixel data (will be transferred to worker — zero-copy)
  const pixelsCopy = new Uint8ClampedArray(originalImageData.data);
  worker.postMessage(
    { type: 'process', pixels: pixelsCopy, width: imgWidth, height: imgHeight, params, gen: generation },
    [pixelsCopy.buffer]
  );
}

function handleWorkerResult(e) {
  if (e.data.type !== 'result') return;
  // Ignore stale results from previous parameter changes
  if (e.data.gen !== generation) return;
  processing = false;
  processingEl.classList.add('hidden');

  const { quantized, width, height, layers, palette } = e.data;

  // Rebuild ImageData
  quantizedImageData = new ImageData(new Uint8ClampedArray(quantized), width, height);

  // Rebuild layer data with proper typed arrays
  layerData = layers.map(l => ({
    color: l.color,
    mask: new Uint8Array(l.mask),
    pct: l.pct,
  }));

  // Enable export buttons
  exportAllBtn.disabled = false;
  exportPdfBtn.disabled = false;

  // Auto-switch to stencil preview on first result
  activeTab = 'quantized';
  updateTabs();
  renderQuantized();
  renderLayers();
}

/* ============================
 *  Rendering
 * ============================ */

function render() {
  if (activeTab === 'original') renderOriginal();
  else if (activeTab === 'quantized') renderQuantized();
}

function renderOriginal() {
  if (!originalImageData) return;
  previewCanvas.width = imgWidth;
  previewCanvas.height = imgHeight;
  ctx.putImageData(originalImageData, 0, 0);
}

function renderQuantized() {
  if (!quantizedImageData) return;
  previewCanvas.width = imgWidth;
  previewCanvas.height = imgHeight;
  ctx.putImageData(quantizedImageData, 0, 0);
}

function renderLayers() {
  layersGrid.innerHTML = '';
  layerCount.textContent = `(${layerData.length} colors)`;

  for (let i = 0; i < layerData.length; i++) {
    const l = layerData[i];
    const card = document.createElement('div');
    card.className = 'layer-card';

    // Thumbnail canvas: show mask in palette color on white
    const thumb = document.createElement('canvas');
    thumb.width = imgWidth;
    thumb.height = imgHeight;
    const tCtx = thumb.getContext('2d');
    const tImg = tCtx.createImageData(imgWidth, imgHeight);
    const td = tImg.data;
    for (let p = 0; p < l.mask.length; p++) {
      if (l.mask[p] === 255) {
        td[p * 4] = l.color[0];
        td[p * 4 + 1] = l.color[1];
        td[p * 4 + 2] = l.color[2];
      } else {
        td[p * 4] = 245;
        td[p * 4 + 1] = 245;
        td[p * 4 + 2] = 245;
      }
      td[p * 4 + 3] = 255;
    }
    tCtx.putImageData(tImg, 0, 0);

    // Info bar
    const hex = l.color.map(c => c.toString(16).padStart(2, '0')).join('');
    const info = document.createElement('div');
    info.className = 'layer-info';
    info.innerHTML = `
      <div class="color-swatch" style="background:#${hex}"></div>
      <div class="layer-label">
        <div class="name">Layer ${i + 1}</div>
        <div class="meta">#${hex} · ${l.pct}%</div>
      </div>
      <button class="layer-dl" title="Download PNG" data-index="${i}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
      </button>`;

    // Click to highlight on preview
    card.addEventListener('click', (e) => {
      if (e.target.closest('.layer-dl')) return; // don't trigger on download button
      // Switch to stencil preview and highlight this layer
      activeTab = 'quantized';
      updateTabs();
      // Render with this layer highlighted
      renderLayerHighlight(i);
    });

    // Download button
    info.querySelector('.layer-dl').addEventListener('click', (e) => {
      e.stopPropagation();
      downloadLayerPNG(l.mask, imgWidth, imgHeight, l.color, i);
    });

    card.appendChild(thumb);
    card.appendChild(info);
    layersGrid.appendChild(card);
  }
}

/** Render preview with one layer's pixels in color, rest dimmed */
function renderLayerHighlight(layerIndex) {
  if (!quantizedImageData) return;
  previewCanvas.width = imgWidth;
  previewCanvas.height = imgHeight;
  const img = ctx.createImageData(imgWidth, imgHeight);
  const d = img.data;
  const target = layerData[layerIndex];

  for (let i = 0; i < imgWidth * imgHeight; i++) {
    if (target.mask[i] === 255) {
      // Show in full color
      d[i * 4] = target.color[0];
      d[i * 4 + 1] = target.color[1];
      d[i * 4 + 2] = target.color[2];
    } else {
      // Dim the rest
      const src = quantizedImageData.data;
      d[i * 4] = Math.round(src[i * 4] * 0.2 + 40);
      d[i * 4 + 1] = Math.round(src[i * 4 + 1] * 0.2 + 40);
      d[i * 4 + 2] = Math.round(src[i * 4 + 2] * 0.2 + 40);
    }
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/* ============================
 *  Utilities
 * ============================ */

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/* ============================
 *  Boot
 * ============================ */

init();
