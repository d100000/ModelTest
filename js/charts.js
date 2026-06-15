/**
 * 极简 Canvas 图表 - 无外部依赖
 * 支持: 直方图(histogram)、散点图(scatter)
 */
const Charts = {

  _theme: {
    bg: '#161b26',
    grid: '#2a3142',
    text: '#8a92a6',
    bar: '#5b8def',
    bar2: '#a78bfa',
    dot: '#67e8f9'
  },

  _clear(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = this._theme.bg;
    ctx.fillRect(0, 0, w, h);
  },

  /**
   * 自适应 canvas 像素比，避免模糊
   */
  _setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = parseInt(canvas.getAttribute('height') || 280);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w, h };
  },

  /**
   * 直方图
   * @param {Array<number>} values
   * @param {Object} opts { bins, xLabel, yLabel, color }
   */
  histogram(canvas, values, opts = {}) {
    const { ctx, w, h } = this._setupCanvas(canvas);
    this._clear(ctx, w, h);

    if (!values || !values.length) {
      this._drawEmpty(ctx, w, h);
      return;
    }

    const bins = opts.bins || 10;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = Math.max(1, max - min);
    const binSize = span / bins;
    const buckets = new Array(bins).fill(0);
    for (const v of values) {
      const idx = Math.min(bins - 1, Math.floor((v - min) / binSize));
      buckets[idx]++;
    }
    const maxCount = Math.max(...buckets);

    const padding = { left: 50, right: 16, top: 16, bottom: 36 };
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;

    // 坐标轴
    ctx.strokeStyle = this._theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + plotH);
    ctx.lineTo(padding.left + plotW, padding.top + plotH);
    ctx.stroke();

    // 横向网格
    ctx.fillStyle = this._theme.text;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = 4;
    for (let i = 0; i <= yTicks; i++) {
      const y = padding.top + plotH - (plotH * i / yTicks);
      ctx.strokeStyle = this._theme.grid;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotW, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText(Math.round(maxCount * i / yTicks), padding.left - 6, y);
    }

    // 柱
    const barW = plotW / bins * 0.85;
    const gap = (plotW / bins) - barW;
    for (let i = 0; i < bins; i++) {
      const v = buckets[i];
      const barH = maxCount ? (v / maxCount) * plotH : 0;
      const x = padding.left + i * (plotW / bins) + gap / 2;
      const y = padding.top + plotH - barH;
      const grad = ctx.createLinearGradient(x, y, x, y + barH);
      grad.addColorStop(0, opts.color || this._theme.bar);
      grad.addColorStop(1, this._theme.bar2);
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, barW, barH);
      if (v > 0) {
        ctx.fillStyle = this._theme.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(v, x + barW / 2, y - 2);
      }
    }

    // X 轴刻度
    ctx.fillStyle = this._theme.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = Math.min(bins, 6);
    for (let i = 0; i <= xTicks; i++) {
      const v = min + (span * i / xTicks);
      const x = padding.left + (plotW * i / xTicks);
      ctx.fillText(this._fmtNum(v), x, padding.top + plotH + 4);
    }

    if (opts.xLabel) {
      ctx.textAlign = 'center';
      ctx.fillText(opts.xLabel, padding.left + plotW / 2, h - 6);
    }
  },

  /**
   * 散点 / 时间线
   * @param {Array<{x:number,y:number,label?:string,color?:string}>} points
   */
  scatter(canvas, points, opts = {}) {
    const { ctx, w, h } = this._setupCanvas(canvas);
    this._clear(ctx, w, h);

    if (!points || !points.length) {
      this._drawEmpty(ctx, w, h);
      return;
    }

    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = 0;
    const yMax = Math.max(...ys) * 1.1 || 1;
    const xSpan = Math.max(1, xMax - xMin);
    const ySpan = Math.max(1, yMax - yMin);

    const padding = { left: 56, right: 16, top: 16, bottom: 36 };
    const plotW = w - padding.left - padding.right;
    const plotH = h - padding.top - padding.bottom;

    // 坐标轴
    ctx.strokeStyle = this._theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + plotH);
    ctx.lineTo(padding.left + plotW, padding.top + plotH);
    ctx.stroke();

    // 网格 + Y 刻度
    ctx.fillStyle = this._theme.text;
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const y = padding.top + plotH - (plotH * i / yTicks);
      ctx.strokeStyle = this._theme.grid;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotW, y);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const v = yMin + (ySpan * i / yTicks);
      ctx.fillText(this._fmtNum(v) + (opts.yUnit || ''), padding.left - 6, y);
    }

    // X 刻度
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = Math.min(8, points.length);
    for (let i = 0; i <= xTicks; i++) {
      const t = i / xTicks;
      const x = padding.left + plotW * t;
      const v = xMin + xSpan * t;
      const label = opts.xFormat ? opts.xFormat(v) : this._fmtNum(v);
      ctx.fillText(label, x, padding.top + plotH + 4);
    }

    // 点
    for (const p of points) {
      const x = padding.left + ((p.x - xMin) / xSpan) * plotW;
      const y = padding.top + plotH - ((p.y - yMin) / ySpan) * plotH;
      ctx.fillStyle = p.color || this._theme.dot;
      ctx.beginPath();
      ctx.arc(x, y, p.size || 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (opts.xLabel) {
      ctx.textAlign = 'center';
      ctx.fillStyle = this._theme.text;
      ctx.fillText(opts.xLabel, padding.left + plotW / 2, h - 6);
    }
  },

  _drawEmpty(ctx, w, h) {
    ctx.fillStyle = '#5a6378';
    ctx.font = '12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('无数据', w / 2, h / 2);
  },

  _fmtNum(v) {
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (v % 1 === 0) return String(v);
    return v.toFixed(1);
  }
};
