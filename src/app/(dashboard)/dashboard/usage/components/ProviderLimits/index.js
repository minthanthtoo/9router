"use client";
import {quotaDisplayTransition} from "@/shared/utils/quotaDisplayTransition";
import { emptyRotation, rotationMetrics, availabilityGrouping } from "@/shared/utils/rotationSequence.mjs";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import QuotaSortBar from "@/shared/components/QuotaSortBar";
import ResetPriorityControl from "@/shared/components/ResetPriorityControl";
import QuotaSequencePublish from "@/shared/components/QuotaSequencePublish";
import ProviderIcon from "@/shared/components/ProviderIcon";
import QuotaTable from "./QuotaTable";
import QuotaCardInteraction from "../../../quota/QuotaCardInteraction";
import QuotaRefreshCountdown from "../../../quota/QuotaRefreshCountdown";
import QuotaCardActions from "@/shared/components/QuotaCardActions";
import useImageQuotaState from "../../../quota/useImageQuotaState";
import ImageAccountCard from "../../../quota/ImageAccountCard";
import ImageManagementDialog from "../../../quota/ImageManagementDialog";
import ImageModelSelector from "../../../quota/ImageModelSelector";
import QuotaProviderSelector from "../../../quota/QuotaProviderSelector";
import QuotaControlDock from "../../../quota/QuotaControlDock";
import {availabilityQuotaSegments,toggleQuotaPin} from "../../../quota/quotaPins.mjs";
import QuotaSegmentBar from "../../../quota/QuotaSegmentBar";
import QuotaCardPin from "../../../quota/QuotaCardPin";
import QuotaCardDetailsOverlay from "../../../quota/QuotaCardDetailsOverlay";
import ImagePolicyToggle from "../../../quota/ImagePolicyToggle";
import TextModelRows from "../../../quota/TextModelRows";
import { cardGroupVisible, cardModelVisible, setCardGroupVisible, setCardModelVisible, setSharedCardGroupVisible, setAllCardSectionsVisible, selectedCardModels } from "../../../quota/quotaCardDisplay.mjs";
import { QUOTA_MODEL_CATEGORIES, quotaModelMatchesCategory } from "@/shared/utils/quotaModelCatalog.mjs";
import Toggle from "@/shared/components/Toggle";
import Tooltip from "@/shared/components/Tooltip";
import {
  parseQuotaData,
  areAllReportedQuotasDepleted,
  hasReportedQuotaAvailable,
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  setSharedQuotaVisibility,
  getConnectionLabel,
  segmentVisibleConnections,
  quotaSegmentScrollTop,
  quotaActiveSegmentIndex,
  buildLoadingState,
  filterQuotaStateByConnections,
  getPageSizeLabel,
  getConnectionsPaginationSummary,
  getSafePagination,
  getSafeTotals,
  shouldResetPage,
  getPaginationPageValue,
  getProviderOptions,
  reconcileConnectionsPage,
  getQuotaCache,
  setQuotaCache,
  QUOTA_CACHE_KEY,
  REFRESH_INTERVAL_MS,
  CLAUDE_REFRESH_INTERVAL_MS,
  AUTO_REFRESH_STORAGE_KEY,
  CONNECTIONS_PAGE_SIZE,
  ACCOUNT_PAGE_SIZE_OPTIONS,
  ACCOUNT_PAGE_SIZE_MAX,
  ACCOUNT_FILTER_OPTIONS,
  QUOTA_SORT_OPTIONS,
  updateQuotaRotationPreview,
} from "./utils";
import Card from "@/shared/components/Card";
import { ConfirmModal, EditConnectionModal } from "@/shared/components";
import AutoPingScheduleModal from "@/app/(dashboard)/dashboard/providers/[id]/AutoPingScheduleModal";
import { USAGE_SUPPORTED_PROVIDERS, AI_PROVIDERS } from "@/shared/constants/providers";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

// Maps the stored providerSpecificData.authMethod to a human label for Kiro.
// Values come from the Kiro connect flows: builder-id/idc (device code),
// google/github (social), imported (refresh-token paste), api_key (headless).
const KIRO_METHOD_LABELS = {
  "builder-id": "AWS Builder ID",
  idc: "IAM Identity Center",
  google: "Google",
  github: "GitHub",
  imported: "Imported Token",
  api_key: "API Key",
};

const AUTO_PING_SETTINGS_KEYS = {
  claude: "claudeAutoPing",
  codex: "codexAutoPing",
};

function kiroMethodLabel(conn) {
  const m = conn.providerSpecificData?.authMethod;
  if (m && KIRO_METHOD_LABELS[m]) return KIRO_METHOD_LABELS[m];
  return conn.authType === "api_key" ? "API Key" : "OAuth";
}

function getConnectionSecondaryLabel(connection) {
  if (connection.name?.trim() && connection.email?.trim() && connection.name.trim() !== connection.email.trim()) {
    return connection.email.trim();
  }

  if (connection.name?.trim() && connection.displayName?.trim() && connection.name.trim() !== connection.displayName.trim()) {
    return connection.displayName.trim();
  }

  return null;
}

// Region is stored for builder-id/idc/api_key flows; social and imported flows
// omit it, so fall back to the region segment of the profileArn
// (arn:aws:codewhisperer:<region>:...).
function kiroRegion(conn) {
  const r = conn.providerSpecificData?.region;
  if (r) return r;
  const arn = conn.providerSpecificData?.profileArn;
  const seg = typeof arn === "string" ? arn.split(":")[3] : "";
  return seg || "";
}

function getCodexResetCreditCount(quota) {
  const value = quota?.raw?.resetCredits?.availableCount;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

const CLAUDE_RESET_LIMIT_NAMES = {
  five_hour: "session",
  seven_day: "weekly",
  seven_day_overage_included: "weekly",
  seven_day_opus: "Opus weekly",
  seven_day_sonnet: "Sonnet weekly",
};

function formatClaudeResetClears(clears) {
  const names = [...new Set((clears || []).map((c) => CLAUDE_RESET_LIMIT_NAMES[c]).filter(Boolean))];
  return names.length ? `${names.join(" + ")} limits` : "limits";
}

function claudeGrantStatus(grant) {
  if (grant.resetsLeft <= 0) return "used";
  if (grant.paused) return "paused";
  if (grant.endsAt && new Date(grant.endsAt).getTime() <= Date.now()) return "expired";
  if (grant.usableNow) return "usable now";
  if (grant.startsAt && new Date(grant.startsAt).getTime() > Date.now()) return "not started";
  return grant.useRequiresLimit ? "at limit only" : "unavailable";
}

function providerLabel(providerId) {
  return AI_PROVIDERS[providerId]?.name || providerId;
}

function formatCreditDate(value) {
  if (!value) return "N/A";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "N/A";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimeRemaining(value) {
  if (!value) return "N/A";
  const diffMs = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return "N/A";
  if (diffMs <= 0) return "Expired";
  const totalHours = Math.ceil(diffMs / (60 * 60 * 1000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

export default function ProviderLimits() {
  const { copied, copy } = useCopyToClipboard();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [imageModel, setImageModel] = useState(() => searchParams?.get("model") || "");
  const [imageModelProvider, setImageModelProvider] = useState(() => searchParams?.get("model_provider") || "");
  const [imageModelCategory, setImageModelCategory] = useState(() => searchParams?.get("category") || "all");
  const [quotaCatalog, setQuotaCatalog] = useState([]);
  const selectedModelInfo = quotaCatalog.find(item => item.id === imageModel);
  const [modelSectionVisible,setModelSectionVisible]=useState(true);
  useEffect(()=>setModelSectionVisible(true),[imageModel]);
  const imageSelection = Boolean(imageModel && selectedModelInfo?.kind === "image");
  const imageState = useImageQuotaState(imageSelection ? imageModel : "", "all", imageSelection ? imageModelProvider : "");
  const imageCardState = { ...imageState, modelCategory: imageModelCategory, hideImageControls: imageModelCategory.startsWith("text") || Boolean(imageModel && !imageSelection) };
  const imageRows = useMemo(() => new Map((imageState.projection?.rows || []).map((row) => [row.connectionId, row])), [imageState.projection]);
  useEffect(() => {
    setImageModel(searchParams?.get("model") || "");
    setImageModelProvider(searchParams?.get("model_provider") || "");
    setImageModelCategory(searchParams?.get("category") || "all");
  }, [searchParams]);
  const changeImageModel = (value, provider = "") => {
    setPage(1);
    setImageModel(value);
    setImageModelProvider(value ? provider : "");
    const params = new URLSearchParams(searchParams?.toString() || "");
    const target = quotaCatalog.find(item => item.id === value) || (imageState.catalog.some(item=>item.id===value) ? { kind: "image" } : null);
    if (value && target && !quotaModelMatchesCategory(target,imageModelCategory)) { setImageModelCategory("all");params.delete("category"); }
    if (value) params.set("model", value); else params.delete("model");
    if (value && provider) params.set("model_provider", provider); else params.delete("model_provider");
    router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false });
  };
  const [connections, setConnections] = useState([]);
  const [loadedConnectionScope, setLoadedConnectionScope] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const connectionRequest = useRef(0);
  const [quotaData, setQuotaData] = useState({});
  const [loading, setLoading] = useState({});
  const [errors, setErrors] = useState({});
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [autoPingConfigs, setAutoPingConfigs] = useState({ claude: {}, codex: {} });
  const [scheduleConnection, setScheduleConnection] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hasHydratedAutoRefresh, setHasHydratedAutoRefresh] = useState(false);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshCycle, setRefreshCycle] = useState(0);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [deletingId, setDeletingId] = useState(null);
  const [togglingId, setTogglingId] = useState(null);
  const [resettingLimitId, setResettingLimitId] = useState(null);
  const [resetConfirmState, setResetConfirmState] = useState(null);
  const [resetCreditsState, setResetCreditsState] = useState(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState(null);
  const [imageAccountSettingsError, setImageAccountSettingsError] = useState("");
  const [focusGeminiProject, setFocusGeminiProject] = useState(false);
  const openImageAccountSettings = useCallback(async (row) => {
    setImageAccountSettingsError("");
    setFocusGeminiProject(row.provider === "gemini" && row.routeState === "identity_required");
    try {
      let connection = connections.find((item) => item.id === row.connectionId);
      if (!connection) {
        const response = await fetch(`/api/providers/${encodeURIComponent(row.connectionId)}`, { cache: "no-store" });
        if (!response.ok) throw new Error("not_found");
        connection = (await response.json())?.connection;
      }
      if (!connection || connection.id !== row.connectionId || connection.provider !== row.provider) throw new Error("mismatch");
      setSelectedConnection(connection);
      setShowEditModal(true);
    } catch {
      setImageAccountSettingsError("Account settings could not be opened. Refresh the provider list and try again.");
    }
  }, [connections]);
  const [proxyPools, setProxyPools] = useState([]);
  // Initialize providerFilter from URL ?provider= param so the page
  // can be bookmarked / deep-linked to a specific provider (#4217).
  const [providerFilter, _setProviderFilter] = useState(
    () => searchParams?.get("provider") || "all"
  );
  // Wrapper: keeps URL in sync with the selected provider so the view can be
  // bookmarked. Replaces the URL without adding to browser history.
  const setProviderFilter = useCallback((value) => {
    _setProviderFilter(value);
    const clearModel = Boolean(imageModel && imageModelProvider && value !== "all" && imageModelProvider !== value);
    if (clearModel) {
      setImageModel("");
      setImageModelProvider("");
    }
    try {
      const params = new URLSearchParams(searchParams?.toString() || "");
      if (value === "all") {
        params.delete("provider");
      } else {
        params.set("provider", value);
      }
      if (clearModel) {
        params.delete("model");
        params.delete("model_provider");
      }
      const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
      router.replace(newUrl, { scroll: false });
    } catch { /* non-fatal: URL sync is best-effort */ }
  }, [imageModel, imageModelProvider, pathname, router, searchParams]);
  const [providerOptions, setProviderOptions] = useState([]);
  const [accountFilter, setAccountFilter] = useState("all");
  const [quotaSorts, setQuotaSorts] = useState([]);
  const [groupAvailability,setGroupAvailability] = useState(true);
  const [resetPriority,setResetPriority] = useState({enabled:false,days:3,weeklyBelow:null});
  const [rotationPreview, setRotationPreview] = useState(null);
  const [providerSequence,setProviderSequence]=useState(null);
  const imageManagement = useRef(null);
  useEffect(()=>{
    if(providerFilter === "all"||!rotationMetrics(providerFilter).length){setProviderSequence(null);setRotationPreview(null);return;}
    const controller=new AbortController();
    fetch(`/api/providers/${encodeURIComponent(providerFilter)}/rotation?summary=1&model=${encodeURIComponent(imageModel)}`,{cache:"no-store",signal:controller.signal}).then(async response=>{if(!response.ok)throw Error();return response.json();}).then(data=>{if(controller.signal.aborted)return;setProviderSequence({provider:providerFilter,policy:data.effectivePolicy||data.policy});setQuotaSorts((data.effectivePolicy||data.policy)?.sorts||[]);setGroupAvailability((data.effectivePolicy||data.policy)?.groupAvailability!==false);setResetPriority((data.effectivePolicy||data.policy)?.resetPriority||{enabled:false,days:3,weeklyBelow:null});setRotationPreview(null);}).catch(error=>{if(error.name!=="AbortError")setConnectionError("Saved provider sequence unavailable. Refresh to retry.");});
    return()=>controller.abort();
  },[providerFilter,imageModel]);
  const [serverRotationSegments, setServerRotationSegments] = useState(null);
  const [resetSummary,setResetSummary] = useState(null);
  const [resetReadError,setResetReadError] = useState("");
  const resetListing = resetPriority.enabled && (providerFilter === "all" || providerFilter === "codex");
  useEffect(()=>{if(providerSequence?.provider===providerFilter)setRotationPreview({...providerSequence,model:imageModel});},[providerSequence,providerFilter,imageModel]);
  const rotationScope = rotationPreview?.provider === providerFilter ? JSON.stringify(rotationPreview) : "";
  const quotaRoot = useRef(null), quotaToolbar = useRef(null), quotaGrid = useRef(null);
  const [controlsDocked,setControlsDocked]=useState(false);
  const [pinnedCards,setPinnedCards]=useState([]);
  const pinRects=useRef(new Map()),pinMotion=useRef(false),pinFocus=useRef(null);
  useEffect(()=>{try{const saved=JSON.parse(localStorage.getItem("quota-pinned-cards-v1")||"[]");if(Array.isArray(saved))setPinnedCards(saved.filter(id=>typeof id==="string"));}catch{}},[]);
  const togglePin=id=>{
    pinRects.current=new Map(Array.from(quotaGrid.current?.querySelectorAll('[data-quota-id]')||[],card=>[card.dataset.quotaId,card.getBoundingClientRect()]));
    pinFocus.current=document.activeElement;
    pinMotion.current=true;setPinnedCards(current=>{const next=toggleQuotaPin(current,id);try{localStorage.setItem("quota-pinned-cards-v1",JSON.stringify(next));}catch{}return next;});};
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(-1);
  const [legacyCardCollapse] = useState({ all: false, overrides: {} });
  const [quotaVisibility, setQuotaVisibility] = useState({});

  const [visibilityReady, setVisibilityReady] = useState(false);
  const [visibilitySaving, setVisibilitySaving] = useState(false);
  const [visibilityError, setVisibilityError] = useState("");
  const visibilityWrite = useRef(false), displayControls = useRef(new Map());
  const [bulkToggling, setBulkToggling] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(CONNECTIONS_PAGE_SIZE);
  const [customPageSizeInput, setCustomPageSizeInput] = useState(
    String(CONNECTIONS_PAGE_SIZE),
  );
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: CONNECTIONS_PAGE_SIZE,
    total: 0,
    totalPages: 1,
  });
  const [totals, setTotals] = useState({
    eligibleConnections: 0,
    providerFilteredConnections: 0,
  });

  const connectionScope = JSON.stringify([providerFilter, accountFilter, imageModel, imageModelProvider, imageModelCategory, page, pageSize, rotationScope, resetListing ? resetPriority : null]);
  const scopePending = loadedConnectionScope !== connectionScope;
  const intervalRef = useRef(null);
  const tickCountRef = useRef(0);

  const fetchConnections = useCallback(
    async (targetPage = page) => {
      const sequence = ++connectionRequest.current;
      try {
        const params = new URLSearchParams({
          page: String(targetPage),
          pageSize: String(pageSize),
          accountStatus: accountFilter,
          includeImageAccounts: "true",
          sort: "priority",
          includeCatalog: "true",
          model: imageModel,
          model_provider: imageModelProvider,
          category: imageModelCategory,
        });

        if (rotationScope) {
          params.set("rotationPolicy", JSON.stringify(rotationPreview.policy));
          params.set("rotationModel", rotationPreview.model);
        }
        if (resetListing && !rotationScope) params.set("resetPriority",JSON.stringify(resetPriority));
        if (providerFilter !== "all") {
          params.set("provider", providerFilter);
        }

        const response = await fetch(
          `/api/providers/client?${params.toString()}`,
        );
        if (!response.ok) throw new Error("Failed to fetch connections");

        const data = await response.json();
        if (sequence !== connectionRequest.current) return null;
        const connectionList = data.connections || [];
        const nextPagination = getSafePagination(data.pagination, pageSize);
        const nextTotals = getSafeTotals(data.totals, connectionList.length);

        setConnectionError("");
        setConnections(connectionList);
        setServerRotationSegments(data.rotationSegments || null);
        setResetSummary(data.resetPrioritySummary || null);
        setQuotaCatalog(data.modelCatalog || []);
        setLoadedConnectionScope(connectionScope);
        setProviderOptions(getProviderOptions(data.providerOptions));
        setPagination(nextPagination);
        setTotals(nextTotals);
        setPage(getPaginationPageValue(data.pagination, targetPage));
        return connectionList;
      } catch (error) {
        if (sequence !== connectionRequest.current) return null;
        setLoadedConnectionScope(connectionScope);
        setConnectionError("Account and model counts are unavailable. Refresh to retry.");
        setQuotaCatalog([]);
        console.error("Error fetching connections:", error);
        setConnections([]);
        setProviderOptions([]);
        setPagination({ page: 1, pageSize, total: 0, totalPages: 1 });
        setTotals({ eligibleConnections: 0, providerFilteredConnections: 0 });
        return [];
      }
    },
    [accountFilter, page, pageSize, providerFilter, imageModel, imageModelProvider, imageModelCategory, connectionScope, resetListing, resetPriority, rotationPreview?.model, rotationPreview?.policy, rotationScope],
  );

  // Fetch quota for a specific connection
  const fetchQuota = useCallback(async (connectionId, provider, { force = false } = {}) => {
    if (!USAGE_SUPPORTED_PROVIDERS.includes(provider)) {
      setLoading((prev) => ({ ...prev, [connectionId]: false }));
      setQuotaData((prev) => ({ ...prev, [connectionId]: { quotas: [], message: "Provider percentage quota is unreported. Image evidence is shown below." } }));
      return;
    }
    setLoading((prev) => ({ ...prev, [connectionId]: true }));
    setErrors((prev) => ({ ...prev, [connectionId]: null }));

    try {
      console.log(
        `[ProviderLimits] Fetching quota for ${provider} (${connectionId})`,
      );
      const url = `/api/usage/${connectionId}${force ? "?force=1" : ""}`;
      const response = await fetch(url);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || response.statusText;

        // Handle different error types gracefully
        if (response.status === 404) {
          // Connection not found - skip silently
          console.warn(
            `[ProviderLimits] Connection not found for ${provider}, skipping`,
          );
          return;
        }

        if (response.status === 401) {
          // Auth error - show message instead of throwing
          console.warn(
            `[ProviderLimits] Auth error for ${provider}:`,
            errorMsg,
          );
          const quotaEntry = {
            quotas: [],
            message: errorMsg,
          };
          setQuotaData((prev) => ({
            ...prev,
            [connectionId]: quotaEntry,
          }));
          setQuotaCache(connectionId, quotaEntry);
          return;
        }

        throw new Error(`HTTP ${response.status}: ${errorMsg}`);
      }

      const data = await response.json();
      console.log(`[ProviderLimits] Got quota for ${provider}:`, data);

      // Parse quota data using provider-specific parser
      const parsedQuotas = parseQuotaData(provider, data);

      const quotaEntry = {
        quotas: parsedQuotas,
        plan: data.plan || null,
        message: data.message || null,
        raw: data,
        cachedAt: new Date().toISOString(),
      };

      setQuotaData((prev) => ({
        ...prev,
        [connectionId]: quotaEntry,
      }));
      setQuotaCache(connectionId, quotaEntry);
    } catch (error) {
      console.error(
        `[ProviderLimits] Error fetching quota for ${provider} (${connectionId}):`,
        error,
      );
      setErrors((prev) => ({
        ...prev,
        [connectionId]: error.message || "Failed to fetch quota",
      }));
    } finally {
      setLoading((prev) => ({ ...prev, [connectionId]: false }));
    }
  }, []);

  // Refresh quota for a specific provider
  const refreshProvider = useCallback(
    async (connectionId, provider) => {
      await fetchQuota(connectionId, provider, { force: true });
      setLastUpdated(new Date());
    },
    [fetchQuota],
  );

  const handleResetCodexLimit = useCallback(
    async (connectionId, provider) => {
      if ((provider !== "codex" && provider !== "claude") || resettingLimitId) return;

      setResettingLimitId(connectionId);
      setErrors((prev) => ({ ...prev, [connectionId]: null }));

      try {
        const response = provider === "claude"
          ? await fetch(`/api/usage/${connectionId}/claude-reset`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ grantId: quotaData[connectionId]?.raw?.resetCredits?.nextGrantId }),
          })
          : await fetch(`/api/usage/${connectionId}/codex-reset-credits`, { method: "POST" });
        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(result.message || result.error || result.code || "Failed to reset limit");
        }

        await fetchQuota(connectionId, provider, { force: true });
        setLastUpdated(new Date());
      } catch (error) {
        setErrors((prev) => ({ ...prev, [connectionId]: error.message || "Failed to reset limit" }));
      } finally {
        setResettingLimitId(null);
      }
    },
    [fetchQuota, resettingLimitId, quotaData],
  );

  // Claude grants already arrive with the usage read; no extra fetch
  const handleViewClaudeResets = useCallback((connection, resetCredits) => {
    setResetCreditsState({ connection, loading: false, error: null, data: { kind: "claude", ...resetCredits } });
  }, []);

  const handleViewCodexResetCredits = useCallback(async (connection) => {
    setResetCreditsState({ connection, loading: true, error: null, data: null });
    try {
      const response = await fetch(`/api/usage/${connection.id}/codex-reset-credits`, { cache: "no-store" });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || result.message || "Failed to load Codex reset credits");
      }
      const credits = Array.isArray(result.credits) ? [...result.credits] : [];
      credits.sort((a, b) => {
        const aTime = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        const bTime = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY;
        return aTime - bTime;
      });
      setResetCreditsState({ connection, loading: false, error: null, data: { ...result, credits } });
    } catch (error) {
      setResetCreditsState({ connection, loading: false, error: error.message || "Failed to load Codex reset credits", data: null });
    }
  }, []);

  const handleDeleteConnection = useCallback(
    async (id) => {
      if (!confirm("Delete this connection?")) return;
      setDeletingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, { method: "DELETE" });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setLoading((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });
          setErrors((prev) => {
            const next = { ...prev };
            delete next[id];
            return next;
          });

          if (typeof window !== "undefined") {
            try {
              const cache = getQuotaCache();
              if (cache[id]) {
                delete cache[id];
                window.localStorage.setItem(
                  QUOTA_CACHE_KEY,
                  JSON.stringify(cache),
                );
              }
            } catch (e) {
              console.error("Error deleting cache entry:", e);
            }
          }

          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error deleting connection:", error);
      } finally {
        setDeletingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleToggleConnectionActive = useCallback(
    async (id, isActive) => {
      setTogglingId(id);
      try {
        const res = await fetch(`/api/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isActive }),
        });
        if (res.ok) {
          setQuotaData((prev) => {
            const next = { ...prev };
            return next;
          });
          await reconcileConnectionsPage(fetchConnections, page);
        }
      } catch (error) {
        console.error("Error updating connection status:", error);
      } finally {
        setTogglingId(null);
      }
    },
    [fetchConnections, page],
  );

  const handleUpdateConnection = useCallback(
    async (formData) => {
      if (!selectedConnection?.id) return;
      const connectionId = selectedConnection.id;
      const provider = selectedConnection.provider;
      try {
        const res = await fetch(`/api/providers/${connectionId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(formData),
        });
        if (res.ok) {
          await fetchConnections();
          setShowEditModal(false);
          setSelectedConnection(null);
          if (USAGE_SUPPORTED_PROVIDERS.includes(provider)) {
            await fetchQuota(connectionId, provider);
          }
        }
      } catch (error) {
        console.error("Error saving connection:", error);
      }
    },
    [selectedConnection, fetchConnections, fetchQuota],
  );

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy-pools?isActive=true", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled && data?.proxyPools) {
          setProxyPools(data.proxyPools);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshResetEvidence = useCallback(async () => {
    if (!resetListing) return;
    try {
      const response = await fetch('/api/providers/codex/rotation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'refresh',policy:{...emptyRotation(),enabled:true,resetPriority},model:''})});
      if (!response.ok) throw new Error();
      const result = await response.json();
      setResetReadError(result.errors?.length ? `${result.errors.length} account reads unavailable` : '');
    } catch { setResetReadError('Credit expiry reads unavailable. Retry refresh.'); }
  },[resetListing,resetPriority]);

  const refreshAll = useCallback(async (force = false) => {
    if (refreshingAll) return;

    setRefreshingAll(true);
    setRefreshCycle(cycle => cycle + 1);

    // Throttle Claude: poll its quota every Nth auto-tick (manual force bypasses)
    const tick = (tickCountRef.current += 1);
    const claudeEvery = Math.round(CLAUDE_REFRESH_INTERVAL_MS / REFRESH_INTERVAL_MS);
    const shouldFetch = (conn) =>
      force || conn.provider !== "claude" || tick % claudeEvery === 0;

    try {
      await refreshResetEvidence();
      const visibleConnections = await fetchConnections(page);
      if (!visibleConnections) return;

      setLoading(buildLoadingState(visibleConnections));
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );
      setQuotaData((prev) =>
        filterQuotaStateByConnections({ ...getQuotaCache(), ...prev }, visibleConnections),
      );

      await Promise.all(
        visibleConnections
          .filter(shouldFetch)
          .map((conn) => fetchQuota(conn.id, conn.provider)),
      );

      setLastUpdated(new Date());
    } catch (error) {
      console.error("Error refreshing all providers:", error);
    } finally {
      setRefreshingAll(false);
    }
  }, [refreshingAll, fetchConnections, fetchQuota, page, refreshResetEvidence]);

  useEffect(() => {
    let cancelled = false;
    const initializeData = async () => {
      setConnectionsLoading(true);
      await refreshResetEvidence();
      if (cancelled) return;
      const visibleConnections = await fetchConnections(page);
      if (!visibleConnections) return;
      setConnectionsLoading(false);

      // Keep the last observed rows visible while refreshing; never use stale data for bulk actions.
      setLoading(buildLoadingState(visibleConnections));
      setErrors((prev) =>
        filterQuotaStateByConnections(prev, visibleConnections),
      );
      setQuotaData((prev) =>
        filterQuotaStateByConnections({ ...getQuotaCache(), ...prev }, visibleConnections),
      );

      await Promise.all(
        visibleConnections.map((conn) => fetchQuota(conn.id, conn.provider)),
      );
      setLastUpdated(new Date());
    };

    initializeData();
    return () => { cancelled = true; };
  }, [fetchConnections, fetchQuota, page, refreshResetEvidence]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(AUTO_REFRESH_STORAGE_KEY);
    setAutoRefresh(stored === null ? true : stored === "true");
    setHasHydratedAutoRefresh(true);
  }, []);

  // Persist auto-refresh preference
  useEffect(() => {
    if (typeof window === "undefined" || !hasHydratedAutoRefresh) return;
    window.localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, String(autoRefresh));
  }, [autoRefresh, hasHydratedAutoRefresh]);

  // Load auto-ping per-connection configs
  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error("Settings unavailable"); return r.json(); })
      .then((s) => {
        setAutoPingConfigs({
          claude: s?.claudeAutoPing || {},
          codex: s?.codexAutoPing || {},
        });
        setQuotaVisibility(s?.quotaVisibility || {});
        setVisibilityReady(true);
      })
      .catch(() => setVisibilityError("Display preferences are unavailable. Reload to retry."));
  }, []);

  const handleSaveAutoPing = useCallback(async (connectionId, provider, { reactive, schedule }) => {
    const settingsKey = AUTO_PING_SETTINGS_KEYS[provider];
    if (!settingsKey) return;

    const previous = autoPingConfigs;
    const prevCfg = autoPingConfigs[provider] || {};
    const nextProviderCfg = {
      ...prevCfg,
      connections: { ...(prevCfg.connections || {}), [connectionId]: reactive },
      schedules: { ...(prevCfg.schedules || {}), [connectionId]: schedule },
    };
    const nextConfigs = { ...autoPingConfigs, [provider]: nextProviderCfg };
    setAutoPingConfigs(nextConfigs);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [settingsKey]: {
          connections: { [connectionId]: reactive },
          schedules: { [connectionId]: schedule },
        } }),
      });
      if (!response.ok) throw new Error("Failed to save automatic quota checks");
      const saved = await response.json();
      setAutoPingConfigs((current) => ({ ...current, [provider]: saved[settingsKey] || nextProviderCfg }));
    } catch (error) {
      setAutoPingConfigs(previous);
      throw error;
    }
  }, [autoPingConfigs]);

  const updateQuotaVisibility = useCallback(async (change, updateSection) => {
    if (!visibilityReady || visibilityWrite.current) return;
    visibilityWrite.current = true;
    setVisibilitySaving(true);
    setVisibilityError("");
    try {
      // Apply only this intent to the latest saved preferences, preserving other settings writers.
      const currentResponse = await fetch("/api/settings", { cache: "no-store" });
      if (!currentResponse.ok) throw new Error("Display preferences unavailable");
      const currentSettings = await currentResponse.json();
      const nextVisibility = change(currentSettings.quotaVisibility || {});
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotaVisibility: nextVisibility }),
      });
      if (!response.ok) throw new Error("Failed to update display preferences");
      quotaDisplayTransition(()=>{setQuotaVisibility(nextVisibility);updateSection?.();});
    } catch {
      setVisibilityError("Display preference was not saved. Try again.");
    } finally {
      visibilityWrite.current = false;
      setVisibilitySaving(false);
    }
  }, [visibilityReady]);

  const setGroupVisibility = (id, group, visible) => {
    return updateQuotaVisibility(current => setSharedCardGroupVisible(current, group, visible),()=>{if(imageModel&&group===(imageSelection?"images":"text"))setModelSectionVisible(visible);});
  };
  const setModelVisibility = (id, provider, group, model, visible) => {
    return updateQuotaVisibility(current => visible ? setSharedCardGroupVisible(setCardModelVisible(current, { id, provider, group, model, visible, legacy: legacyCardCollapse }),group,true) : setCardModelVisible(current, { id, provider, group, model, visible, legacy: legacyCardCollapse }),()=>{if(imageModel===model&&group===(imageSelection?"images":"text"))setModelSectionVisible(visible);});
  };
  const setSummaryRowVisibility = (id, quota, visible) => updateQuotaVisibility(current => {
    const next = setSharedQuotaVisibility(current, quota, visible);
    return visible ? setCardGroupVisible(next, id, "summary", true) : next;
  });
  const chooseDisplayModels = (id, group) => displayControls.current.get(id)?.choose(group);

  // Only the small countdown owns one-second updates; card data refreshes once per interval.
  useEffect(() => {
    if (!hasHydratedAutoRefresh || !autoRefresh) return;
    const schedule = () => {
      clearInterval(intervalRef.current);
      intervalRef.current = document.hidden ? null : setInterval(() => refreshAll(), REFRESH_INTERVAL_MS);
    };
    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      clearInterval(intervalRef.current);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [autoRefresh, refreshAll, hasHydratedAutoRefresh]);

  const connectionSegments = useMemo(
    () => availabilityQuotaSegments(scopePending ? [] : rotationScope && serverRotationSegments ? serverRotationSegments.map(segment => ({...segment, connections: segment.ids.map(id => connections.find(connection => connection.id === id)).filter(Boolean)})).filter(segment => segment.connections.length) : segmentVisibleConnections(connections, quotaData, quotaSorts),pinnedCards,quotaData,availabilityGrouping({sorts:quotaSorts,groupAvailability}),Boolean(rotationScope&&serverRotationSegments),quotaSorts.length>1||resetListing),
    [connections, quotaData, quotaSorts, scopePending,pinnedCards, rotationScope, serverRotationSegments,groupAvailability,resetListing],
  );
  const sortedConnections = connectionSegments.flatMap(segment => segment.connections);
  const segmentCount = connectionSegments.filter(segment=>segment.connections.length).length;
  const allCardsCollapsed = sortedConnections.length > 0 && sortedConnections.every(connection=>!cardGroupVisible(quotaVisibility,connection.id,"images",legacyCardCollapse)&&!cardGroupVisible(quotaVisibility,connection.id,"text",legacyCardCollapse));
  const showSegmentBars=quotaSorts.length>1||resetListing;
  const visibleSegments = scopePending ? [] : connectionSegments.filter(segment=>segment.connections.length);
  const scrollOwner = () => {
    let owner=quotaRoot.current?.parentElement;
    while(owner&&!/(auto|scroll)/.test(getComputedStyle(owner).overflowY))owner=owner.parentElement;
    return owner||document.scrollingElement;
  };
  useLayoutEffect(()=>{
    const grid=quotaGrid.current,toolbar=quotaToolbar.current,root=quotaRoot.current;
    if(!grid||!toolbar||!root)return;
    const owner=scrollOwner(),target=owner===document.scrollingElement?document:owner;
    let frame=0;
    const measure=()=>{
      frame=0;
      const toolbarHeight=controlsDocked?0:toolbar.getBoundingClientRect().height;
      const segmentHeight=40;
      const gap=parseFloat(getComputedStyle(grid).rowGap)||0;
      const edge=(owner===document.scrollingElement?0:owner.getBoundingClientRect().top)+toolbarHeight+segmentHeight+gap;
      const active=quotaActiveSegmentIndex([...grid.querySelectorAll('[data-quota-segment-start]')].map(card=>card.getBoundingClientRect().top),edge,grid.getBoundingClientRect().bottom);
      setActiveSegmentIndex(current=>current===active?current:active);
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure);};
    measure();target.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule);
    const observer=new ResizeObserver(schedule);observer.observe(toolbar);observer.observe(grid);
    return()=>{if(frame)cancelAnimationFrame(frame);target.removeEventListener('scroll',schedule);window.removeEventListener('resize',schedule);observer.disconnect();};
  },[connectionSegments,quotaVisibility,modelSectionVisible,controlsDocked]);
  useLayoutEffect(()=>{
    const next=new Map();
    quotaGrid.current?.querySelectorAll('[data-quota-id]').forEach(card=>{
      const rect=card.getBoundingClientRect(),old=pinRects.current.get(card.dataset.quotaId);next.set(card.dataset.quotaId,rect);
      if(pinMotion.current&&old&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){
        const x=old.left-rect.left,y=old.top-rect.top;
        if(x||y)card.animate?.([{transform:`translate(${x}px,${y}px)`},{transform:'translate(0,0)'}],{duration:360,easing:'cubic-bezier(.2,.8,.2,1)'});
      }
    });
    if(pinMotion.current&&pinFocus.current?.isConnected)pinFocus.current.focus({preventScroll:true});
    pinFocus.current=null;pinRects.current=next;pinMotion.current=false;
  },[connectionSegments,quotaVisibility,modelSectionVisible]);
  const jumpToSegment = key => {
    const grid=quotaGrid.current,owner=scrollOwner();
    const card=grid?.querySelector(`[data-quota-segment-start="${key}"]`);
    if(!card||!owner)return;
    const top=quotaSegmentScrollTop({scrollTop:owner.scrollTop,cardTop:card.getBoundingClientRect().top,viewportTop:owner===document.scrollingElement?0:owner.getBoundingClientRect().top,
      toolbarHeight:controlsDocked?0:quotaToolbar.current.getBoundingClientRect().height,segmentHeight:40,gap:parseFloat(getComputedStyle(grid).rowGap)||0});
    card.focus({preventScroll:true});
    owner.scrollTo({top,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  };


  // The account switch affects every capability, so only disable it when
  // every reported quota is known to be depleted.
  const isConnectionDepleted = (conn) =>
    !loading[conn.id] && !errors[conn.id] && areAllReportedQuotasDepleted(quotaData[conn.id]?.quotas);
  const isConnectionAvailable = (conn) =>
    !loading[conn.id] && !errors[conn.id] && hasReportedQuotaAvailable(quotaData[conn.id]?.quotas);

  const bulkSetActive = useCallback(
    async (targetIds, isActive) => {
      if (!targetIds.length || bulkToggling) return;
      setBulkToggling(true);
      try {
        await Promise.all(
          targetIds.map((id) =>
            fetch(`/api/providers/${id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ isActive }),
            }),
          ),
        );
        await reconcileConnectionsPage(fetchConnections, page);
      } catch (error) {
        console.error("Error bulk toggling connections:", error);
      } finally {
        setBulkToggling(false);
      }
    },
    [bulkToggling, fetchConnections, page],
  );

  const handleDisableDepleted = () => {
    const ids = sortedConnections
      .filter((c) => (c.isActive ?? true) && isConnectionDepleted(c))
      .map((c) => c.id);
    bulkSetActive(ids, false);
  };

  const handleEnableAvailable = () => {
    const ids = sortedConnections
      .filter((c) => !(c.isActive ?? true) && isConnectionAvailable(c))
      .map((c) => c.id);
    bulkSetActive(ids, true);
  };

  const connectionsPageSummary = getConnectionsPaginationSummary(pagination);
  const isCustomPageSize = !ACCOUNT_PAGE_SIZE_OPTIONS.includes(pageSize);
  const pageSizeLabel = getPageSizeLabel(pageSize, isCustomPageSize);

  return (
    <div ref={quotaRoot} className="space-y-2">
      {rotationScope && <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-text-muted">
        {rotationScope && <><span>{providerSequence?.provider===providerFilter?"Provider sequence":"Rotation preview"} · {rotationPreview.model||"all models"}</span><button type="button" className="text-primary underline" onClick={() => setRotationPreview(null)}>Return to card sorting</button></>}
      </div>}
      {/* Header Controls */}
      <QuotaControlDock sorts={rotationScope ? rotationPreview.policy.sorts : quotaSorts} options={providerFilter!=="all" ? rotationMetrics(providerFilter) : QUOTA_SORT_OPTIONS} resetPriority={resetPriority.enabled} onDockedChange={setControlsDocked} shortLabel={providerFilter==='codex'?'5h':'Short'}>
      <div className="quota-filter-bar">
        <div className="quota-filter-scroll" tabIndex={0} aria-label="Scroll quota filters horizontally">
        <div role="group" aria-label="Quota filters" className="flex w-max min-w-full items-center gap-1.5">
          <QuotaProviderSelector value={providerFilter} options={providerOptions.map(id=>({id,label:providerLabel(id)}))} onChange={value=>{setPage(1);setProviderFilter(value);}} />


          <select
            value={accountFilter}
            onChange={(event) => {
              const nextValue = event.target.value;
              if (shouldResetPage(accountFilter, nextValue)) {
                setPage(1);
              }
              setAccountFilter(nextValue);
            }}
            className="h-9 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-sm text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
            aria-label="Filter accounts by status"
          >
            {ACCOUNT_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <select value={imageModelCategory} aria-label="Model category" onChange={event=>{
            const category=event.target.value;setImageModelCategory(category);setPage(1);
            const clear=Boolean(imageModel && (!selectedModelInfo || !quotaModelMatchesCategory(selectedModelInfo,category)));
            if(clear){setImageModel("");setImageModelProvider("");}
            const params=new URLSearchParams(searchParams?.toString()||"");
            if(category==='all')params.delete('category');else params.set('category',category);
            if(clear){params.delete('model');params.delete('model_provider');}
            router.replace(params.size?`${pathname}?${params}`:pathname,{scroll:false});
          }} className="h-9 shrink-0 rounded-lg border border-black/10 bg-surface px-2 text-sm text-text-primary dark:border-white/10">
            <option value="all">All categories</option>
            {[...new Set(QUOTA_MODEL_CATEGORIES.map(item=>item.group).filter(Boolean))].map(group=><optgroup key={group} label={group}>{QUOTA_MODEL_CATEGORIES.filter(item=>item.group===group).map(item=><option key={item.value} value={item.value}>{item.emoji} {item.label}</option>)}</optgroup>)}
          </select>
          <ImageModelSelector value={imageModel} catalog={scopePending ? [] : quotaCatalog} loading={scopePending || connectionsLoading || refreshingAll} onCommit={changeImageModel} />
        </div>
        </div>
      </div>
      <div ref={quotaToolbar} className="quota-toolbar">
        <div className="quota-sort-area space-y-2">
        <div className="quota-control-scroll"><div className="flex w-max min-w-full items-center gap-3">
          <div className="quota-sequence-row flex min-w-0 max-w-full items-center gap-2">
          {(providerFilter==='all'||providerFilter==='codex')&&<ResetPriorityControl value={resetPriority} onChange={value=>{setResetPriority(value);setRotationPreview(current=>updateQuotaRotationPreview(current,providerFilter,imageModel,quotaSorts,value));}} />}
          <div className="min-w-0 flex-1 overflow-x-auto"><QuotaSortBar sorts={quotaSorts} options={providerFilter!=="all" ? rotationMetrics(providerFilter) : QUOTA_SORT_OPTIONS} provider={providerFilter} groupAvailability={groupAvailability} onGroupAvailabilityChange={value=>{setGroupAvailability(value);setRotationPreview(current=>updateQuotaRotationPreview(current,providerFilter,imageModel,quotaSorts,resetPriority,value));}} onChange={sorts=>{const grouped=quotaSorts.length<2&&sorts.length>1?true:groupAvailability;setGroupAvailability(grouped);setQuotaSorts(sorts);setRotationPreview(current=>updateQuotaRotationPreview(current,providerFilter,imageModel,sorts,resetPriority,grouped));}} /></div>
          <div className="shrink-0 border-l border-border pl-2"><QuotaSequencePublish groupAvailability={groupAvailability} sorts={quotaSorts} resetPriority={resetPriority} providers={providerOptions} providerFilter={providerFilter} model={imageSelection?'':imageModel} modelProvider={imageModelProvider} onApplied={(provider,policy)=>{if(provider===providerFilter)setProviderSequence({provider,policy});void fetchConnections(page);}} /></div>
          </div>
          <div role="group" tabIndex={0} aria-label="Quota actions" className="quota-actions flex shrink-0 items-center gap-1.5 border-l border-black/10 pl-3 dark:border-white/10">
          <ImageManagementDialog controlsRef={imageManagement} state={imageState} onOpenAccountSettings={openImageAccountSettings} onSelectModel={changeImageModel} settingsError={imageAccountSettingsError} />
          {/* Bulk: disable depleted */}
          <button
            type="button"
            onClick={handleDisableDepleted}
            aria-label="Turn off empty accounts"
            disabled={bulkToggling}
            className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-red-500/30 px-2 text-sm text-red-500 transition-colors hover:bg-red-500/10 disabled:opacity-50"
            title="Disable connections only when every reported quota on the current page is depleted"
          >
            <span className="material-symbols-outlined text-[14px]">block</span>
            <span className="quota-action-label">Turn off Empty</span>
          </button>

          {/* Bulk: enable available */}
          <button
            type="button"
            onClick={handleEnableAvailable}
            aria-label="Turn on available accounts"
            disabled={bulkToggling}
            className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-emerald-500/30 px-2 text-sm text-emerald-500 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
            title="Enable connections with at least one reported quota that still has headroom"
          >
            <span className="material-symbols-outlined text-[14px]">
              check_circle
            </span>
            <span className="quota-action-label">Turn on Available</span>
          </button>

          {/* Auto-refresh toggle */}
          <button
            type="button"
            onClick={() => setAutoRefresh((prev) => !prev)}
            aria-label="Auto-refresh quotas"
            aria-pressed={autoRefresh}
            className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-sm transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
            title={autoRefresh ? "Disable auto-refresh" : "Enable auto-refresh"}
          >
            <span
              className={`material-symbols-outlined text-[14px] ${
                autoRefresh ? "text-primary" : "text-text-muted"
              }`}
            >
              {autoRefresh ? "toggle_on" : "toggle_off"}
            </span>
            <span className="quota-action-label text-text-primary">
              Auto-refresh
            </span>
            {autoRefresh && (
              <QuotaRefreshCountdown active={hasHydratedAutoRefresh} resetKey={refreshCycle} seconds={REFRESH_INTERVAL_MS / 1000}/>
            )}
          </button>


          {/* Refresh all button */}
          <button
            type="button"
            onClick={() => refreshAll(true)}
            aria-label="Refresh all quotas"
            disabled={refreshingAll}
            className="flex h-9 shrink-0 items-center gap-1 rounded-lg border border-black/10 px-2 text-sm text-text-primary transition-colors hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5 disabled:opacity-50"
            title="Refresh all"
          >
            <span
              className={`material-symbols-outlined text-[14px] ${refreshingAll ? "animate-spin" : ""}`}
            >
              refresh
            </span>
          </button>
          </div>
        </div>
        </div>
        <p id="quota-sort-hint" className="text-xs text-text-muted">

          {rotationScope ? `${showSegmentBars?segmentCount+" groups":"Sorted accounts"} · all filtered accounts` : quotaSorts.length ? `${showSegmentBars?segmentCount+" groups":"Sorted accounts"} · this page` : "Sort: off → ↑ → ↓ → off · this page"}
          <span className="sr-only"> Session means the reported short window, including Codex 5h. Each later sort divides its preceding ordered group just before sorting: ½ balances card counts, P50 splits at the median value, and Gap splits at the largest value jump. P50/Gap keep ties together and put unreported values in a separate trailing group. With one sort there is no division. Multiple reset pools use the next reset; remaining uses the main window, or the lowest reported pool if no main window exists. Sorting stays within the loaded page.</span>
        </p>
        </div>
      </div>
      </QuotaControlDock>
      {resetListing && <p role="status" className="px-1 text-xs text-amber-600 dark:text-amber-400">
            Reset first · {resetSummary?.live ? 'Live rule' : 'Listing preview · Apply to routing'}
            {' · '}{scopePending ? 'Checking…' : resetSummary?.applicable === false ? 'Main Codex text only' : resetSummary ? `${resetSummary.matching} matching · earliest credit expiry first` : 'Expiry not checked'}
            {!scopePending && resetSummary?.unavailable > 0 && ` · ${resetSummary.unavailable} missing expiry/quota reads`}
            {!scopePending && resetSummary?.matching === 0 && resetSummary?.nextExpiry && ` · Next credit expiry ${new Date(resetSummary.nextExpiry).toLocaleDateString(undefined,{month:'short',day:'numeric'})}`}
            {resetReadError && ` · ${resetReadError}`}
          </p>}
      <div className="quota-segment-anchor">
        {showSegmentBars && visibleSegments[activeSegmentIndex] && <div className="quota-pinned-segment">
          <QuotaSegmentBar compact headingId="quota-current-segment" segment={visibleSegments[activeSegmentIndex]} index={activeSegmentIndex} total={visibleSegments.length} previous={visibleSegments[activeSegmentIndex-1]?.key} next={visibleSegments[activeSegmentIndex+1]?.key} onNavigate={jumpToSegment} />
        </div>}
      </div>

      {/* Provider cards: 2 columns, compact */}
      <div className="flex items-center justify-between gap-2">
        <button type="button" disabled={!sortedConnections.length || !visibilityReady || visibilitySaving} aria-busy={visibilitySaving || undefined} aria-controls="quota-account-cards" aria-expanded={!allCardsCollapsed}
          onClick={()=>updateQuotaVisibility(current=>setAllCardSectionsVisible(current,allCardsCollapsed),()=>setModelSectionVisible(allCardsCollapsed))}
          className="inline-flex h-9 items-center gap-1.5 rounded-[10px] px-2 text-xs font-medium text-text-muted transition-colors hover:bg-surface-2 hover:text-text-main disabled:opacity-50">
          <span aria-hidden="true" className={`material-symbols-outlined text-[18px] ${visibilitySaving?'animate-spin':''}`}>{visibilitySaving?'progress_activity':allCardsCollapsed?'unfold_more':'unfold_less'}</span>
          {allCardsCollapsed?'Show all sections':'Show only Summary'}
        </button>
        <span role="status" className="sr-only">{visibilitySaving?'Saving display preferences…':''}</span>
        <span className="text-xs tabular-nums text-text-muted">{sortedConnections.length} cards on this page</span>
      </div>

      {visibilityError && <p role="alert" className="text-xs text-amber-500">{visibilityError}</p>}
      {(scopePending || connectionsLoading) && <p role="status" className="py-6 text-sm text-text-muted">Loading matching accounts…</p>}
      {connectionError && <p role="alert" className="text-sm text-amber-500">{connectionError}</p>}
      {!connectionError && !scopePending && !connectionsLoading && !sortedConnections.length && <div role="status" className="rounded-xl border border-border p-6 text-sm text-text-muted">No configured accounts match these filters. Clear the model or choose another category.</div>}
      <div ref={quotaGrid} id="quota-account-cards" className="grid grid-cols-1 items-start md:grid-cols-2 gap-3" aria-label="Account segments">
      {visibleSegments.flatMap((segment,index)=>[
        ...(showSegmentBars ? [<QuotaSegmentBar key={`segment-${segment.key}`} segment={segment} index={index} total={visibleSegments.length} previous={visibleSegments[index-1]?.key} next={visibleSegments[index+1]?.key} covered={index<=activeSegmentIndex} onNavigate={jumpToSegment} />] : []),
        ...segment.connections.map((conn) => {
          const collapsed = !cardGroupVisible(quotaVisibility,conn.id,"images",legacyCardCollapse);
          const summaryVisible = cardGroupVisible(quotaVisibility, conn.id, "summary");
          const displayModels = conn.displayModels || [];
          const textModels = displayModels.filter(model => model.kind === "llm" && quotaModelMatchesCategory(model,imageModelCategory));
          const imageModels = displayModels.filter(model => model.kind === "image" && quotaModelMatchesCategory(model,imageModelCategory));
          const textVisible = (imageModel ? !imageSelection&&modelSectionVisible : cardGroupVisible(quotaVisibility, conn.id, "text")) && (imageModelCategory === "all" || textModels.length > 0);
          const imagesVisible = (imageModel ? imageSelection&&modelSectionVisible : !collapsed) && (imageModelCategory === "all" || imageModels.length > 0);
          const selectedTextIds = selectedCardModels(textModels,model => cardModelVisible(quotaVisibility, conn.provider, "text", model.id),imageModel,"llm");
          const selectedImageIds = selectedCardModels(imageModels,model => cardModelVisible(quotaVisibility, conn.provider, "images", model.id),imageModel,"image");
          const quota = quotaData[conn.id];
          const isLoading = loading[conn.id];
          const error = errors[conn.id];

          // Use table layout for all providers
          const isInactive = conn.isActive === false;
          const isCodex = conn.provider === "codex";
          const autoPingConfig = autoPingConfigs[conn.provider] || {};
          const autoPingScheduled = autoPingConfig.schedules?.[conn.id]?.enabled === true;
          const autoPingReactive = autoPingConfig.connections?.[conn.id] === true;
          const claudeReset = conn.provider === "claude" ? quota?.raw?.resetCredits : null;
          const resetLabel = isCodex ? "Codex reset credit" : "Claude limit reset";
          const resetCreditCount = getCodexResetCreditCount(quota);
          const isResettingLimit = resettingLimitId === conn.id;
          const rowBusy = deletingId === conn.id || togglingId === conn.id || isResettingLimit;
          const rawQuotas = quota?.quotas || [];
          const visibleQuotas = filterQuotasByVisibility(conn.provider, rawQuotas, quotaVisibility);
          const hiddenQuotaRows = getHiddenQuotaRows(conn.provider, rawQuotas, quotaVisibility);
          const showQuotaStatus = rawQuotas.length === 0 && Boolean(isLoading || error || quota?.message);
          const summaryActions = {
            onHideQuota: (row) => setSummaryRowVisibility(conn.id, row, false),
            onRefreshQuota: () => refreshProvider(conn.id, conn.provider),
            onOpenSummaryOptions: () => chooseDisplayModels(conn.id, "summary"),
            refreshDisabled: rowBusy || isLoading,
          };

          return (
            <QuotaCardInteraction key={conn.id}>{modelInteraction => <div className="quota-account-card-stack min-w-0" style={{viewTransitionName:`quota-card-${conn.id}`}}><Card
              tabIndex={-1}
              data-quota-card=""
              data-quota-id={conn.id}
              data-pinned={pinnedCards.includes(conn.id)||undefined}
              data-quota-segment-start={conn.id===segment.connections[0].id?segment.key:undefined}
              aria-describedby={showSegmentBars ? `quota-segment-${segment.key}` : undefined}
              padding="none"
              className={`quota-account-card relative isolate min-w-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${isInactive ? "opacity-60" : ""}`}
            >
              <div className="relative px-3 py-2 border-b border-black/10 dark:border-white/10">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="flex items-center gap-2 min-w-0 w-[42%] max-w-72 shrink-0">
                    <div className="relative w-8 h-8 shrink-0 rounded-md flex items-center justify-center">
                      <ProviderIcon
                        src={`/providers/${conn.provider}.png`}
                        alt={conn.provider}
                        size={32}
                        className="object-contain"
                        fallbackText={
                          conn.provider?.slice(0, 2).toUpperCase() || "PR"
                        }
                      />
                      <QuotaCardPin pinned={pinnedCards.includes(conn.id)} name={getConnectionLabel(conn)||providerLabel(conn.provider)} onToggle={()=>togglePin(conn.id)} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="flex min-w-0 items-center gap-1 text-sm font-semibold text-text-primary">
                        <span className="truncate">{providerLabel(conn.provider)}</span>
                        {conn.rotationHint && <span className="shrink-0 rounded bg-amber-500/10 px-1 text-[10px] text-amber-600 dark:text-amber-300" title={`Available reset credit expires ${new Date(conn.rotationHint.expiresAt).toLocaleString()}`}>⌛ {new Date(conn.rotationHint.expiresAt).toLocaleDateString(undefined,{month:"short",day:"numeric"})}</span>}
                        {(collapsed || !summaryVisible) && quota?.quotas?.length > 0 && (isLoading || error) && <span role="status" aria-label={`${isLoading?'Refreshing quota':'Quota refresh unavailable'}${quota.cachedAt?` · last observed ${new Date(quota.cachedAt).toLocaleString()}`:''}`} title={`${isLoading?'Refreshing quota':'Quota refresh unavailable'}${quota.cachedAt?` · last observed ${new Date(quota.cachedAt).toLocaleString()}`:''}`} className={`material-symbols-outlined shrink-0 text-[14px] ${isLoading?'animate-spin text-text-muted':'text-amber-500'}`}>{isLoading?'progress_activity':'cloud_off'}</span>}
                      </h3>
                      {getConnectionLabel(conn) ? (
                        <p className="text-xs text-text-muted truncate">
                          {getConnectionLabel(conn)}
                        </p>
                      ) : null}
                      {getConnectionSecondaryLabel(conn) ? (
                        <p className="text-[11px] text-text-muted/80 truncate">
                          {getConnectionSecondaryLabel(conn)}
                        </p>
                      ) : null}
                      {conn.provider === "kiro" && (
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          <span className="rounded-full bg-brand-500/10 px-2 py-0.5 text-[10px] font-semibold text-brand-600 dark:text-brand-300">
                            {kiroMethodLabel(conn)}
                          </span>
                          {kiroRegion(conn) && (
                            <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
                              {kiroRegion(conn)}
                            </span>
                          )}
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              isInactive
                                ? "bg-surface-2 text-text-muted"
                                : conn.testStatus === "active" || conn.testStatus === "success"
                                  ? "bg-green-500/10 text-green-600 dark:text-green-400"
                                  : conn.testStatus === "error" || conn.testStatus === "expired" || conn.testStatus === "unavailable"
                                    ? "bg-red-500/10 text-red-600 dark:text-red-400"
                                    : "bg-surface-2 text-text-muted"
                            }`}
                          >
                            {isInactive ? "disabled" : conn.testStatus || "unknown"}
                          </span>
                          {conn.providerSpecificData?.profileArn && (
                            <button
                              type="button"
                              onClick={() => copy(conn.providerSpecificData.profileArn, conn.id)}
                              title={conn.providerSpecificData.profileArn}
                              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[10px] text-text-muted transition-colors hover:text-primary"
                            >
                              <span className="material-symbols-outlined text-[12px]">
                                {copied === conn.id ? "check" : "content_copy"}
                              </span>
                              <code className="truncate font-mono">
                                {conn.providerSpecificData.profileArn}
                              </code>
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <QuotaCardActions>
                    {(isCodex || claudeReset) && (
                      <>
                        <Tooltip native
                          text={
                            resetCreditCount > 0
                              ? claudeReset
                                ? `Use your reset now (${resetCreditCount} left, use by ${formatCreditDate(claudeReset.expiresAt)}) · refills ${formatClaudeResetClears(claudeReset.clears)}`
                                : `Use one ${resetLabel}. Available: ${resetCreditCount}`
                              : `No ${resetLabel}s available`
                          }
                        >
                          <button
                            type="button"
                            onClick={() => setResetConfirmState({ connection: conn, resetCreditCount })}
                            disabled={resetCreditCount <= 0 || isLoading || rowBusy}
                            aria-label={
                              resetCreditCount > 0
                                ? `Use one ${resetLabel}. ${resetCreditCount} available.`
                                : `No ${resetLabel}s available`
                            }
                            className={`flex h-8 min-w-10 items-center justify-center gap-1 rounded-lg border px-2 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/60 disabled:cursor-not-allowed disabled:opacity-60 ${
                              resetCreditCount > 0
                                ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                                : "border-black/10 bg-black/[0.02] text-text-muted dark:border-white/10 dark:bg-white/[0.03]"
                            }`}
                          >
                            <span className={`material-symbols-outlined text-[15px] ${isResettingLimit ? "animate-spin" : ""}`}>
                              {isResettingLimit ? "progress_activity" : "restart_alt"}
                            </span>
                            <span>{resetCreditCount}</span>
                          </button>
                        </Tooltip>
                        <Tooltip native text={isCodex ? "View Codex reset credit expiry" : "View Claude Code reset expiry"}>
                          <button
                            type="button"
                            onClick={() => (isCodex ? handleViewCodexResetCredits(conn) : handleViewClaudeResets(conn, claudeReset))}
                            disabled={isLoading || rowBusy}
                            aria-label={isCodex ? "View Codex reset credit expiry" : "View Claude Code reset expiry"}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-muted transition-colors hover:bg-black/5 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:hover:bg-white/5"
                          >
                            <span className="material-symbols-outlined text-[17px]">schedule</span>
                          </button>
                        </Tooltip>
                      </>
                    )}
                    {AUTO_PING_SETTINGS_KEYS[conn.provider] && conn.authType === "oauth" && (
                      <Tooltip native text={`${autoPingScheduled ? "Scheduled" : autoPingReactive ? "Reset-triggered" : "Automatic"} quota checks · configure`}>
                        <button
                          type="button"
                          onClick={() => setScheduleConnection(conn)}
                          aria-label="Configure automatic quota checks"
                          className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${autoPingScheduled || autoPingReactive ? "text-primary" : "text-text-muted"}`}
                        >
                          <span className="material-symbols-outlined text-[18px]">{autoPingScheduled ? "event_repeat" : "bolt"}</span>
                        </button>
                      </Tooltip>
                    )}
                    <Tooltip native text="Refresh quota">
                      <button
                        type="button"
                        onClick={() => refreshProvider(conn.id, conn.provider)}
                        disabled={isLoading || rowBusy}
                        aria-label="Refresh quota"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                      >
                        <span
                          className={`material-symbols-outlined text-[18px] text-text-muted ${isLoading ? "animate-spin" : ""}`}
                        >
                          refresh
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip native text="Edit connection">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedConnection(conn);
                          setShowEditModal(true);
                        }}
                        disabled={rowBusy}
                        aria-label="Edit connection"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-text-muted hover:text-primary transition-colors disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          edit
                        </span>
                      </button>
                    </Tooltip>
                    <Tooltip native text="Delete connection">
                      <button
                        type="button"
                        onClick={() => handleDeleteConnection(conn.id)}
                        disabled={rowBusy}
                        aria-label="Delete connection"
                        className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-red-500/10 text-red-500 transition-colors disabled:opacity-50"
                      >
                        <span
                          className={`material-symbols-outlined text-[18px] ${deletingId === conn.id ? "animate-pulse" : ""}`}
                        >
                          delete
                        </span>
                      </button>
                    </Tooltip>
                    <div
                      className="quota-account-enable relative inline-flex h-8 items-center justify-center px-1"
                      title={
                        (conn.isActive ?? true)
                          ? "Disable connection"
                          : "Enable connection"
                      }
                    >
                      <Toggle
                        size="sm"
                        ariaLabel={(conn.isActive ?? true)?"Disable connection":"Enable connection"}
                        checked={conn.isActive ?? true}
                        disabled={rowBusy}
                        onChange={(nextActive) =>
                          handleToggleConnectionActive(conn.id, nextActive)
                        }
                      />
                    </div>
                  </QuotaCardActions>
                </div>
              </div>

              {summaryVisible && <div id={`quota-card-summary-${conn.id}`} className="px-2 py-1.5">
                {rawQuotas.length>0&&!visibleQuotas.length&&<div className="flex h-7 items-center gap-2 text-xs text-text-muted"><span>Summary · 0/{rawQuotas.length}</span><button type="button" aria-label={`Summary display options for ${getConnectionLabel(conn)}`} onClick={()=>chooseDisplayModels(conn.id,"summary")} className="ml-auto flex size-7 items-center justify-center"><span aria-hidden="true" className="material-symbols-outlined text-base">chevron_right</span></button></div>}
                {quota?.quotas?.length > 0 ? <>
                  <QuotaTable {...summaryActions} quotas={visibleQuotas} compact sortMode="default" minimal />
                  {(isLoading || error) && <p role="status" className="mt-1 text-[10px] text-text-muted">Last observed{quota.cachedAt ? ` ${new Date(quota.cachedAt).toLocaleString()}` : ""} · {isLoading ? "refreshing" : "refresh unavailable"}</p>}
                </> : isLoading ? (
                  <div className="text-center py-5 text-text-muted">
                    <span className="material-symbols-outlined text-[28px] animate-spin">
                      progress_activity
                    </span>
                  </div>
                ) : error ? (
                  <div className="text-center py-5">
                    <span className="material-symbols-outlined text-[28px] text-red-500">
                      error
                    </span>
                    <p className="mt-1.5 text-xs text-text-muted">{error}</p>
                  </div>
                ) : quota?.message ? (
                  <div className="text-center py-5">
                    <p className="text-xs text-text-muted">{quota.message}</p>
                  </div>
                ) : (
                  <QuotaTable
                    {...summaryActions}
                    quotas={visibleQuotas}
                    compact
                    sortMode="default"
                    minimal
                  />
                )}
                {isCodex && !quota?.quotas?.length && (isLoading || error || quota?.message) && <QuotaTable {...summaryActions} quotas={visibleQuotas} compact minimal />}
              </div>}
              {<section hidden={!textVisible} aria-label={`Text models for ${getConnectionLabel(conn)}`} className="border-t border-border-subtle px-2 py-1">
                <div className="quota-card-section-heading flex min-h-8 min-w-0 items-center gap-1.5 text-xs"><span aria-hidden="true" className="material-symbols-outlined text-base text-primary">chat</span><strong>Text</strong><span className="text-text-muted">{selectedTextIds.length}/{textModels.length}</span><button type="button" aria-label={`Text display options for ${getConnectionLabel(conn)}`} onClick={()=>chooseDisplayModels(conn.id,"text")} className="quota-section-menu ml-auto flex size-7 items-center justify-center"><span aria-hidden="true" className="material-symbols-outlined text-base">tune</span></button></div>
                <TextModelRows onHideModel={model=>setModelVisibility(conn.id,conn.provider,"text",model,false)} connection={conn} models={textModels} selectedModelIds={selectedTextIds} quotas={rawQuotas} usage={quota?.raw?{...quota.raw,observedAt:quota.raw.observedAt||quota.cachedAt}:null} onChooseModels={()=>chooseDisplayModels(conn.id,"text")} onRevealSummary={()=>setGroupVisibility(conn.id,"summary",true)} modelInteraction={modelInteraction} />
              </section>}
              {imagesVisible && <div id={`quota-card-body-${conn.id}`}>
                <ImageAccountCard onHideModel={model=>setModelVisibility(conn.id,conn.provider,"images",model,false)} connection={conn} row={imageRows.get(conn.id)} state={imageCardState} onOpenAccountSettings={openImageAccountSettings} onSelectModel={changeImageModel} onOpenRotation={()=>imageManagement.current?.openRotation(conn.provider)} visible selectedModelIds={selectedImageIds} onChooseModels={()=>chooseDisplayModels(conn.id,"images")} onRevealSummary={()=>setGroupVisibility(conn.id,"summary",true)} modelInteraction={modelInteraction} />
              </div>}

            </Card><QuotaCardDetailsOverlay name={getConnectionLabel(conn) || providerLabel(conn.provider)}
                controlsRef={control=>{if(control)displayControls.current.set(conn.id,control);else displayControls.current.delete(conn.id);}}
                disabled={!visibilityReady||visibilitySaving}
                groups={{
                  summary: { visible: summaryVisible, actions: <button type="button" onClick={()=>refreshProvider(conn.id,conn.provider)} disabled={rowBusy||isLoading} className="inline-flex min-h-8 items-center gap-2 text-primary"><span aria-hidden="true" className="material-symbols-outlined text-base">refresh</span>Refresh quotas</button>, choices: rawQuotas.map(row=>({key:row.modelKey||row.name,name:row.name,visible:!hiddenQuotaRows.includes(row),onToggle:()=>setSummaryRowVisibility(conn.id,row,hiddenQuotaRows.includes(row))})) },
                  text: { visible: textVisible, choices: textModels.map(model=>({key:model.id,name:model.name||model.id,visible:selectedTextIds.includes(model.id),onToggle:()=>setModelVisibility(conn.id,conn.provider,"text",model.id,!selectedTextIds.includes(model.id))})) },
                  images: { visible: imagesVisible, actions: imageRows.get(conn.id)&&<div className="flex items-center justify-between gap-2"><span>Allow image requests</span><ImagePolicyToggle row={imageRows.get(conn.id)} state={imageCardState}/></div>, choices: imageModels.map(model=>({key:model.id,name:model.name||model.id,visible:selectedImageIds.includes(model.id),onToggle:()=>setModelVisibility(conn.id,conn.provider,"images",model.id,!selectedImageIds.includes(model.id))})) },
                }}
                onEnsureGroupVisible={group=>{if(!({summary:summaryVisible,text:textVisible,images:imagesVisible}[group]))setGroupVisibility(conn.id,group,true);}}
                onToggleGroup={group=>setGroupVisibility(conn.id,group,group==="text"?!textVisible:group==="images"?!imagesVisible:!summaryVisible)} /></div>}</QuotaCardInteraction>
          );
        })
      ])}
      </div>

      <div className="rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-text-muted">{connectionsPageSummary}</span>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={isCustomPageSize ? "custom" : String(pageSize)}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  if (nextValue === "custom") return;
                  const nextPageSize = Number.parseInt(nextValue, 10);
                  if (Number.isFinite(nextPageSize)) {
                    setPage(1);
                    setPageSize(nextPageSize);
                    setCustomPageSizeInput(String(nextPageSize));
                  }
                }}
                className="h-8 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                aria-label="Accounts per page"
              >
                {ACCOUNT_PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={String(option)}>
                    {option} / page
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
              <input
                type="number"
                min="1"
                max={String(ACCOUNT_PAGE_SIZE_MAX)}
                inputMode="numeric"
                value={customPageSizeInput}
                onChange={(event) => setCustomPageSizeInput(event.target.value)}
                onBlur={() => {
                  const parsedValue = Number.parseInt(customPageSizeInput, 10);
                  if (!Number.isFinite(parsedValue)) {
                    setCustomPageSizeInput(String(pageSize));
                    return;
                  }
                  const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                  setPage(1);
                  setPageSize(nextPageSize);
                  setCustomPageSizeInput(String(nextPageSize));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const parsedValue = Number.parseInt(customPageSizeInput, 10);
                  if (!Number.isFinite(parsedValue)) {
                    setCustomPageSizeInput(String(pageSize));
                    return;
                  }
                  const nextPageSize = Math.min(ACCOUNT_PAGE_SIZE_MAX, Math.max(1, parsedValue));
                  setPage(1);
                  setPageSize(nextPageSize);
                  setCustomPageSizeInput(String(nextPageSize));
                }}
                className="h-8 w-20 rounded-lg border border-black/10 bg-black/[0.02] px-2 text-xs text-text-primary outline-none transition-colors hover:bg-black/5 dark:border-white/10 dark:bg-white/[0.03] dark:hover:bg-white/10"
                aria-label="Custom accounts per page"
                placeholder="Custom"
              />
              <span className="text-xs text-text-muted">Page {pagination.page} / {pagination.totalPages}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage(1)}
                disabled={
                  pagination.page <= 1 || connectionsLoading || scopePending || refreshingAll
                }
                className="flex h-8 items-center rounded-lg border border-black/10 px-3 text-xs text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
              >
                First Page
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((currentPage) => Math.max(1, currentPage - 1))
                }
                disabled={
                  pagination.page <= 1 || connectionsLoading || scopePending || refreshingAll
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                aria-label="Previous accounts page"
              >
                <span className="material-symbols-outlined text-[16px]">
                  chevron_left
                </span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setPage((currentPage) =>
                    Math.min(pagination.totalPages, currentPage + 1),
                  )
                }
                disabled={
                  pagination.page >= pagination.totalPages ||
                  connectionsLoading ||
                  scopePending || refreshingAll
                }
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-black/10 text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
                aria-label="Next accounts page"
              >
                <span className="material-symbols-outlined text-[16px]">
                  chevron_right
                </span>
              </button>
              <button
                type="button"
                onClick={() => setPage(pagination.totalPages)}
                disabled={
                  pagination.page >= pagination.totalPages ||
                  connectionsLoading ||
                  scopePending || refreshingAll
                }
                className="flex h-8 items-center rounded-lg border border-black/10 px-3 text-xs text-text-primary transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:hover:bg-white/5"
              >
                Last Page
              </button>
            </div>
          </div>
        </div>

      <ConfirmModal
        isOpen={Boolean(resetConfirmState)}
        onClose={() => {
          if (!resettingLimitId) setResetConfirmState(null);
        }}
        onConfirm={async () => {
          const connection = resetConfirmState?.connection;
          if (!connection) return;
          await handleResetCodexLimit(connection.id, connection.provider);
          setResetConfirmState(null);
        }}
        title={resetConfirmState?.connection?.provider === "claude" ? "Reset Claude limits?" : "Reset Codex limit?"}
        message={resetConfirmState?.connection?.provider === "claude"
          ? `Refills your ${formatClaudeResetClears(quotaData[resetConfirmState.connection.id]?.raw?.resetCredits?.clears)} now for ${getConnectionLabel(resetConfirmState.connection) || "this account"} · your weekly reset day stays ${formatCreditDate(quotaData[resetConfirmState.connection.id]?.raw?.resetCredits?.weeklyResetsAt)}. This cannot be undone. Resets left: ${resetConfirmState.resetCreditCount ?? 0}.`
          : `Use 1 Codex reset credit for ${getConnectionLabel(resetConfirmState?.connection || {}) || "this account"}. This cannot be undone. Remaining credits: ${resetConfirmState?.resetCreditCount ?? 0}.`}
        confirmText="Reset limit"
        cancelText="Cancel"
        variant="danger"
        loading={Boolean(resettingLimitId)}
      />

      {resetCreditsState && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-black/15 bg-white shadow-2xl ring-1 ring-black/10 dark:border-white/15 dark:bg-neutral-950 dark:ring-white/10">
            <div className="flex items-start justify-between gap-3 border-b border-black/10 bg-black/[0.03] px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-text-primary">
                  {resetCreditsState.data?.kind === "claude" ? "Claude Code Limit Resets" : "Codex Reset Credit Expiry"}
                </h3>
                <p className="mt-0.5 truncate text-xs text-text-muted">
                  {getConnectionLabel(resetCreditsState.connection) || (resetCreditsState.data?.kind === "claude" ? "Claude account" : "Codex account")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setResetCreditsState(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-black/5 hover:text-text-primary dark:hover:bg-white/5"
                aria-label="Close reset credit expiry modal"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>

            <div className="max-h-[70vh] overflow-auto bg-white p-4 dark:bg-neutral-950">
              {resetCreditsState.loading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
                  <span className="material-symbols-outlined animate-spin text-[20px]">progress_activity</span>
                  Loading reset credits...
                </div>
              ) : resetCreditsState.error ? (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
                  {resetCreditsState.error}
                </div>
              ) : resetCreditsState.data?.kind === "claude" && resetCreditsState.data.grants?.length ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
                    <span>{resetCreditsState.data.availableCount ?? 0} reset{resetCreditsState.data.availableCount === 1 ? "" : "s"} left</span>
                    <span>Weekly reset day: {formatCreditDate(resetCreditsState.data.weeklyResetsAt)}</span>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/10">
                    <table className="w-full min-w-[560px] text-left text-sm">
                      <thead className="bg-black/[0.03] text-xs uppercase tracking-wide text-text-muted dark:bg-white/[0.04]">
                        <tr>
                          <th className="px-3 py-2 font-medium">Reset</th>
                          <th className="px-3 py-2 font-medium">Left</th>
                          <th className="px-3 py-2 font-medium">Refills</th>
                          <th className="px-3 py-2 font-medium">Use By</th>
                          <th className="px-3 py-2 font-medium">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(resetCreditsState.data.grants || []).map((grant) => (
                          <tr key={grant.id} className="border-t border-black/5 dark:border-white/5">
                            <td className="px-3 py-2">
                              <div className="text-text-primary">{grant.label || grant.id}</div>
                              <span className="mt-1 inline-block rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                {claudeGrantStatus(grant)}
                              </span>
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 font-medium tabular-nums text-text-primary">{grant.resetsLeft} / {grant.resetsTotal}</td>
                            <td className="px-3 py-2 text-text-muted">{formatClaudeResetClears(grant.clears)}</td>
                            <td className="px-3 py-2 text-text-primary">{formatCreditDate(grant.endsAt)}</td>
                            <td className="whitespace-nowrap px-3 py-2 font-medium text-text-primary">{formatTimeRemaining(grant.endsAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : resetCreditsState.data?.credits?.length ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between rounded-xl border border-black/10 bg-black/[0.02] px-3 py-2 text-xs text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
                    <span>{resetCreditsState.data.credits.length} reset credit{resetCreditsState.data.credits.length === 1 ? "" : "s"}</span>
                    <span>{resetCreditsState.data.availableCount ?? 0} available</span>
                  </div>
                  <div className="overflow-x-auto rounded-xl border border-black/10 dark:border-white/10">
                    <table className="w-full min-w-[560px] text-left text-sm">
                      <thead className="bg-black/[0.03] text-xs uppercase tracking-wide text-text-muted dark:bg-white/[0.04]">
                        <tr>
                          <th className="px-3 py-2 font-medium">Status</th>
                          <th className="px-3 py-2 font-medium">Granted At</th>
                          <th className="px-3 py-2 font-medium">Expires At</th>
                          <th className="px-3 py-2 font-medium">Remaining</th>
                        </tr>
                      </thead>
                      <tbody>
                        {resetCreditsState.data.credits.map((credit, index) => (
                          <tr key={`${credit.status}-${credit.expiresAt || index}`} className="border-t border-black/5 dark:border-white/5">
                            <td className="px-3 py-2">
                              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                {credit.status || "unknown"}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-text-muted">{formatCreditDate(credit.grantedAt)}</td>
                            <td className="px-3 py-2 text-text-primary">{formatCreditDate(credit.expiresAt)}</td>
                            <td className="px-3 py-2 font-medium text-text-primary">{formatTimeRemaining(credit.expiresAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-black/10 bg-black/[0.02] px-3 py-8 text-center text-sm text-text-muted dark:border-white/10 dark:bg-white/[0.03]">
                  {resetCreditsState.data?.kind === "claude" ? "No limit resets available for this account." : "No reset credit details returned for this account."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <EditConnectionModal
        isOpen={showEditModal}
        connection={selectedConnection}
        focusGeminiProject={focusGeminiProject}
        proxyPools={proxyPools}
        onSave={handleUpdateConnection}
        onClose={() => {
          setShowEditModal(false);
          setSelectedConnection(null);
          setFocusGeminiProject(false);
        }}
      />

      {scheduleConnection && (
        <AutoPingScheduleModal
          isOpen={!!scheduleConnection}
          onClose={() => setScheduleConnection(null)}
          connection={scheduleConnection}
          reactive={autoPingConfigs[scheduleConnection.provider]?.connections?.[scheduleConnection.id] === true}
          schedule={autoPingConfigs[scheduleConnection.provider]?.schedules?.[scheduleConnection.id] || null}
          onSave={(result) => handleSaveAutoPing(scheduleConnection.id, scheduleConnection.provider, result)}
        />
      )}
    </div>
  );
}
