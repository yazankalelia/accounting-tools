import { defineConfig } from 'vitest/config';

export default defineConfig({
  // مسار نسبي ليعمل على GitHub Pages من أي مجلد فرعي
  base: './',
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
  },
});
