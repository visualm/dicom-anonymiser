// Canvas image viewer with box drawing (left drag) and window/level (right drag).
(function () {
  'use strict';
  const DA = (window.DA = window.DA || {});

  class Viewer {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.opts = Object.assign({ draw: false, onBox: null, onWindow: null, onWheel: null }, opts || {});
      this.img = null; // offscreen canvas
      this.boxes = []; // [{x,y,w,h,highlight}]
      this.draft = null;
      this.scale = 1; this.ox = 0; this.oy = 0;
      this.ro = new ResizeObserver(() => this.draw());
      this.ro.observe(canvas);
      this.bind();
    }
    destroy() { this.ro.disconnect(); }

    setImage(rgba, w, h) {
      if (!this.img || this.img.width !== w || this.img.height !== h) {
        this.img = document.createElement('canvas');
        this.img.width = w; this.img.height = h;
      }
      this.img.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
      this.draw();
    }
    clear() { this.img = null; this.draw(); }

    layout() {
      const c = this.canvas;
      const dpr = window.devicePixelRatio || 1;
      const cw = Math.max(1, Math.round(c.clientWidth * dpr));
      const ch = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
      if (!this.img) return;
      this.scale = Math.min(cw / this.img.width, ch / this.img.height);
      this.ox = (cw - this.img.width * this.scale) / 2;
      this.oy = (ch - this.img.height * this.scale) / 2;
    }

    draw() {
      this.layout();
      const c = this.canvas;
      const g = c.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#0d1117';
      g.fillRect(0, 0, c.width, c.height);
      if (!this.img) return;
      g.imageSmoothingEnabled = this.scale < 1;
      g.drawImage(this.img, this.ox, this.oy, this.img.width * this.scale, this.img.height * this.scale);
      const all = this.draft ? this.boxes.concat([Object.assign({ draft: true }, this.draft)]) : this.boxes;
      for (const b of all) {
        const x = this.ox + Math.min(b.x, b.x + b.w) * this.scale;
        const y = this.oy + Math.min(b.y, b.y + b.h) * this.scale;
        const w = Math.abs(b.w) * this.scale;
        const h = Math.abs(b.h) * this.scale;
        if (b.preview !== false) { g.fillStyle = 'rgba(0,0,0,0.78)'; g.fillRect(x, y, w, h); }
        g.lineWidth = Math.max(1.5, (window.devicePixelRatio || 1) * 1.5);
        g.strokeStyle = b.draft ? '#ffd54f' : b.highlight ? '#ff5252' : '#ff8a80';
        g.setLineDash(b.draft ? [6, 4] : []);
        g.strokeRect(x, y, w, h);
        if (b.label) {
          g.fillStyle = '#ff8a80';
          g.font = Math.round(11 * (window.devicePixelRatio || 1)) + 'px Segoe UI, sans-serif';
          g.fillText(b.label, x + 3, y - 4 > 10 ? y - 4 : y + 12);
        }
      }
      g.setLineDash([]);
    }

    toImage(ev) {
      const r = this.canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const px = (ev.clientX - r.left) * dpr;
      const py = (ev.clientY - r.top) * dpr;
      return { x: (px - this.ox) / this.scale, y: (py - this.oy) / this.scale };
    }

    bind() {
      const c = this.canvas;
      let mode = null;
      let start = null;
      let last = null;
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('pointerdown', (e) => {
        if (!this.img) return;
        c.setPointerCapture(e.pointerId);
        last = { x: e.clientX, y: e.clientY };
        if (e.button === 2 || (e.button === 0 && e.shiftKey)) { mode = 'wl'; return; }
        if (e.button === 0 && this.opts.draw) {
          mode = 'box';
          start = this.toImage(e);
          this.draft = { x: start.x, y: start.y, w: 0, h: 0 };
        }
      });
      c.addEventListener('pointermove', (e) => {
        if (mode === 'box') {
          const p = this.toImage(e);
          this.draft = { x: start.x, y: start.y, w: p.x - start.x, h: p.y - start.y };
          this.draw();
        } else if (mode === 'wl' && this.opts.onWindow) {
          this.opts.onWindow(e.clientX - last.x, e.clientY - last.y);
          last = { x: e.clientX, y: e.clientY };
        }
      });
      const end = () => {
        if (mode === 'box' && this.draft) {
          const d = this.draft;
          this.draft = null;
          // Normalise and clip to the image.
          let x0 = Math.max(0, Math.min(d.x, d.x + d.w));
          let y0 = Math.max(0, Math.min(d.y, d.y + d.h));
          const x1 = Math.min(this.img.width, Math.max(d.x, d.x + d.w));
          const y1 = Math.min(this.img.height, Math.max(d.y, d.y + d.h));
          x0 = Math.floor(x0); y0 = Math.floor(y0);
          const box = { x: x0, y: y0, w: Math.ceil(x1) - x0, h: Math.ceil(y1) - y0 };
          if (box.w >= 2 && box.h >= 2 && this.opts.onBox) this.opts.onBox(box);
          this.draw();
        }
        mode = null;
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('wheel', (e) => {
        if (!this.opts.onWheel) return;
        e.preventDefault();
        this.opts.onWheel(e.deltaY > 0 ? 1 : -1);
      }, { passive: false });
    }
  }

  DA.Viewer = Viewer;
})();
