import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec}.ts'],
    reporters: ['tree'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/*.d.ts'
      ],
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
      clean: true
    }
  }
});
