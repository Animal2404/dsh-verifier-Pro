import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/client/index.tsx',
  format: ['esm'],
  platform: 'browser',
  outDir: 'lib/client',
  clean: true,
  sourcemap: true,
  dts: false,
  external: [
    'react',
    'react-dom',
    '@deepseek-ai/dsh-client-runtime',
    'dsh-client-ui-slots',
  ],
  globals: {
    react: 'React',
    'react-dom': 'ReactDOM',
  },
})