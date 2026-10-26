/** View coordinates are CSS pixels; world coordinates are canvas.json pixels. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
export function zoomLimit(value) { return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number.isFinite(value) ? value : 1)); }
export function worldToView(point, view) { return { x: point.x * view.k + view.x, y: point.y * view.k + view.y }; }
export function viewToWorld(point, view) { return { x: (point.x - view.x) / view.k, y: (point.y - view.y) / view.k }; }
export function zoomAt(view, value, anchor) {
  const world = viewToWorld(anchor, view), k = zoomLimit(value);
  return { k, x: anchor.x - world.x * k, y: anchor.y - world.y * k };
}
export function sceneBounds(boards) {
  const valid = boards.filter(b => [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0);
  if (!valid.length) return { x: 0, y: 0, w: 100, h: 100 };
  const x = Math.min(...valid.map(b => b.x)), y = Math.min(...valid.map(b => b.y));
  return { x, y, w: Math.max(...valid.map(b => b.x + b.w)) - x, h: Math.max(...valid.map(b => b.y + b.h)) - y };
}
export function fitView(bounds, width, height, padding = 40) {
  const k = zoomLimit(Math.min((width - padding * 2) / bounds.w, (height - padding * 2) / bounds.h));
  return { k, x: (width - bounds.w * k) / 2 - bounds.x * k, y: (height - bounds.h * k) / 2 - bounds.y * k };
}
export function constrainView(view, bounds, width, height) {
  const edge = Math.min(40, width / 2, height / 2), k = zoomLimit(view.k);
  return { k,
    x: Math.max(edge - (bounds.x + bounds.w) * k, Math.min(width - edge - bounds.x * k, view.x)),
    y: Math.max(edge - (bounds.y + bounds.h) * k, Math.min(height - edge - bounds.y * k, view.y)),
  };
}
export function visibleBoards(boards, view, width, height, active, budget = 4) {
  const candidates = boards.filter(b => {
    const p = worldToView(b, view);
    return b.path !== active && p.x < width && p.y < height && p.x + b.w * view.k > 0 && p.y + b.h * view.k > 0;
  }).sort((a, b) => {
    const distance = r => {
      const p = worldToView({ x: r.x + r.w / 2, y: r.y + r.h / 2 }, view);
      return (p.x - width / 2) ** 2 + (p.y - height / 2) ** 2;
    };
    return distance(a) - distance(b) || a.path.localeCompare(b.path);
  });
  return candidates.slice(0, Math.max(0, budget - 1)).map(b => b.path);
}
