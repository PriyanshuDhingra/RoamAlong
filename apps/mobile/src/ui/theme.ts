import { useColorScheme } from 'react-native';

// Clean, high-contrast palette (Airbnb-ish coral accent on Uber-ish black/white). The map stays light in both
// schemes; panels follow the system appearance.
const light = {
  bg: '#FFFFFF',
  panel: '#FFFFFF',
  ink: '#222222',
  muted: '#6A6A6A',
  faint: '#B0B0B0',
  line: '#EBEBEB',
  chip: '#F4F4F4',
  primary: '#111111',
  onPrimary: '#FFFFFF',
  accent: '#FF385C',
  accentSoft: 'rgba(255,56,92,0.12)',
  success: '#008A05',
  shadow: '#000000',
};

const dark: typeof light = {
  bg: '#121212',
  panel: '#1C1C1E',
  ink: '#F5F5F5',
  muted: '#A0A0A0',
  faint: '#5A5A5A',
  line: '#2C2C2E',
  chip: '#2C2C2E',
  primary: '#FFFFFF',
  onPrimary: '#111111',
  accent: '#FF385C',
  accentSoft: 'rgba(255,56,92,0.22)',
  success: '#30D158',
  shadow: '#000000',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const MAP_COLORS = { accent: '#FF385C', route: '#111111', user: '#1A73E8', done: '#B0B0B0' };

export const shadow = (t: Theme, elevation = 12) => ({
  shadowColor: t.shadow,
  shadowOpacity: 0.14,
  shadowRadius: elevation,
  shadowOffset: { width: 0, height: Math.round(elevation / 3) },
  elevation,
});
