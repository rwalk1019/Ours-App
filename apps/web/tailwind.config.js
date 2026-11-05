/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#f6f1e8',
        ink: '#2c241c',
        clay: '#8d3f32',
        sage: '#24543d',
        line: '#e5d8c8',
      },
      fontFamily: {
        sans: ['Outfit', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Fraunces', 'Georgia', 'serif'],
      },
      boxShadow: {
        card: '0 16px 40px rgba(68, 42, 24, 0.08)',
      },
    },
  },
  plugins: [],
};
