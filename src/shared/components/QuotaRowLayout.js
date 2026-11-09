// Keep identity, meter and reset on one compact row at card width.
export default function QuotaRowLayout({ leading, identity, measurement, reset, actions, children }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-x-2 border-b border-border-subtle py-1 text-xs">
    {leading}
    <div className="min-w-0 w-[clamp(8rem,30%,14rem)] shrink-0 overflow-hidden">{identity}</div>
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="min-w-0 flex-1">{measurement}</div>
      {reset && <div className="max-w-[46%] shrink-0 truncate text-right text-text-muted">{reset}</div>}
    </div>
    {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    {children}
  </div>;
}
