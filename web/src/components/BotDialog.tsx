import { useMemo, useState, type FormEvent } from 'react';
import type { Bot, ParamSpec, StrategyInfo, Timeframe } from '../../../shared/types.ts';
import { TF_LABEL, TIMEFRAMES } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { money } from '../format.ts';
import { useFleet } from '../store.tsx';

type ParamValues = Record<string, number | boolean | string>;

function Modal({ title, wide, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="btn sm icon ghost" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.6">
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export { Modal };

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="box" />
      <span>{children}</span>
    </label>
  );
}

function ParamField({ spec, value, onChange }: { spec: ParamSpec; value: ParamValues[string]; onChange: (v: ParamValues[string]) => void }) {
  if (spec.type === 'bool') {
    return (
      <div className="field">
        <Check checked={!!value} onChange={onChange}>
          {spec.label}
        </Check>
        {spec.hint && <span className="hint">{spec.hint}</span>}
      </div>
    );
  }
  if (spec.type === 'select') {
    return (
      <label className="field">
        <span className="label">{spec.label}</span>
        <select className="select" value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {spec.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="field">
      <span className="label">{spec.label}</span>
      <input
        className="input mono"
        type="number"
        value={String(value)}
        min={spec.min}
        max={spec.max}
        step={spec.step ?? 1}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
      {spec.hint && <span className="hint">{spec.hint}</span>}
    </label>
  );
}

function MoneyInput({ value, onChange, min = 1 }: { value: number | ''; onChange: (v: number | '') => void; min?: number }) {
  return (
    <div className="input-wrap">
      <span className="affix pre">$</span>
      <input className="input mono has-pre" type="number" min={min} step="0.5" value={value} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
    </div>
  );
}

/** Stakes a martingale would place on consecutive losses before it resets. */
function ladder(base: number, mult: number, resetAfter: number) {
  const steps = resetAfter > 0 ? resetAfter : 7;
  const out: number[] = [];
  let s = base;
  for (let i = 0; i < steps; i++) {
    out.push(Math.round(s * 100) / 100);
    s *= mult;
  }
  return out;
}

const defaults = (s?: StrategyInfo): ParamValues => Object.fromEntries((s?.params ?? []).map((p) => [p.key, p.default]));

interface Props {
  bot?: Bot; // edit mode when set
  onClose: () => void;
}

export function BotDialog({ bot, onClose }: Props) {
  const { strategies, upsert, refresh, toast } = useFleet();
  const inverse = !!bot?.mirrorOf;
  const editing = !!bot;
  const [strategyId, setStrategyId] = useState(bot?.strategy ?? strategies[0]?.id ?? '');
  const strategy = strategies.find((s) => s.id === strategyId);
  const [name, setName] = useState(bot?.name ?? strategy?.name ?? '');
  const [nameTouched, setNameTouched] = useState(editing);
  const [params, setParams] = useState<ParamValues>(bot?.params ?? defaults(strategy));
  const [startBalance, setStartBalance] = useState<number | ''>(bot?.startBalance ?? 100);
  const [lot, setLot] = useState<number | ''>(bot?.baseLot ?? 5);
  const [entry, setEntry] = useState<number | ''>(bot ? Math.round(bot.maxEntryPrice * 100) : 60);
  const [mgOn, setMgOn] = useState(bot?.martingale.enabled ?? false);
  const [mult, setMult] = useState<number | ''>(bot?.martingale.multiplier ?? 2);
  const [resetAfter, setResetAfter] = useState<number | ''>(bot?.martingale.resetAfter ?? 4);
  const [tf, setTf] = useState<Timeframe>(bot?.timeframe ?? '1h');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const steps = useMemo(() => ladder(Number(lot) || 0, Number(mult) || 1, Number(resetAfter) || 0), [lot, mult, resetAfter]);
  const worstRun = steps.reduce((a, b) => a + b, 0);
  const bal = Number(editing ? bot!.balance : startBalance) || 0;

  function pickStrategy(id: string) {
    const s = strategies.find((x) => x.id === id);
    setStrategyId(id);
    setParams(defaults(s));
    if (!nameTouched && s) setName(s.name);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!(Number(lot) >= 1)) return setError('Lot per trade must be at least $1.');
    if (!editing && !(Number(startBalance) >= 5)) return setError('Starting balance must be at least $5.');
    if (!(Number(entry) >= 5 && Number(entry) <= 95)) return setError('Max entry price must be between 5¢ and 95¢.');
    if (mgOn && !(Number(mult) >= 1.1 && Number(mult) <= 5)) return setError('Multiplier must be between 1.1 and 5.');
    if (mgOn && !(Number(resetAfter) >= 0 && Number(resetAfter) <= 20)) return setError('Reset after must be 0 to 20 losses.');
    for (const spec of strategy?.params ?? []) {
      if ((spec.type === 'int' || spec.type === 'float') && params[spec.key] === '') return setError(`Set a value for ${spec.label}.`);
    }
    const martingale = { enabled: mgOn, multiplier: Number(mult) || 2, resetAfter: Number(resetAfter) || 0 };
    setBusy(true);
    try {
      if (editing) {
        upsert(await api.updateBot(bot!.id, { name, params, baseLot: Number(lot), maxEntryPrice: Number(entry) / 100, martingale }));
        toast('Settings saved');
        if (!bot!.mirrorOf) refresh();
      } else {
        const created = await api.createBot({
          name,
          strategy: strategyId,
          timeframe: tf,
          params,
          startBalance: Number(startBalance),
          baseLot: Number(lot),
          maxEntryPrice: Number(entry) / 100,
          martingale,
          backfillDays: 0,
        });
        upsert(created);
        await refresh(); // picks up its inverse twin
        toast(`“${created.name}” is running`);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? `Settings · ${bot!.name}` : 'New bot'} wide={!editing} onClose={onClose}>
      <form onSubmit={submit} style={{ display: 'contents' }}>
        <div className="dialog-body">
          {!editing && (
            <>
              <div className="section-title label">Market</div>
              <div className="seg">
                {TIMEFRAMES.map((t) => (
                  <button type="button" key={t} className={tf === t ? 'on' : ''} onClick={() => setTf(t)}>
                    BTC {TF_LABEL[t]}
                  </button>
                ))}
              </div>
              <div className="section-title label">Strategy</div>
              <div className="strategy-list">
                {strategies.map((s) => (
                  <button type="button" key={s.id} className={`strategy-opt ${s.id === strategyId ? 'on' : ''}`} onClick={() => pickStrategy(s.id)}>
                    <div className="n">{s.name}</div>
                    <div className="f">{s.family}</div>
                  </button>
                ))}
              </div>
              {strategy && <div className="callout">{strategy.summary}</div>}
            </>
          )}

          <div className="section-title label">Bot</div>
          <div className="field-row">
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span className="label">Name</span>
              <input className="input" value={name} maxLength={40} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} required />
            </label>
            {!editing && (
              <label className="field">
                <span className="label">Starting balance</span>
                <MoneyInput value={startBalance} onChange={setStartBalance} min={5} />
              </label>
            )}
            <label className="field">
              <span className="label">Lot per trade</span>
              <MoneyInput value={lot} onChange={setLot} />
            </label>
            {!inverse && (
              <label className="field">
                <span className="label">Max entry price</span>
                <div className="input-wrap">
                  <input className="input mono" type="number" min={5} max={95} value={entry} onChange={(e) => setEntry(e.target.value === '' ? '' : Number(e.target.value))} />
                  <span className="affix post">¢</span>
                </div>
              </label>
            )}
          </div>
          <span className="hint muted" style={{ fontSize: 12, marginTop: -8 }}>
            {inverse
              ? 'An inverse bot takes the opposite side of every trade its original takes, at the live Polymarket order book, with no price limit of its own. A winning share pays $1; Polymarket\'s crypto taker fee is added.'
              : 'The bot buys at the live Polymarket order book when the window opens. If a share costs more than the max entry price, it skips that window. A winning share pays $1; Polymarket\'s crypto taker fee is added.'}
          </span>

          <div className="section-title label">Martingale</div>
          <div className="mg-box">
            <Check checked={mgOn} onChange={setMgOn}>
              Raise the stake after each loss
            </Check>
            {mgOn && (
              <>
                <div className="field-row">
                  <label className="field">
                    <span className="label">Multiplier</span>
                    <div className="input-wrap">
                      <input className="input mono" type="number" min={1.1} max={5} step={0.1} value={mult} onChange={(e) => setMult(e.target.value === '' ? '' : Number(e.target.value))} />
                      <span className="affix post">×</span>
                    </div>
                  </label>
                  <label className="field">
                    <span className="label">Reset to base after</span>
                    <div className="input-wrap">
                      <input className="input mono" type="number" min={0} max={20} value={resetAfter} onChange={(e) => setResetAfter(e.target.value === '' ? '' : Number(e.target.value))} />
                      <span className="affix post">losses</span>
                    </div>
                    <span className="hint">0 = only a win resets it.</span>
                  </label>
                </div>
                <div className="field">
                  <span className="label">Stake ladder</span>
                  <div className="ladder">
                    {steps.map((s, i) => (
                      <span key={i}>
                        L{i}: {money(s)}
                      </span>
                    ))}
                    {!Number(resetAfter) && <span>…</span>}
                  </div>
                </div>
                {worstRun > bal && (
                  <div className="callout warn">
                    A full losing run needs {money(worstRun)}, more than the {money(bal)} balance. Stakes get capped by what's left.
                  </div>
                )}
              </>
            )}
          </div>

          {inverse && (
            <div className="callout">
              This is an inverse bot. It runs the original bot's rule with the original's settings and buys the opposite side in the same
              window. Change the rule on the original; lot, max price and martingale here are its own.
            </div>
          )}
          {!inverse && strategy && strategy.params.length > 0 && (
            <>
              <div className="section-title label">Rule settings</div>
              <div className="field-row">
                {strategy.params.map((p) => (
                  <ParamField key={p.key} spec={p} value={params[p.key] ?? p.default} onChange={(v) => setParams((prev) => ({ ...prev, [p.key]: v }))} />
                ))}
              </div>
            </>
          )}

          {error && <div className="error">{error}</div>}
        </div>
        <div className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !strategyId}>
            {busy ? 'Saving…' : editing ? 'Save settings' : 'Start bot'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ResetDialog({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const { upsert, toast } = useFleet();
  const [start, setStart] = useState<number | ''>(bot.startBalance);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function go() {
    if (!(Number(start) >= 5)) return setError('Starting balance must be at least $5.');
    setBusy(true);
    try {
      upsert(await api.botAction(bot.id, 'reset', { startBalance: Number(start), backfillDays: 0 }));
      toast(`“${bot.name}” reset`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reset failed');
      setBusy(false);
    }
  }
  return (
    <Modal title={`Reset · ${bot.name}`} onClose={onClose}>
      <div className="dialog-body">
        <div className="callout warn">This deletes all {bot.stats.trades + bot.stats.open} trades of this bot and starts it over. Settings are kept.</div>
        <label className="field">
          <span className="label">Starting balance</span>
          <MoneyInput value={start} onChange={setStart} min={5} />
        </label>
        {error && <div className="error">{error}</div>}
      </div>
      <div className="dialog-foot">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn danger" onClick={go} disabled={busy}>
          {busy ? 'Resetting…' : 'Reset bot'}
        </button>
      </div>
    </Modal>
  );
}
