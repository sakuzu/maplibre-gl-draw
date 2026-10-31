// SPDX-FileCopyrightText: 2026 SAKAIDA Atsushi
// SPDX-License-Identifier: AGPL-3.0-only

import { MercatorCoordinate } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';
import { degreesPerMeterAt, metersPerPixelAtZoom } from './ground-scale.js';
import {
  mercatorUnitsPerMeter,
  metersPerPixelInFrame,
  type ScreenScaleFrame,
  screenScaleUniformsOf,
} from './screen-scale.js';

const relative = (a: number, b: number) => Math.abs(a / b - 1);

describe('mercatorUnitsPerMeter', () => {
  it('is the value maplibre gives for the Mercator units of a meter', () => {
    for (const lat of [0, 12.5, 35.68, -48, 70, 85]) {
      const theirs = MercatorCoordinate.fromLngLat({
        lng: 0,
        lat,
      }).meterInMercatorCoordinateUnits();
      expect(relative(mercatorUnitsPerMeter(lat), theirs)).toBeLessThan(1e-12);
    }
  });
});

describe('metersPerPixelInFrame', () => {
  const frame = (transition: number): ScreenScaleFrame => ({
    zoom: 14,
    centerLatitude: 35.68,
    transition,
  });

  it('is the scale of Web Mercator at the latitude of the position on Web Mercator', () => {
    for (const lat of [0, 35.68, 50, -60]) {
      expect(
        relative(metersPerPixelInFrame(frame(0), lat), metersPerPixelAtZoom(lat, 14)),
      ).toBeLessThan(1e-12);
    }
  });

  it('is the scale at the center of the view at every latitude on the globe', () => {
    const atCenter = metersPerPixelAtZoom(35.68, 14);
    for (const lat of [0, 35.68, 50, -60]) {
      expect(relative(metersPerPixelInFrame(frame(1), lat), atCenter)).toBeLessThan(1e-12);
    }
  });

  it('mixes the Mercator units of a meter of the two in the transition', () => {
    const lat = 60;
    const units =
      (mercatorUnitsPerMeter(lat) + mercatorUnitsPerMeter(35.68)) / 2 / (1 / 512 / 2 ** 14);
    expect(relative(metersPerPixelInFrame(frame(0.5), lat), 1 / units)).toBeLessThan(1e-12);
  });
});

describe('screenScaleUniformsOf', () => {
  it('gives a shader what computes the same degrees of a pixel', () => {
    for (const transition of [0, 0.3, 1]) {
      const f: ScreenScaleFrame = { zoom: 16.4, centerLatitude: -22, transition };
      const u = screenScaleUniformsOf(f);
      for (const lat of [-40, -22, 0, 10]) {
        // As the shader of the frames of features selected in bulk computes it
        const secant = 1 / Math.cos((lat * Math.PI) / 180);
        const pixelsPerMeter =
          u.pixelsPerMeterAtEquator * (secant + (u.centerSecant - secant) * u.transition);
        const north = u.degreesPerMeterNorth / pixelsPerMeter;
        const expected = metersPerPixelInFrame(f, lat) * degreesPerMeterAt(lat)[1];
        expect(relative(north, expected)).toBeLessThan(1e-12);
      }
    }
  });
});
