/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,html}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Light mode (client's primary theme)
        surface: '#FFFFFF',
        'surface-raised': '#F8F9FB',
        border: {
          DEFAULT: '#E5E7EB',
          strong: '#D1D5DB',
        },
        ink: {
          DEFAULT: '#111827', // primary text
          secondary: '#1F2937', // client-specified secondary text
          muted: '#6B7280',
        },
        accent: {
          DEFAULT: '#DC2626', // Crimson Red
          hover: '#B91C1C',
          soft: '#FEE2E2',
        },
        success: {
          DEFAULT: '#16A34A', // Green - "on"/"available" state for toggles
          hover: '#15803D',
          soft: '#DCFCE7',
        },
        danger: {
          DEFAULT: '#DC2626', // Red - "off"/"unavailable" state for toggles
          hover: '#B91C1C',
          soft: '#FEE2E2',
        },
        // Night Shift mode
        obsidian: {
          DEFAULT: '#0F172A',
          raised: '#161F36',
          border: '#26314D',
        },
      },
      fontFamily: {
        display: ['Manrope', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      transitionTimingFunction: {
        ubuntu: 'cubic-bezier(0.4, 0, 0.2, 1)',
      },
      boxShadow: {
        card: '0 1px 2px 0 rgba(17, 24, 39, 0.04), 0 1px 3px 0 rgba(17, 24, 39, 0.06)',
        'card-hover': '0 4px 10px -2px rgba(17, 24, 39, 0.08), 0 2px 4px -2px rgba(17, 24, 39, 0.06)',
        modal: '0 20px 40px -8px rgba(17, 24, 39, 0.25)',
      },
    },
  },
  plugins: [],
};
