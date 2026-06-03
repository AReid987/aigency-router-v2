/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        void: '#050505',
        'phosphor-amber': '#FFB000',
        'phosphor-green': '#00FF41',
        'phosphor-red': '#FF003C',
        crt: {
          50: '#1a1a1a',
          100: '#222222',
          200: '#333333',
          300: '#444444',
          400: '#666666',
          500: '#888888',
          600: '#aaaaaa',
        },
      },
      fontFamily: {
        mono: ['"Courier New"', 'Courier', 'monospace'],
      },
      boxShadow: {
        'crt-glow': '0 0 10px rgba(255, 176, 0, 0.3)',
        'crt-glow-green': '0 0 10px rgba(0, 255, 65, 0.3)',
      },
    },
  },
  plugins: [],
};
