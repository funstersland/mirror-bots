import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Bot, Candle, FeedStatus, StrategyInfo } from '../../shared/types.ts';
import { api } from './api.ts';

interface Fleet {
  bots: Bot[] | null;
  strategies: StrategyInfo[];
  feed: (FeedStatus & { candles24: Candle[] }) | null;
  refresh: () => Promise<void>;
  upsert: (bot: Bot) => void;
  remove: (id: number) => void;
  toast: (msg: string, err?: boolean) => void;
}

const Ctx = createContext<Fleet | null>(null);

export function FleetProvider({ children }: { children: ReactNode }) {
  const [bots, setBots] = useState<Bot[] | null>(null);
  const [strategies, setStrategies] = useState<StrategyInfo[]>([]);
  const [feed, setFeed] = useState<Fleet['feed']>(null);
  const [toastMsg, setToast] = useState<{ msg: string; err: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(async () => {
    const [b, f] = await Promise.all([api.bots(), api.feed()]);
    setBots(b);
    setFeed(f);
  }, []);

  useEffect(() => {
    api.strategies().then(setStrategies).catch(() => {});
    refresh().catch(() => {});
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refresh().catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  const upsert = useCallback((bot: Bot) => {
    setBots((prev) => {
      if (!prev) return [bot];
      const i = prev.findIndex((b) => b.id === bot.id);
      if (i < 0) return [...prev, bot];
      const next = prev.slice();
      next[i] = { ...bot, openTrade: bot.openTrade ?? prev[i].openTrade };
      return next;
    });
  }, []);

  const remove = useCallback((id: number) => setBots((prev) => prev?.filter((b) => b.id !== id) ?? null), []);

  const toast = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  return (
    <Ctx.Provider value={{ bots, strategies, feed, refresh, upsert, remove, toast }}>
      {children}
      {toastMsg && <div className={`toast ${toastMsg.err ? 'err' : ''}`} role="status">{toastMsg.msg}</div>}
    </Ctx.Provider>
  );
}

export function useFleet() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useFleet outside FleetProvider');
  return v;
}
