// Full-screen map (IMPLEMENTATION_PLAN.md §12.2): quiet basemap, tappable hero places, the place being talked
// about raised in 3D, the walking route, numbered tour stops and the user's position.
import {
  Camera,
  type CameraRef,
  GeoJSONSource,
  Layer,
  Map,
  UserLocation,
} from '@maplibre/maplibre-react-native';
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';

import { MAP_STYLE, START } from '@/wander/config';
import { teleport } from '@/wander/location';
import { guide } from '@/wander/session';
import { emptyCollection, useWander } from '@/wander/store';

import { MAP_COLORS } from './theme';

export type WanderMapRef = { recenter: () => void; frame: (coords: number[][], bottomInset: number) => void };

type Props = { heroes: GeoJSON.FeatureCollection; onUserPan: () => void };

export const WanderMap = forwardRef<WanderMapRef, Props>(function WanderMap({ heroes, onUserPan }, ref) {
  const camera = useRef<CameraRef>(null);
  const fix = useWander((s) => s.fix);
  const source = useWander((s) => s.source);
  const focus = useWander((s) => s.focus);
  const route = useWander((s) => s.route);
  const tour = useWander((s) => s.tour);
  const selectedId = useWander((s) => s.selectedId);

  useImperativeHandle(ref, () => ({
    recenter: () => {
      const f = useWander.getState().fix;
      camera.current?.easeTo({ center: [f.lon, f.lat], zoom: 16.6, pitch: 45, duration: 500 });
    },
    frame: (coords, bottomInset) => {
      if (!coords.length) return;
      const lons = coords.map((p) => p[0]);
      const lats = coords.map((p) => p[1]);
      camera.current?.fitBounds([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
        { padding: { top: 130, bottom: bottomInset + 30, left: 40, right: 40 }, duration: 700 } as never);
    },
  }), []);

  const user = useMemo<GeoJSON.Feature>(() => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [fix.lon, fix.lat] },
    properties: { heading: fix.heading ?? 0, hasHeading: fix.heading != null },
  }), [fix]);

  const stops = useMemo<GeoJSON.FeatureCollection>(() => !tour ? emptyCollection : {
    type: 'FeatureCollection',
    features: tour.stops.map((s, i) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { n: String(i + 1), status: s.status, name: s.name },
    })),
  }, [tour]);

  const heroesMarked = useMemo<GeoJSON.FeatureCollection>(() => ({
    ...heroes,
    features: heroes.features.map((f) => ({ ...f, properties: { ...f.properties, selected: f.id === selectedId } })),
  }), [heroes, selectedId]);

  return (
    <Map
      style={StyleSheet.absoluteFill}
      mapStyle={MAP_STYLE}
      logo={false}
      attribution
      compass={false}
      onLongPress={(e) => teleport(e.nativeEvent.lngLat[1], e.nativeEvent.lngLat[0])}
      onRegionWillChange={(e) => {
        if (e.nativeEvent.userInteraction) onUserPan();
      }}>
      <Camera ref={camera} initialViewState={{ center: [START.lon, START.lat], zoom: 16.4, pitch: 45 }} />

      <GeoJSONSource id="heroes" data={heroesMarked}
        onPress={(e) => {
          const id = e.nativeEvent.features?.[0]?.properties?.id as string | undefined;
          if (id) void guide.select(id);
        }}>
        <Layer type="fill" id="hero-fill"
          paint={{ 'fill-color': MAP_COLORS.accent, 'fill-opacity': ['case', ['get', 'selected'], 0.22, 0.07] }} />
        <Layer type="line" id="hero-line"
          paint={{ 'line-color': MAP_COLORS.accent, 'line-opacity': 0.45, 'line-width': 1.2 }} />
        <Layer type="symbol" id="hero-label" minzoom={15.5}
          layout={{ 'text-field': ['get', 'name'], 'text-size': 11, 'text-font': ['Noto Sans Bold'],
                    'text-optional': true, 'text-max-width': 8 }}
          paint={{ 'text-color': '#5c2433', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 }} />
      </GeoJSONSource>

      {route ? (
        <GeoJSONSource id="route" data={route}>
          <Layer type="line" id="route-casing" layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': '#ffffff', 'line-width': 9 }} />
          <Layer type="line" id="route-line" layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': MAP_COLORS.route, 'line-width': 5 }} />
        </GeoJSONSource>
      ) : null}

      <GeoJSONSource id="focus" data={focus}>
        <Layer type="fill-extrusion" id="focus-3d"
          paint={{ 'fill-extrusion-color': MAP_COLORS.accent, 'fill-extrusion-opacity': 0.85,
                   'fill-extrusion-height': ['coalesce', ['get', 'height_m'], 14] }} />
        <Layer type="line" id="focus-line" filter={['==', ['geometry-type'], 'LineString']}
          paint={{ 'line-color': MAP_COLORS.accent, 'line-width': 6, 'line-dasharray': [1.2, 1] }} />
        <Layer type="circle" id="focus-point" filter={['==', ['geometry-type'], 'Point']}
          paint={{ 'circle-radius': 10, 'circle-color': MAP_COLORS.accent, 'circle-stroke-color': '#fff',
                   'circle-stroke-width': 3 }} />
        <Layer type="symbol" id="focus-label"
          layout={{ 'text-field': ['coalesce', ['get', 'badge'], ''], 'text-size': 16, 'text-font': ['Noto Sans Bold'],
                    'text-allow-overlap': true }}
          paint={{ 'text-color': '#fff', 'text-halo-color': MAP_COLORS.accent, 'text-halo-width': 3 }} />
      </GeoJSONSource>

      {tour ? (
        <GeoJSONSource id="tour-stops" data={stops}>
          <Layer type="circle" id="stop-dot"
            paint={{ 'circle-radius': ['case', ['==', ['get', 'status'], 'current'], 15, 12],
                     'circle-color': ['match', ['get', 'status'], 'current', MAP_COLORS.accent, 'done', MAP_COLORS.done,
                                      MAP_COLORS.route],
                     'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 }} />
          <Layer type="symbol" id="stop-n"
            layout={{ 'text-field': ['get', 'n'], 'text-size': 13, 'text-font': ['Noto Sans Bold'],
                      'text-allow-overlap': true }}
            paint={{ 'text-color': '#ffffff' }} />
        </GeoJSONSource>
      ) : null}

      {source === 'gps' ? (
        // native puck: smooth CoreLocation updates, accuracy ring and heading cone
        <UserLocation accuracy heading animated />
      ) : (
        <GeoJSONSource id="user" data={user}>
          <Layer type="circle" id="user-halo"
            paint={{ 'circle-radius': 20, 'circle-color': MAP_COLORS.user, 'circle-opacity': 0.15 }} />
          <Layer type="symbol" id="user-heading" filter={['==', ['get', 'hasHeading'], true]}
            layout={{ 'text-field': '▲', 'text-size': 16, 'text-rotate': ['get', 'heading'],
                      'text-rotation-alignment': 'map', 'text-offset': [0, -1.5], 'text-allow-overlap': true,
                      'text-font': ['Noto Sans Bold'] }}
            paint={{ 'text-color': MAP_COLORS.user }} />
          <Layer type="circle" id="user-dot"
            paint={{ 'circle-radius': 8, 'circle-color': MAP_COLORS.user, 'circle-stroke-color': '#fff',
                     'circle-stroke-width': 3 }} />
        </GeoJSONSource>
      )}
    </Map>
  );
});
