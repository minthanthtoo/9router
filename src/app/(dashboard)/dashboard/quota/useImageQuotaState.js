"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { imageManualPolicy, imagePolicyKey, imagePolicyReceiptMatches } from "./imagePolicyCommand.mjs";

import useImageTestRunner from "./useImageTestRunner";

const REFRESH_MS = 60_000;
const SUPPORTED_PROVIDERS = new Set(["all", "antigravity", "codex", "gemini"]);

function newIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getErrorMessage(data, fallback) {
  return data?.error?.message || fallback;
}


export default function useImageQuotaState(model = "", provider = "all", modelProvider = "") {
  const [projection, setProjection] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [catalogError, setCatalogError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [policyError, setPolicyError] = useState("");
  const [drafts, setDrafts] = useState({});
  const [notice, setNotice] = useState("");
  const [busyId, setBusyId] = useState(null);
  const requestSequence = useRef(0);
  const busyRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/private/image-quota/v1?view=capabilities", { cache: "no-store", signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok || !Array.isArray(data.models)) throw new Error(); return data.models; })
      .then(setCatalog)
      .catch(error => { if (error.name !== "AbortError") setCatalogError("Model catalog unavailable. Refresh the page to retry."); });
    return () => controller.abort();
  }, []);

  const fetchStatus = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setRefreshing(true);
    const sequence = ++requestSequence.current;
    try {
      const query = new URLSearchParams({ provider });
      if (model.trim()) query.set("model", model.trim());
      if (model.trim() && modelProvider) query.set("model_provider", modelProvider);
      const response = await fetch(`/api/private/image-quota/v1?${query.toString()}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(getErrorMessage(data, "Image quota status is unavailable."));
      if (sequence === requestSequence.current) {
        setProjection(data);
        setError("");
      }
      return data;
    } catch (fetchError) {
      if (sequence === requestSequence.current) {
        setError(fetchError?.message || "Image quota status is unavailable.");
      }
      return null;
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [model, modelProvider, provider]);

  useEffect(() => {
    if (!SUPPORTED_PROVIDERS.has(provider)) {
      setProjection(null);
      setLoading(false);
      setError("");
      return undefined;
    }
    setLoading(true);
    setProjection(null);
    fetchStatus({ quiet: true });
    const interval = setInterval(() => fetchStatus({ quiet: true }), REFRESH_MS);
    return () => {
      clearInterval(interval);
      requestSequence.current += 1;
    };
  }, [fetchStatus, provider]);


  const tests = useImageTestRunner(fetchStatus, projection?.rows || []);

  const togglePolicy = async (row, model = null, desiredAction = null) => {
    const key = imagePolicyKey(row.connectionId, model);
    if (busyRef.current) return {ok:false,unknown:false};
    const pending = drafts[key];
    if (Object.entries(drafts).some(([other, draft]) => other !== key && draft.outcomeUnknown)) {
      setPolicyError("Resolve the unconfirmed switch before changing another.");
      return {ok:false,unknown:true};
    }
    const action = desiredAction || (imageManualPolicy(row, model).state === "paused" ? "resume" : "pause");
    const draft = pending?.outcomeUnknown ? pending : {
      idempotencyKey: newIdempotencyKey(),
      payload: { connectionId: row.connectionId, ...(model ? { model } : {}), action,
        reason: `Operator ${action} from image controls`, expectedRevision: imageManualPolicy(row, model).revision || 0 },
    };
    busyRef.current = key;
    setBusyId(key);
    setDrafts(current => ({ ...current, [key]: draft }));
    setNotice("");
    setPolicyError("");
    let outcomeUnknown = true;
    let result={ok:false,unknown:true};
    try {
      const response = await fetch("/api/private/image-quota/v1", {
        method: "PATCH", signal: AbortSignal.timeout(15_000), headers: { "Content-Type": "application/json", "Idempotency-Key": draft.idempotencyKey },
        body: JSON.stringify(draft.payload),
      });
      outcomeUnknown = response.status >= 500;
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(response.status === 409
        ? "This policy changed. Review the refreshed switch and try again."
        : getErrorMessage(data, "The image switch could not be saved."));
      if (!imagePolicyReceiptMatches(data.receipt, row, model, draft.payload)) {
        outcomeUnknown = true;
        throw new Error("Save unconfirmed. Retry this switch to read the original result.");
      }
      setDrafts(current => { const next = { ...current }; delete next[key]; return next; });
      result={ok:true,unknown:false};
      setNotice(`${model || "All images"} ${draft.payload.action === "pause" ? "disabled" : "enabled"}.`);
    } catch (failure) {
      result={ok:false,unknown:outcomeUnknown};
      setDrafts(current => { const next = { ...current }; if (outcomeUnknown) next[key] = { ...draft, outcomeUnknown: true }; else delete next[key]; return next; });
      setPolicyError(failure.message || "Save unconfirmed. Retry this switch.");
    } finally {
      await fetchStatus({ quiet: true });
      busyRef.current = null;
      setBusyId(null);
    }
    return result;
  };

  return { tests, projection, catalog, catalogError, loading, refreshing, error: policyError || error, drafts, notice, busyId, fetchStatus, togglePolicy, model, modelProvider, provider };
}
