import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AlertsPanel from '@/components/AlertsPanel.vue';
import type { Alert } from '@/composables/useAlerts';

const alerts: Alert[] = [
  {
    kind: 'missing',
    scope: 'alice/repo',
    severity: 'warning',
    detail: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  {
    kind: 'archived',
    scope: 'bob/repo',
    severity: 'info',
    detail: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

describe('AlertsPanel', () => {
  it('renders one row per alert with scope + human label', () => {
    const wrapper = mount(AlertsPanel, { props: { alerts } });
    const items = wrapper.findAll('li');
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain('alice/repo');
    expect(items[0].text()).toContain('Storage unused');
    expect(items[1].text()).toContain('Storage archived');
  });

  it('renders nothing but the list shell when empty', () => {
    const wrapper = mount(AlertsPanel, { props: { alerts: [] } });
    expect(wrapper.findAll('li')).toHaveLength(0);
  });
});
