"use client";
import { useMemo, useState } from "react";

export default function QuotaCardInteraction({ children }) {
  const [tray, setTray] = useState(null), [chart, setChart] = useState(null);
  const interaction = useMemo(() => ({ tray, setTray, chart, setChart }), [tray, chart]);
  return children(interaction);
}
