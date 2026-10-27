import type { Bot, BotInput, DayBucket, FeedStatus, HourBucket, StrategyInfo, Timeframe, Trade } from '../../shared/types.ts';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as T;
}

export interface User {
  id: number;
  email: string;
  name: string;
}

export const api = {
  me: () => call<{ user: User }>('GET', '/api/auth/me'),
  authConfig: () => call<{ allowSignup: boolean }>('GET', '/api/auth/config'),
  login: (email: string, password: string) => call<{ user: User }>('POST', '/api/auth/login', { email, password }),
  signup: (name: string, email: string, password: string) => call<{ user: User }>('POST', '/api/auth/signup', { name, email, password }),
  logout: () => call('POST', '/api/auth/logout'),

  feed: () => call<FeedStatus>('GET', '/api/feed'),
  strategies: () => call<StrategyInfo[]>('GET', '/api/strategies'),
  bots: () => call<Bot[]>('GET', '/api/bots'),
  createBot: (input: BotInput) => call<Bot>('POST', '/api/bots', input),
  starterFleet: (opts: { backfillDays: number; startBalance: number; baseLot: number; timeframes?: Timeframe[] }) =>
    call<{ created: number }>('POST', '/api/bots/starter-fleet', opts),
  updateBot: (id: number, patch: Partial<Omit<BotInput, 'strategy' | 'timeframe' | 'startBalance' | 'backfillDays'>>) =>
    call<Bot>('PATCH', `/api/bots/${id}`, patch),
  botAction: (id: number, action: 'pause' | 'resume' | 'reset' | 'clone', body?: unknown) =>
    call<Bot>('POST', `/api/bots/${id}/${action}`, body ?? {}),
  deleteBot: (id: number) => call('DELETE', `/api/bots/${id}`),
  trades: (id: number, limit = 200) => call<Trade[]>('GET', `/api/bots/${id}/trades?limit=${limit}`),

  hourly: (dates: string[], bots: number[], liveOnly: boolean, tf: Timeframe | '' = '') =>
    call<{ dates: string[]; hours: HourBucket[] }>(
      'GET',
      `/api/calendar/hourly?dates=${dates.join(',')}&bots=${bots.join(',')}&live=${liveOnly ? 1 : 0}&tf=${tf}`,
    ),
  days: (from: string, to: string, bots: number[], liveOnly: boolean, tf: Timeframe | '' = '') =>
    call<DayBucket[]>('GET', `/api/calendar/days?from=${from}&to=${to}&bots=${bots.join(',')}&live=${liveOnly ? 1 : 0}&tf=${tf}`),
};
