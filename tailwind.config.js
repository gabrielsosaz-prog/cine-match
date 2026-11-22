/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#0b0d12', 900: '#12151c', 800: '#1a1f29', 700: '#262c38', 600: '#3a4252' },
        accent: { DEFAULT: '#f5b83d', soft: '#f5b83d22' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', 'Roboto', 'sans-serif'] },
    },
  },
  plugins: [],
};
