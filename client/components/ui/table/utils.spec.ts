import { describe, expect, it } from 'vitest';
import { ref } from 'vue';

import { valueUpdater } from '@/components/ui/table/utils';

describe('valueUpdater', () => {
  it('assigns plain value', () => {
    const r = ref(1);
    valueUpdater(2, r);
    expect(r.value).toBe(2);
  });

  it('applies function updater', () => {
    const r = ref(10);
    valueUpdater((prev) => prev + 5, r);
    expect(r.value).toBe(15);
  });
});
