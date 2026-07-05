/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
      },
      colors: {
        ink: {
          DEFAULT: '#1A1B1E',
          muted: '#6B6864',
        },
        proof: '#EDEBE6',
        rule: '#D6D3CC',
        orange: '#E8500A',
        blue: '#2B5C8A',
        green: '#2A7A4B',
        red: '#B91C1C',
      },
      borderRadius: {
        DEFAULT: '2px',
        sm: '2px',
        md: '4px',
        lg: '4px',
        xl: '6px',
      },
    },
  },
  plugins: [],
};
