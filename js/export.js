/*  Stencil Maker — Export utilities
 *  PNG per-layer download + ZIP bundle
 */

/**
 * Download a single layer mask as PNG.
 * Renders mask as black shapes on white background.
 */
export function downloadLayerPNG(mask, width, height, color, index) {
  const canvas = layerToCanvas(mask, width, height);
  const name = `layer-${String(index + 1).padStart(2, '0')}-${rgbHex(color)}.png`;
  canvasToDownload(canvas, name);
}

/**
 * Download all layers as a ZIP file.
 */
export async function downloadAllZIP(layers, width, height) {
  if (typeof JSZip === 'undefined') {
    alert('JSZip not loaded. Please check your internet connection.');
    return;
  }
  const zip = new JSZip();
  const folder = zip.folder('stencil-layers');

  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    const canvas = layerToCanvas(l.mask, width, height);
    const blob = await canvasToBlob(canvas);
    const name = `layer-${String(i + 1).padStart(2, '0')}-${rgbHex(l.color)}.png`;
    folder.file(name, blob);
  }

  // Also add the composite preview
  const composite = compositeToCanvas(layers, width, height);
  const compBlob = await canvasToBlob(composite);
  folder.file('00-composite.png', compBlob);

  const content = await zip.generateAsync({ type: 'blob' });
  downloadBlob(content, 'stencil-layers.zip');
}

/**
 * Download all layers as a multi-page PDF.
 * Simple implementation: one layer mask per page, letter size.
 */
export async function downloadPDF(layers, width, height) {
  // Use canvas-to-image approach, no external PDF library needed
  // Create a printable HTML that opens in a new tab
  const pages = [];

  for (let i = 0; i < layers.length; i++) {
    const l = layers[i];
    const canvas = layerToCanvas(l.mask, width, height);
    const dataUrl = canvas.toDataURL('image/png');
    pages.push({ dataUrl, color: rgbHex(l.color), index: i + 1, pct: l.pct });
  }

  // Add composite
  const composite = compositeToCanvas(layers, width, height);
  const compDataUrl = composite.toDataURL('image/png');

  const html = `<!DOCTYPE html>
<html><head><title>Stencil Layers</title>
<style>
  @media print { .page-break { page-break-after: always; } }
  body { margin: 0; font-family: sans-serif; }
  .page { text-align: center; padding: 20px; }
  .page img { max-width: 90vw; max-height: 80vh; border: 1px solid #ccc; }
  h2 { margin: 10px 0 6px; font-size: 16px; }
  .meta { font-size: 12px; color: #666; margin-bottom: 10px; }
  .swatch { display: inline-block; width: 16px; height: 16px; border: 1px solid #999; vertical-align: middle; margin-right: 6px; border-radius: 3px; }
</style></head><body>
<div class="page">
  <h2>Composite Preview</h2>
  <img src="${compDataUrl}">
</div>
<div class="page-break"></div>
${pages.map((p, i) => `
<div class="page">
  <h2><span class="swatch" style="background:#${p.color}"></span>Layer ${p.index} — #${p.color} (${p.pct}%)</h2>
  <p class="meta">Black = stencil material (keep) &nbsp;|&nbsp; White = cut out (paint goes through)</p>
  <img src="${p.dataUrl}">
</div>
${i < pages.length - 1 ? '<div class="page-break"></div>' : ''}
`).join('')}
<script>window.onload = () => window.print();</script>
</body></html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* === Helpers === */

/** Render a binary mask onto a canvas: black shapes on white bg */
function layerToCanvas(mask, width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(width, height);
  const d = img.data;
  for (let i = 0; i < mask.length; i++) {
    // mask 255 = this layer → paint goes through → WHITE (cut out)
    // mask 0   = not this layer → stencil material → BLACK (keep)
    const v = mask[i] === 255 ? 255 : 0;
    d[i * 4] = v;
    d[i * 4 + 1] = v;
    d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** Render composite (all layers overlaid) */
function compositeToCanvas(layers, width, height) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(width, height);
  const d = img.data;
  // Start with white
  for (let i = 0; i < width * height; i++) {
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
    d[i * 4 + 3] = 255;
  }
  // Paint each layer darkest first (layers already sorted dark→light)
  for (const l of layers) {
    for (let i = 0; i < l.mask.length; i++) {
      if (l.mask[i] === 255) {
        d[i * 4] = l.color[0];
        d[i * 4 + 1] = l.color[1];
        d[i * 4 + 2] = l.color[2];
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function canvasToBlob(canvas) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

function canvasToDownload(canvas, filename) {
  canvas.toBlob(blob => downloadBlob(blob, filename), 'image/png');
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function rgbHex(color) {
  return color.map(c => c.toString(16).padStart(2, '0')).join('');
}
