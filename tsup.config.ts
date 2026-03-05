import { defineConfig } from 'tsup';

// All source modules that need to be individually accessible at runtime.
// (collector and context are used internally and by advanced consumers like demo.js)
const entries: Record<string, string> = {
  index:        'src/index.ts',
  server:       'src/server.ts',
  collector:    'src/collector.ts',
  context:      'src/context.ts',
  aggregations: 'src/aggregations.ts',
  decorator:    'src/decorator.ts',
  init:         'src/init.ts',
  middleware:   'src/middleware.ts',
  patches:      'src/patches.ts',
  serialize:    'src/serialize.ts',
  watch:        'src/watch.ts',
};

export default defineConfig([
  // CommonJS build
  {
    entry: entries,
    format: 'cjs',
    outDir: 'dist/cjs',
    splitting: true,   // shared modules (collector, context) stay as singletons
    clean: true,
    dts: false,
  },

  // ESM build — tsup injects __dirname/__filename shims automatically
  {
    entry: entries,
    format: 'esm',
    outDir: 'dist/esm',
    splitting: true,
    shims: true,       // ← provides __dirname in ESM context, no patch script needed
    dts: false,
    clean: false,
  },
]);
