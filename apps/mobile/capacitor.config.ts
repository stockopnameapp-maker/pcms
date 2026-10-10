import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'id.palmora.health.clinic',
  appName: 'Palmora Health',
  webDir: 'dist',
  android: {
    // Company servers on the office network may use plain http (e.g. http://192.168.1.10:8080)
    allowMixedContent: true,
  },
  server: { androidScheme: 'https' },
  plugins: {
    StatusBar: { backgroundColor: '#0E3B2E', style: 'DARK', overlaysWebView: false },
  },
};

export default config;
