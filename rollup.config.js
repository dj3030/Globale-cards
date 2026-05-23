import resolve from '@rollup/plugin-node-resolve';

export default {
  input: 'src/index.js',
  output: {
    file: 'dist/global-cards.js',
    format: 'es',
  },
  plugins: [resolve()],
};
