import type { AppType } from '@worker/index';
import { hc } from 'hono/client';

const authFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, { credentials: 'same-origin', ...init });
  if (res.status === 401) {
    window.location.assign('/login/oauth/authorize');
    throw new Error('unauthenticated');
  }
  if (!res.ok) {
    const body = await res
      .clone()
      .json()
      .catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return res;
};

export const api = hc<AppType>('/', { fetch: authFetch });
