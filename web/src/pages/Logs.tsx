import { useEffect, useMemo, useRef, useState } from 'react';
import { useLogs } from '../lib/live';
import { cx, Panel } from '../components/ui';
import { FilterTabs } from './Positions';

const LEVEL_TONE: Record<string, string> = { warn: 'text-warn', error: 'text-loss', fatal: 'text-loss', info: 'text-muted', debug: 'text-faint' };

export function LogsPage() {
  const logs = useLogs();
  const [level, setLevel] = useState<'all' | 'warn'>('all');
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return logs.filter(
      (l) =>
        (level === 'all' || ['warn', 'error', 'fatal'].includes(l.level)) &&
        (!needle || `${l.module ?? ''} ${l.msg} ${l.extra ? JSON.stringify(l.extra) : ''}`.toLowerCase().includes(needle)),
    );
  }, [logs, level, q]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  return (
    <Panel
      title={`Logs · last ${logs.length}`}
      flush
      action={
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" aria-label="Filter logs" className="!py-1 text-[12.5px]" />
          <FilterTabs value={level} onChange={setLevel} options={[['all', 'All'], ['warn', 'Warnings']]} />
        </div>
      }
    >
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className="num h-[calc(100vh-220px)] min-h-[300px] overflow-auto px-4 py-2 text-[12px] leading-relaxed"
      >
        {shown.map((l, i) => (
          <div key={i} className="flex gap-3 whitespace-pre-wrap">
            <span className="shrink-0 text-faint">{new Date(l.time).toLocaleTimeString('en-GB', { hour12: false })}</span>
            <span className={cx('w-11 shrink-0 uppercase', LEVEL_TONE[l.level])}>{l.level}</span>
            {l.module && <span className="w-16 shrink-0 text-faint">{l.module}</span>}
            <span className={cx('min-w-0 break-words', l.level === 'error' || l.level === 'fatal' ? 'text-loss' : l.level === 'warn' ? 'text-warn' : '')}>
              {l.msg}
              {l.extra && <span className="text-faint"> {JSON.stringify(l.extra)}</span>}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
