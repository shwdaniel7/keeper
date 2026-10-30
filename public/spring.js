export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Mola amortecida com velocidade inicial (px/s). response ≈ tempo para chegar; damping 1 = sem overshoot.
export function spring({ from, to, velocity = 0, response = 0.35, damping = 1, onUpdate, onDone }) {
  const w = (2 * Math.PI) / response;
  const k = w * w;
  const c = 2 * damping * w;
  let x = from;
  let v = velocity;
  let last = performance.now();
  let raf = requestAnimationFrame(step);

  function step(now) {
    let dt = Math.min(Math.max((now - last) / 1000, 0), 0.064);
    last = now;
    while (dt > 0) {
      const h = Math.min(dt, 1 / 240);
      v += (-k * (x - to) - c * v) * h;
      x += v * h;
      dt -= h;
    }
    if (Math.abs(v) < 0.05 && Math.abs(x - to) < 0.05) {
      onUpdate(to);
      return onDone?.();
    }
    onUpdate(x);
    raf = requestAnimationFrame(step);
  }
  return { stop: () => cancelAnimationFrame(raf) };
}

// Onde um gesto com essa velocidade (px/s) pararia, como a desaceleração do scroll.
export const project = (velocity, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate);

// Resistência progressiva além do limite.
export const rubberband = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));
