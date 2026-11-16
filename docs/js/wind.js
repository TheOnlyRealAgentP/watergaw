// Animated surface wind, from NOAA's GFS model via Watergaw Wind
// (https://github.com/TheOnlyRealAgentP/watergaw-wind, vendored in docs/vendor/).
// Only the 10 m U/V fields are range-downloaded from NOAA's open data and
// decoded in WebAssembly; particles flow through them on a canvas over the map.

import { WindEngine } from '../vendor/watergaw-wind/js/wind-engine.js';
import { WindParticles, WIND_COLORS, windColor } from '../vendor/watergaw-wind/js/wind-particles.js';

export const WIND_STOPS = WIND_COLORS;
export { windColor };

export class WindField {
  constructor() {
    this.engine = new WindEngine();
    this.grid = null;
    this.loadedAt = 0;
  }

  /** True when the loaded grid still covers this view at a similar scale and is under 30 minutes old. */
  covers(b) {
    const g = this.grid;
    if (!g) return false;
    const box = g.box;
    return b.getWest() >= box.west && b.getEast() <= box.east && b.getSouth() >= box.south && b.getNorth() <= box.north
      && (box.east - box.west) < (b.getEast() - b.getWest()) * 3 && Date.now() - this.loadedAt < 30 * 60e3;
  }

  async load(bounds) {
    const padX = (bounds.getEast() - bounds.getWest()) * 0.15, padY = (bounds.getNorth() - bounds.getSouth()) * 0.15;
    const box = {
      west: Math.max(-180, bounds.getWest() - padX), east: Math.min(180, bounds.getEast() + padX),
      south: Math.max(-85, bounds.getSouth() - padY), north: Math.min(85, bounds.getNorth() + padY),
    };
    // ~3 km sampling (HRRR's spacing over the US), capped for speed.
    const nx = Math.max(32, Math.min(240, Math.round((box.east - box.west) / 0.03)));
    const ny = Math.max(24, Math.min(180, Math.round((box.north - box.south) / 0.03)));
    this.grid = await this.engine.wind(box, { nx, ny });
    this.loadedAt = Date.now();
    return this.grid;
  }

  /** Wind [u, v] in m/s at a point, or null. */
  at(lat, lon) {
    return this.grid ? this.grid.at(lat, lon) : null;
  }

  get source() {
    return this.grid?.source || '';
  }
}

/** Particle animation for one map, driven by a WindField. */
export class WindAnimation {
  constructor(map, field) {
    this.particles = new WindParticles(map, (lat, lon) => field.at(lat, lon));
  }

  rebuild() {
    this.particles.start();
  }

  destroy() {
    this.particles.destroy();
  }

  get parts() {
    return this.particles.parts;
  }
}
