// Design tokens from the Magic Patterns redesign (2026-10). They are the same
// values styles.css has always used, so components still on the hand-written
// stylesheet and components on utilities read as one system.
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#FBFAF8',
        card: '#FFFFFF',
        ink: { DEFAULT: '#1C1B19', soft: '#56514A', faint: '#857E74' },
        rule: '#E6E1D9',
        focus: '#2F4858',
        // Brand blue, for the few things that should stand out (trust, not alarm).
        // White text on it is 6.7:1; the hover shade is darker still.
        brand: { DEFAULT: '#1D4ED8', hover: '#1E40AF' },
        kept: { DEFAULT: '#1F6B45', wash: '#EEF5F0' },
        broken: { DEFAULT: '#9A3324', wash: '#F9EFED' },
        cantsay: { DEFAULT: '#6A6259', wash: '#F3F1EC' },
        // "Not counted" on an evidence card: yellow, beside kept green and broken red.
        pending: { DEFAULT: '#7A5200', wash: '#FBF1D6' },
        // The landing page (Magic Patterns design, 2026-11). Namespaced so it
        // cannot change the tool's colors: the tool keeps the tokens above.
        lp: {
          navy: '#0E1B33',
          navy2: '#15264A',
          navy3: '#1E3462',
          paper: '#F6F5F1',
          ink: '#14213D',
          muted: '#5B6475',
          line: '#E3E1DA',
          brand: '#2456E6',
          'brand-dark': '#1A42B8',
          'brand-soft': '#E9EFFD',
          signal: '#8DB8FF',
          verified: '#157A43',
          'verified-soft': '#E6F4EC',
          'verified-bright': '#6EE7A8',
          refuted: '#B42318',
          'refuted-soft': '#FDECEA',
          unclear: '#A15C07',
          'unclear-soft': '#FDF3E2',
        },
      },
      fontFamily: {
        serif: ['"Iowan Old Style"', '"Palatino Linotype"', 'Palatino', 'Georgia', 'serif'],
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        // Landing page only. Self-hosted (@fontsource, imported in main.tsx), never
        // from Google Fonts: a third-party font request would send every visitor's
        // IP address to Google, which the privacy page does not list.
        display: ['"Source Serif 4 Variable"', 'Georgia', 'serif'],
        'lp-sans': ['"Inter Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        'lp-mono': ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: { card: '10px' },
      boxShadow: { soft: '0 1px 2px rgba(28,27,25,0.04), 0 4px 14px rgba(28,27,25,0.04)' },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'rise-in': { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'sheet-in': { from: { opacity: '0', transform: 'translateY(28px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        'fade-in': 'fade-in 200ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'rise-in': 'rise-in 220ms cubic-bezier(0.23, 1, 0.32, 1) both',
        'sheet-in': 'sheet-in 260ms cubic-bezier(0.23, 1, 0.32, 1) both',
      },
    },
  },
};
