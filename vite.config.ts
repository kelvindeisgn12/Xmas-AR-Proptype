import { defineConfig, type Plugin } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'


// mind-ar 1.2.x still imports Three's removed `sRGBEncoding` constant. The
// application also needs current Three for three-mediapipe-rig, so translate the
// one legacy MindAR assignment at build time instead of pinning the whole app to
// an old renderer. This can be removed when MindAR publishes a colorSpace build.
function mindArThreeCompatibility(): Plugin {
  return {
    name: 'mindar-three-color-space-compatibility',
    enforce: 'pre',
    transform(code: string, id: string) {
      if (!id.includes('mindar-face-three.prod.js')) return null

      return code
        .replace(/sRGBEncoding as ([A-Za-z_$][\w$]*)/, 'SRGBColorSpace as $1')
        .replace(/\.outputEncoding\s*=\s*([A-Za-z_$][\w$]*)/, '.outputColorSpace = $1')
    },
  }
}


function figmaAssetResolver(): Plugin {
  return {
    name: 'figma-asset-resolver',
    resolveId(id: string) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

export default defineConfig({
  // GitHub Pages publishes project sites under /<repository-name>/. The Action
  // supplies this value; local development and custom domains keep the root path.
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [
    figmaAssetResolver(),
    mindArThreeCompatibility(),
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    // Keep the legacy module out of esbuild's dependency pre-bundle so the
    // compatibility transform above also runs in the dev server.
    exclude: ['mind-ar'],
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv', '**/*.glb'],
})
