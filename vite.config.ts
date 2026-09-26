import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        proxy: {
          '/api': {
            target: 'http://localhost/proctorguard-enterprise',
            changeOrigin: true,
          },
        },
      },
      plugins: [react()],
      build: {
        chunkSizeWarningLimit: 2200,
        rollupOptions: {
          output: {
            manualChunks: {
              tfjs: ['@tensorflow/tfjs'],
              'tf-models': ['@tensorflow-models/blazeface', '@tensorflow-models/coco-ssd'],
              charts: ['recharts'],
              react: ['react', 'react-dom'],
            },
          },
        },
      },
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
      },
      resolve: {
        alias: [
          { find: '@', replacement: path.resolve(__dirname, '.') },
          // Force @ricky0123/vad-web onto ONNX Runtime's CPU-only wasm build. The default entry
          // pulls the JSEP (WebGPU) build, which needs the 26 MB ort-wasm-simd-threaded.jsep.wasm;
          // Silero VAD only runs on the CPU wasm EP, so the wasm-only build (13 MB
          // ort-wasm-simd-threaded.wasm) is all we ship/serve. Anchored regex so ONLY the bare
          // specifier is rewritten — subpath imports like onnxruntime-web/wasm are left intact.
          { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' },
        ]
      }
    };
});
