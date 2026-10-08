import { SinkHttpError } from './reliable.js';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null } }>;

export async function postJson(fetchImpl: FetchLike, url: string, body: unknown, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (res.ok) return;
  const ra = Number(res.headers.get('retry-after'));
  throw new SinkHttpError(res.status, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
}
