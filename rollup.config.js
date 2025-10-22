// See: https://rollupjs.org/introduction/

import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import typescript from '@rollup/plugin-typescript'
import json from '@rollup/plugin-json'

const config = {
  input: 'src/index.ts',
  output: {
    esModule: true,
    file: 'dist/index.cjs',
    format: 'cjs',
    sourcemap: true
  },
  plugins: [
    commonjs(),
    nodeResolve({ preferBuiltins: true }),
    typescript({
      exclude: ['**/*.test.ts']
    }),
    json()
  ]
}

export default config
