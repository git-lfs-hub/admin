import { describe, expect, it } from 'vitest';

import { buttonVariants } from '@/components/ui/button';

describe('buttonVariants', () => {
  it('returns default classes', () => {
    const cls = buttonVariants({});
    expect(cls).toContain('bg-primary');
  });

  it('applies variant override', () => {
    const cls = buttonVariants({ variant: 'outline' });
    expect(cls).toContain('border-border');
  });

  it('applies size override', () => {
    const cls = buttonVariants({ size: 'icon' });
    expect(cls).toContain('size-8');
  });
});
