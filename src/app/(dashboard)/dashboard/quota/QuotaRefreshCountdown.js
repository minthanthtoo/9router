"use client";
import { useEffect, useState } from "react";

export default function QuotaRefreshCountdown({ active, resetKey, seconds = 60 }) {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    setRemaining(seconds);
    if (!active) return;
    let timer;
    const schedule = () => {
      clearInterval(timer);
      if (!document.hidden) timer = setInterval(() => setRemaining(value => value <= 1 ? seconds : value - 1), 1000);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", schedule); };
  }, [active, resetKey, seconds]);
  return <span className="text-[10px] text-text-muted tabular-nums">({remaining}s)</span>;
}
