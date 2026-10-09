/** Design tokens: canopy greens (structure), latex white (work surface), bark greys (text), kernel gold (one accent for scope/selection). */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canopy: { DEFAULT: '#0E3B2E', 900: '#0A2C22', 800: '#0E3B2E', 700: '#14503E', 600: '#1F6B4F', 500: '#2E8463', 300: '#9FD3B8', 100: '#E3F1EA', 50: '#F1F8F4' },
        mist: '#F3F5F4', line: '#E1E6E3', bark: { DEFAULT: '#5E6B65', 700: '#3F4A45', 400: '#8C9993' }, ink: '#17211C',
        kernel: { DEFAULT: '#B38B2E', 100: '#F6EDD6', 50: '#FBF6EA' },
        sev: { low: '#3B7FA8', medium: '#B7791F', high: '#C2410C', critical: '#B42318' },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'system-ui', 'Segoe UI', 'sans-serif'],
        cond: ['"IBM Plex Sans Condensed"', '"IBM Plex Sans"', 'system-ui', 'sans-serif'],
      },
      fontSize: { '2xs': ['11px', '15px'] },
      borderRadius: { panel: '10px' },
      boxShadow: { pop: '0 12px 32px -12px rgba(14,59,46,.28), 0 2px 6px rgba(14,59,46,.08)' },
    },
  },
  plugins: [],
};
