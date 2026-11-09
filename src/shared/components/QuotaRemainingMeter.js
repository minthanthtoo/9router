// The same remaining-allowance scale and colors used on account quota cards.
export function quotaRemainingColors(value) {
  return value > 70 ? { text: 'text-green-600 dark:text-green-400', bg: 'bg-green-500', bgLight: 'bg-green-500/10', emoji: '🟢' }
    : value >= 30 ? { text: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-500', bgLight: 'bg-yellow-500/10', emoji: '🟡' }
    : { text: 'text-red-600 dark:text-red-400', bg: 'bg-red-500', bgLight: 'bg-red-500/10', emoji: '🔴' };
}
export default function QuotaRemainingMeter({ value, label, compact = false }) {
  const colors = quotaRemainingColors(value);
  return <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.max(0, Math.min(value, 100))} aria-valuetext={`${value}% remaining`} className={`${compact ? 'h-1' : 'h-1.5'} rounded-full overflow-hidden border ${colors.bgLight} ${value === 0 ? 'border-black/10 dark:border-white/10' : 'border-transparent'}`}>
    <div className={`h-full transition-all duration-300 motion-reduce:transition-none ${colors.bg}`} style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} />
  </div>;
}
