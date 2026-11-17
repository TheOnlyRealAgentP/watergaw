// Small GeoJSON helpers shared by the app and the forecast module.

export function rings(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  return [];
}

export function pointInGeom(pt, g) {
  for (const poly of rings(g)) {
    let inside = false;
    for (let r = 0; r < poly.length; r++) {
      const ring = poly[r];
      let c = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
      }
      if (r === 0) inside = c;
      else if (c) inside = false;
    }
    if (inside) return true;
  }
  return false;
}
