import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// 相対パスで配信できる静的ビルド。Claudeのアーティファクトでも Vercel でもそのまま動く。
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        // .mjs のワーカーも .js として出す（静的ホストでの MIME 判定を確実にするため）
        assetFileNames: (info) => ((info.names?.[0] || info.name || '').endsWith('.mjs') ? 'assets/[name]-[hash].js' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
})
