/* the $pulp seal's engraved rings and a matching certificate frame, drawn on canvas in the
   page's own colours. any canvas with data-guilloche="seal" or "frame" is drawn and redrawn on
   resize and theme change; #backdrop (the dashboard's faint seal) is a seal. */
(function () {
  const css = (n) =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const TAU = Math.PI * 2;

  function setup(cv) {
    const box = cv.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(box.width * dpr);
    cv.height = Math.round(box.height * dpr);
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.lineJoin = "round";
    return { ctx, dpr, W: cv.width, H: cv.height };
  }

  function drawSeal(cv, weight) {
    const s = setup(cv);
    if (!s) return;
    const { ctx, dpr } = s,
      S = Math.min(s.W, s.H),
      c = S / 2,
      R = S / 2,
      ox = css("--oxblood"),
      ink = css("--ink-2");
    const lw = weight || 1.8;
    const band = (base, amp, k, copies, col, alpha, w, k2, amp2) => {
      ctx.strokeStyle = col;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = w * dpr * lw;
      for (let i = 0; i < copies; i++) {
        const ph = (i * TAU) / (copies * k);
        ctx.beginPath();
        for (let n = 0; n <= 1440; n++) {
          const t = (n / 1440) * TAU;
          let r = base + amp * Math.sin(k * (t + ph));
          if (k2) r += amp2 * Math.sin(k2 * (t - ph * 1.5));
          const x = c + r * Math.cos(t),
            y = c + r * Math.sin(t);
          n ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }
    };
    band(R * 0.845, R * 0.045, 48, 9, ox, 0.55, 0.6);
    band(R * 0.69, R * 0.075, 24, 12, ox, 0.5, 0.6, 72, R * 0.012);
    band(R * 0.5, R * 0.06, 12, 14, ink, 0.4, 0.55, 36, R * 0.02);
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = ox;
    ctx.lineWidth = 0.9 * dpr * lw;
    [R * 0.905, R * 0.775, R * 0.6, R * 0.36].forEach((r) => {
      ctx.beginPath();
      ctx.arc(c, c, r, 0, TAU);
      ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  // a point on a rounded rectangle's outline, walked clockwise from the top-left straight,
  // with the outward normal, so a wave can be laid along the border like banknote engraving
  function rr(u, x0, y0, w, h, r) {
    const L1 = w - 2 * r,
      L2 = h - 2 * r,
      A = (Math.PI * r) / 2,
      seg = [L1, A, L2, A, L1, A, L2, A];
    let i = 0;
    while (i < 7 && u > seg[i]) {
      u -= seg[i];
      i++;
    }
    let a;
    switch (i) {
      case 0:
        return [x0 + r + u, y0, 0, -1];
      case 1:
        a = -Math.PI / 2 + u / r;
        return [
          x0 + w - r + r * Math.cos(a),
          y0 + r + r * Math.sin(a),
          Math.cos(a),
          Math.sin(a),
        ];
      case 2:
        return [x0 + w, y0 + r + u, 1, 0];
      case 3:
        a = u / r;
        return [
          x0 + w - r + r * Math.cos(a),
          y0 + h - r + r * Math.sin(a),
          Math.cos(a),
          Math.sin(a),
        ];
      case 4:
        return [x0 + w - r - u, y0 + h, 0, 1];
      case 5:
        a = Math.PI / 2 + u / r;
        return [
          x0 + r + r * Math.cos(a),
          y0 + h - r + r * Math.sin(a),
          Math.cos(a),
          Math.sin(a),
        ];
      case 6:
        return [x0, y0 + h - r - u, -1, 0];
      default:
        a = Math.PI + u / r;
        return [
          x0 + r + r * Math.cos(a),
          y0 + r + r * Math.sin(a),
          Math.cos(a),
          Math.sin(a),
        ];
    }
  }

  function drawFrame(cv) {
    const s = setup(cv);
    if (!s) return;
    const { ctx, dpr, W, H } = s,
      ox = css("--oxblood"),
      ink = css("--ink-2");
    // smaller cards get a finer, shallower frame. the lock certificate pads its text by the same
    // scale (--inset in lock/index.html), so keep the two in step
    const k = Math.max(0.6, Math.min(1, W / dpr / 620));
    const band = (inset, radius, amp, wave, copies, col, alpha, w) => {
      inset *= k;
      radius *= k;
      amp *= k;
      wave *= k;
      const x0 = inset * dpr,
        y0 = inset * dpr,
        w0 = W - 2 * x0,
        h0 = H - 2 * y0,
        r = radius * dpr;
      const P = 2 * (w0 + h0) - (8 - 2 * Math.PI) * r;
      const waves = Math.max(8, Math.round(P / (wave * dpr))); // whole waves, so the band closes seamlessly
      const N = Math.ceil(P / (1.5 * dpr));
      ctx.strokeStyle = col;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = w * dpr;
      for (let j = 0; j < copies; j++) {
        const ph = (j * TAU) / copies;
        ctx.beginPath();
        for (let n = 0; n <= N; n++) {
          const u = ((n % N) / N) * P,
            p = rr(u, x0, y0, w0, h0, r);
          const off = amp * dpr * Math.sin((TAU * waves * u) / P + ph);
          const x = p[0] + p[2] * off,
            y = p[1] + p[3] * off;
          n ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }
    };
    const rule = (inset, radius, col, alpha, w) => {
      inset *= k;
      radius *= k;
      const x0 = inset * dpr,
        y0 = inset * dpr,
        w0 = W - 2 * x0,
        h0 = H - 2 * y0,
        r = radius * dpr;
      ctx.strokeStyle = col;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = w * dpr;
      ctx.beginPath();
      ctx.roundRect(x0, y0, w0, h0, r);
      ctx.stroke();
    };
    rule(5, 16, ox, 0.55, 1);
    band(16, 14, 5, 22, 6, ox, 0.32, 0.55);
    rule(27, 10, ox, 0.45, 0.8);
    band(34, 8, 3, 12, 5, ink, 0.3, 0.5);
    rule(41, 5, ink, 0.3, 0.6);
    ctx.globalAlpha = 1;
  }

  function drawAll() {
    document
      .querySelectorAll('canvas[data-guilloche="seal"],#backdrop')
      .forEach((cv) => drawSeal(cv, +(cv.dataset.weight || 1.8)));
    document
      .querySelectorAll('canvas[data-guilloche="frame"]')
      .forEach(drawFrame);
  }
  window.PaperGuilloche = { drawSeal, drawFrame, drawAll };
  drawAll();
  if (document.fonts && document.fonts.ready)
    document.fonts.ready.then(drawAll);
  addEventListener("resize", () => {
    clearTimeout(drawAll.t);
    drawAll.t = setTimeout(drawAll, 150);
  });
  // a card that grows with its text (the lock certificate) redraws its frame to match
  if (window.ResizeObserver) {
    const ro = new ResizeObserver((es) =>
      es.forEach((e) => {
        const cv = e.target;
        if (cv.dataset.guilloche === "frame") drawFrame(cv);
        else drawSeal(cv, +(cv.dataset.weight || 1.8));
      })
    );
    document
      .querySelectorAll("canvas[data-guilloche]")
      .forEach((cv) => ro.observe(cv));
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener(
    "change",
    drawAll
  );
  new MutationObserver(drawAll).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
})();
