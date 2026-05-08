import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        'ph-bg': '#EEEFE9',
        'ph-text': '#151515',
        'ph-accent': '#E5E7E0',
        'ph-divider': '#D0D1C9',
        'ph-red': '#F54E00',
        'ph-yellow': '#DC9300',
        'ph-blue': '#1D4AFF',
        'ph-gray': '#BFBFBC',
      },
      borderStyle: {
        dashed: 'dashed',
      },
    },
  },
  plugins: [],
}

export default config
