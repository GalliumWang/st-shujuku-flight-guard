/**
 * Pure core logic for st-shujuku-flight-guard.
 * Reconciles shujuku (龙血玄黄·数据库) classic-mode `hiddenRowIds` when
 * chat floors containing `大总结` insertions are deleted or rolled back.
 */

export const CHAT_SCOPED_CONFIG_FIELD = 'TavernDB_ACU_ScopedConfig';
export const CHAT_SCOPED_CONFIG_OWNER_FIELD = 'TavernDB_ACU_ScopedConfig__chatId';
export const FLIGHT_GUARD_LEDGER_FIELD = 'TavernDB_FlightGuard_Ledger';
export const DEFAULT_BIG_SUMMARY_SHEET_KEY = 'sheet_da_zong_jie';
export const BIG_SUMMARY_SHEET_NAME = '大总结';
export const CHRONICLE_SHEET_NAME = '纪要表';

/**
 * Safely clones plain JSON-compatible values.
 * @param {unknown} value
 * @returns {any}
 */
function cloneJson(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Parses a container that may be stored as an object or JSON string.
 * @param {unknown} raw
 * @returns {Record<string, any> | null}
 */
function parseObjectContainer(raw) {
  if (!raw) return null;
  let parsed = raw;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed;
  }
  return null;
}

/**
 * Normalizes and sorts unique row IDs as non-empty strings.
 * @param {unknown} list
 * @returns {string[]}
 */
export function normalizeRowIds(list) {
  if (!Array.isArray(list)) return [];
  const ids = new Set();
  for (const item of list) {
    if (item === null || item === undefined) continue;
    const trimmed = String(item).trim();
    if (trimmed) ids.add(trimmed);
  }
  return [...ids].sort();
}

/**
 * Checks shallow equality between two string arrays.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {boolean}
 */
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Resolves active chat identity using the same contract as shujuku/src/data/storage/chat-history.ts.
 * @param {any} ctx
 * @returns {string}
 */
export function getActiveChatId(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  if (!Array.isArray(ctx.chat) || ctx.chat.length === 0 || !ctx.chat[0] || typeof ctx.chat[0] !== 'object') {
    return '';
  }

  let hasChatIdApi = false;
  try {
    if (typeof ctx.getCurrentChatId === 'function') {
      hasChatIdApi = true;
      const id = String(ctx.getCurrentChatId() ?? '').trim();
      return id && id !== 'null' && id !== 'undefined' ? id : '';
    }
    if (Object.prototype.hasOwnProperty.call(ctx, 'chatId')) {
      hasChatIdApi = true;
      const id = String(ctx.chatId ?? '').trim();
      return id && id !== 'null' && id !== 'undefined' ? id : '';
    }
  } catch {
    return '';
  }

  return hasChatIdApi ? '' : '__host_without_chat_id__';
}

function mergeObjectSlots(target, fallback) {
  for (const [key, value] of Object.entries(fallback)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = cloneJson(value);
    }
  }
}

/**
 * Reads the merged TavernDB_ACU_ScopedConfig container (chatMetadata prioritized over chat[0] fallback).
 * @param {any} ctx
 * @returns {Record<string, any> | null}
 */
export function readScopedConfigContainer(ctx) {
  const activeChatId = getActiveChatId(ctx);
  if (!activeChatId) return null;

  const metadata = ctx.chatMetadata && typeof ctx.chatMetadata === 'object' && !Array.isArray(ctx.chatMetadata)
    ? ctx.chatMetadata
    : null;
  const owner = String(metadata?.[CHAT_SCOPED_CONFIG_OWNER_FIELD] ?? '').trim();
  const realChatId = activeChatId === '__host_without_chat_id__' ? '' : activeChatId;
  const metadataApplies = !realChatId || !owner || owner === realChatId;

  const metadataContainer = metadataApplies
    ? parseObjectContainer(metadata?.[CHAT_SCOPED_CONFIG_FIELD])
    : null;
  const legacyContainer = parseObjectContainer(ctx.chat?.[0]?.[CHAT_SCOPED_CONFIG_FIELD]);

  if (!metadataContainer && !legacyContainer) return null;
  if (!metadataContainer) return cloneJson(legacyContainer);
  if (!legacyContainer) return cloneJson(metadataContainer);

  const merged = cloneJson(metadataContainer);
  for (const [key, value] of Object.entries(legacyContainer)) {
    if (key === 'version') continue;
    const targetValue = merged[key];
    if (
      value && typeof value === 'object' && !Array.isArray(value)
      && targetValue && typeof targetValue === 'object' && !Array.isArray(targetValue)
    ) {
      mergeObjectSlots(targetValue, value);
    } else if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      merged[key] = cloneJson(value);
    }
  }
  return merged;
}

/**
 * Reads classic (flight) mode state for the given isolationKey.
 * @param {any} ctx
 * @param {string} [isolationKey='']
 * @returns {{ enabled: boolean, enabledAt: number, hiddenRowIds: string[], bigSummarySheetKey: string }}
 */
export function readFlightModeState(ctx, isolationKey = '') {
  const container = readScopedConfigContainer(ctx);
  const slotKey = String(isolationKey ?? '');
  const states = container?.flightModeByIsolationKey;
  const raw = states && typeof states === 'object' && !Array.isArray(states)
    ? states[slotKey]
    : null;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      enabled: false,
      enabledAt: 0,
      hiddenRowIds: [],
      bigSummarySheetKey: DEFAULT_BIG_SUMMARY_SHEET_KEY,
    };
  }

  return {
    enabled: raw.enabled === true,
    enabledAt: Number.isFinite(raw.enabledAt) ? Math.max(0, Math.trunc(raw.enabledAt)) : 0,
    hiddenRowIds: normalizeRowIds(raw.hiddenRowIds),
    bigSummarySheetKey: String(raw.bigSummarySheetKey || DEFAULT_BIG_SUMMARY_SHEET_KEY).trim() || DEFAULT_BIG_SUMMARY_SHEET_KEY,
  };
}

/**
 * Updates only `flightModeByIsolationKey[isolationKey].hiddenRowIds` inside
 * `chatMetadata` and `chat[0]` while keeping all other scoped fields intact.
 * @param {any} ctx
 * @param {string} isolationKey
 * @param {string[]} nextHiddenRowIds
 */
export function writeFlightModeHiddenRowIds(ctx, isolationKey, nextHiddenRowIds) {
  const activeChatId = getActiveChatId(ctx);
  if (!activeChatId) return;

  const slotKey = String(isolationKey ?? '');
  const normalizedIds = normalizeRowIds(nextHiddenRowIds);
  const container = cloneJson(readScopedConfigContainer(ctx) || {});
  if (!Number.isFinite(container.version)) {
    container.version = 1;
  } else {
    container.version = Math.max(1, Math.trunc(container.version));
  }

  const prevStates = container.flightModeByIsolationKey && typeof container.flightModeByIsolationKey === 'object' && !Array.isArray(container.flightModeByIsolationKey)
    ? container.flightModeByIsolationKey
    : {};
  const prevSlot = prevStates[slotKey] && typeof prevStates[slotKey] === 'object' && !Array.isArray(prevStates[slotKey])
    ? prevStates[slotKey]
    : {};

  container.flightModeByIsolationKey = {
    ...prevStates,
    [slotKey]: {
      ...prevSlot,
      hiddenRowIds: normalizedIds,
    },
  };

  const realChatId = activeChatId === '__host_without_chat_id__' ? '' : activeChatId;
  if (ctx.chatMetadata && typeof ctx.chatMetadata === 'object') {
    ctx.chatMetadata[CHAT_SCOPED_CONFIG_FIELD] = cloneJson(container);
    if (realChatId) {
      ctx.chatMetadata[CHAT_SCOPED_CONFIG_OWNER_FIELD] = realChatId;
    } else {
      delete ctx.chatMetadata[CHAT_SCOPED_CONFIG_OWNER_FIELD];
    }
  }

  if (typeof ctx.updateChatMetadata === 'function') {
    try {
      ctx.updateChatMetadata(
        {
          [CHAT_SCOPED_CONFIG_FIELD]: cloneJson(container),
          [CHAT_SCOPED_CONFIG_OWNER_FIELD]: realChatId || undefined,
        },
        false,
      );
    } catch {
      // Best-effort host metadata notification; direct assignment above remains authoritative.
    }
  }

  if (ctx.chat?.[0] && typeof ctx.chat[0] === 'object') {
    ctx.chat[0][CHAT_SCOPED_CONFIG_FIELD] = cloneJson(container);
  }
}

function emptySlotLedger() {
  return {
    snapshots: {},
    lastSummaryRowIds: [],
  };
}

/**
 * Reads per-chat, per-isolationKey snapshot ledger from `chatMetadata`.
 * Resets automatically if stored for a different `chatId`.
 * @param {any} ctx
 * @param {string} activeChatId
 * @param {string} isolationKey
 * @returns {{ snapshots: Record<string, string[]>, lastSummaryRowIds: string[] }}
 */
export function readGuardLedger(ctx, activeChatId, isolationKey) {
  const raw = parseObjectContainer(ctx?.chatMetadata?.[FLIGHT_GUARD_LEDGER_FIELD]);
  if (!raw || raw.chatId !== activeChatId) {
    return emptySlotLedger();
  }
  const slotKey = String(isolationKey ?? '');
  const slot = raw.byIsolationKey?.[slotKey];
  if (!slot || typeof slot !== 'object' || Array.isArray(slot)) {
    return emptySlotLedger();
  }

  const cleanSnapshots = {};
  if (slot.snapshots && typeof slot.snapshots === 'object' && !Array.isArray(slot.snapshots)) {
    for (const [rowId, hidden] of Object.entries(slot.snapshots)) {
      const cleanId = String(rowId).trim();
      if (cleanId) cleanSnapshots[cleanId] = normalizeRowIds(hidden);
    }
  }

  const cleanLastRowIds = Array.isArray(slot.lastSummaryRowIds)
    ? slot.lastSummaryRowIds.map((id) => String(id ?? '').trim()).filter(Boolean)
    : [];

  return {
    snapshots: cleanSnapshots,
    lastSummaryRowIds: cleanLastRowIds,
  };
}

/**
 * Writes the per-slot snapshot ledger into `ctx.chatMetadata`.
 * @param {any} ctx
 * @param {string} activeChatId
 * @param {string} isolationKey
 * @param {{ snapshots: Record<string, string[]>, lastSummaryRowIds: string[] }} slotLedger
 */
export function writeGuardLedger(ctx, activeChatId, isolationKey, slotLedger) {
  if (!ctx?.chatMetadata || typeof ctx.chatMetadata !== 'object') return;
  const raw = parseObjectContainer(ctx.chatMetadata[FLIGHT_GUARD_LEDGER_FIELD]);
  const root = raw && raw.chatId === activeChatId
    ? cloneJson(raw)
    : { version: 1, chatId: activeChatId, byIsolationKey: {} };

  if (!root.byIsolationKey || typeof root.byIsolationKey !== 'object' || Array.isArray(root.byIsolationKey)) {
    root.byIsolationKey = {};
  }
  root.byIsolationKey[String(isolationKey ?? '')] = cloneJson(slotLedger);
  ctx.chatMetadata[FLIGHT_GUARD_LEDGER_FIELD] = root;

  if (typeof ctx.updateChatMetadata === 'function') {
    try {
      ctx.updateChatMetadata({ [FLIGHT_GUARD_LEDGER_FIELD]: cloneJson(root) }, false);
    } catch {
      // Ignore host notification failure.
    }
  }
}

function keyListIncludes(list, targetKey) {
  return Array.isArray(list) && list.includes(targetKey);
}

function v2OperationTouchesSheet(operation, targetKey) {
  if (!operation || typeof operation !== 'object') return false;
  if (operation.sheetKey === targetKey) return true;
  if (operation.kind === 'data_replace') return Boolean(operation.data?.[targetKey]);
  if (operation.kind === 'sql_batch' && typeof operation.sql === 'string') {
    return /\bflight_big_summary\b/i.test(operation.sql);
  }
  return false;
}

function v2EntryTouchesSheet(entry, targetKey) {
  if (!entry || typeof entry !== 'object') return false;
  return (
    keyListIncludes(entry.changedSheetKeys, targetKey)
    || keyListIncludes(entry.filledSheetKeys, targetKey)
    || keyListIncludes(entry.groupKeys, targetKey)
    || (Array.isArray(entry.operations) && entry.operations.some((op) => v2OperationTouchesSheet(op, targetKey)))
    || (Array.isArray(entry.patches) && entry.patches.some((patch) => patch?.sheetKey === targetKey))
  );
}

/**
 * Finds the most recent chat message index after the latest full checkpoint
 * whose V2 storageFrame wrote to `bigSummarySheetKey`. Returns -1 if none.
 * @param {any[]} chat
 * @param {string} isolationKey
 * @param {string} bigSummarySheetKey
 * @returns {number}
 */
export function findLatestBigSummaryFloorIndex(chat, isolationKey, bigSummarySheetKey) {
  if (!Array.isArray(chat) || chat.length === 0 || !bigSummarySheetKey) return -1;
  const slotKey = String(isolationKey ?? '');

  const readFrame = (msg) => {
    const tagData = parseObjectContainer(msg?.TavernDB_ACU_IsolatedData?.[slotKey]);
    const frame = parseObjectContainer(tagData?.storageFrame);
    return frame;
  };

  let latestFullCheckpointIndex = -1;
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const frame = readFrame(chat[i]);
    if (frame?.checkpoint?.kind === 'full') {
      latestFullCheckpointIndex = i;
      break;
    }
  }

  const lowerBound = Math.max(0, latestFullCheckpointIndex + 1);
  for (let i = chat.length - 1; i >= lowerBound; i -= 1) {
    const frame = readFrame(chat[i]);
    if (!frame) continue;
    if (frame.perSheetCheckpoints?.[bigSummarySheetKey]?.kind === 'sheet_full') {
      return i;
    }
    if (Array.isArray(frame.logEntries) && frame.logEntries.some((entry) => v2EntryTouchesSheet(entry, bigSummarySheetKey))) {
      return i;
    }
  }

  return -1;
}

function findSheet(tableData, preferredKey, fallbackName) {
  if (!tableData || typeof tableData !== 'object') return null;
  if (preferredKey && tableData[preferredKey]?.name) {
    return tableData[preferredKey];
  }
  return Object.entries(tableData).find(([key, sheet]) => key.startsWith('sheet_') && sheet?.name === fallbackName)?.[1] || null;
}

function extractOrderedRowIds(sheet) {
  if (!Array.isArray(sheet?.content)) return [];
  const ids = [];
  for (const row of sheet.content.slice(1)) {
    if (!Array.isArray(row)) continue;
    const id = String(row[0] ?? '').trim();
    if (id) ids.push(id);
  }
  return ids;
}

function snapshotLedgerEquals(a, b) {
  if (!arraysEqual(a.lastSummaryRowIds, b.lastSummaryRowIds)) return false;
  const aKeys = Object.keys(a.snapshots).sort();
  const bKeys = Object.keys(b.snapshots).sort();
  if (!arraysEqual(aKeys, bKeys)) return false;
  return aKeys.every((key) => arraysEqual(a.snapshots[key], b.snapshots[key]));
}

async function persistHostMetadataAndChat(ctx, { saveChat }) {
  try {
    if (typeof ctx.saveMetadata === 'function') {
      await ctx.saveMetadata();
    } else if (typeof ctx.saveMetadataDebounced === 'function') {
      ctx.saveMetadataDebounced();
    }
  } catch {
    // Best-effort metadata persistence.
  }

  if (!saveChat) return;
  try {
    if (typeof ctx.saveChatConditional === 'function') {
      await ctx.saveChatConditional();
    } else if (typeof ctx.saveChat === 'function') {
      await ctx.saveChat();
    }
  } catch {
    // Best-effort chat persistence.
  }
}

/**
 * Reconciles shujuku classic-mode `hiddenRowIds` against surviving `大总结` rows
 * and refreshes worldbook entries immediately whenever stale hidden IDs are repaired.
 *
 * @param {{ ctx: any, acuApi: any }} params
 * @returns {Promise<{
 *   status: 'skipped_disabled' | 'skipped_not_ready' | 'repaired' | 'ledger_updated' | 'ok',
 *   reason?: string,
 *   previousHidden?: string[],
 *   nextHidden?: string[],
 *   currentHidden?: string[],
 *   restoredCount?: number,
 *   summaryCount?: number,
 * }>}
 */
export async function reconcileFlightModeHiddenRows({ ctx, acuApi }) {
  const activeChatId = getActiveChatId(ctx);
  if (!activeChatId || !acuApi) {
    return { status: 'skipped_not_ready' };
  }

  const historyContext = typeof acuApi.getTableHistoryContext === 'function'
    ? acuApi.getTableHistoryContext()
    : null;
  const isolationKey = String(historyContext?.isolationKey ?? '');

  const flightState = readFlightModeState(ctx, isolationKey);
  if (!flightState.enabled) {
    return { status: 'skipped_disabled' };
  }

  const liveData = typeof acuApi.exportTableAsJson === 'function' ? acuApi.exportTableAsJson() : null;
  const bigSummarySheet = findSheet(liveData, flightState.bigSummarySheetKey, BIG_SUMMARY_SHEET_NAME);
  if (!bigSummarySheet || !Array.isArray(bigSummarySheet.content)) {
    return { status: 'skipped_not_ready' };
  }

  const chronicleSheet = findSheet(liveData, '', CHRONICLE_SHEET_NAME);
  const chronicleRowIds = extractOrderedRowIds(chronicleSheet);
  const chronicleRowIdSet = new Set(chronicleRowIds);

  const summaryRowIds = extractOrderedRowIds(bigSummarySheet);
  const currentHidden = flightState.hiddenRowIds;
  const m = summaryRowIds.length;
  const latestSummaryId = m > 0 ? summaryRowIds[m - 1] : null;

  const prevLedger = readGuardLedger(ctx, activeChatId, isolationKey);
  const nextLedger = cloneJson(prevLedger);

  let needsRepair = false;
  let repairReason = '';
  let expectedHidden = currentHidden;

  if (m === 0) {
    nextLedger.snapshots = {};
    nextLedger.lastSummaryRowIds = [];
    expectedHidden = [];
    if (currentHidden.length > 0) {
      needsRepair = true;
      repairReason = 'all_summaries_deleted';
    }
  } else {
    const summaryIdSet = new Set(summaryRowIds);
    const hadExtraLedgerKeys = Object.keys(nextLedger.snapshots).some((key) => !summaryIdSet.has(key));
    const shrunkCount = m < prevLedger.lastSummaryRowIds.length;

    for (const key of Object.keys(nextLedger.snapshots)) {
      if (!summaryIdSet.has(key)) {
        delete nextLedger.snapshots[key];
      }
    }

    if ((hadExtraLedgerKeys || shrunkCount) && Array.isArray(nextLedger.snapshots[latestSummaryId])) {
      expectedHidden = normalizeRowIds(nextLedger.snapshots[latestSummaryId]).filter(
        (id) => chronicleRowIdSet.size === 0 || chronicleRowIdSet.has(id),
      );
      nextLedger.snapshots[latestSummaryId] = expectedHidden;
      if (!arraysEqual(currentHidden, expectedHidden)) {
        needsRepair = true;
        repairReason = 'rolled_back_to_ledger_snapshot';
      }
    } else if (!Array.isArray(nextLedger.snapshots[latestSummaryId])) {
      let resolvedViaSnapshot = false;
      const kStar = findLatestBigSummaryFloorIndex(ctx.chat, isolationKey, flightState.bigSummarySheetKey);

      if (kStar > 0 && typeof acuApi.exportTableSnapshotsAtMessages === 'function') {
        try {
          const snap = await acuApi.exportTableSnapshotsAtMessages([kStar - 1]);
          const beforeData = snap?.success ? snap.snapshots?.[0]?.data : null;
          const beforeChronicle = findSheet(beforeData, '', CHRONICLE_SHEET_NAME);
          if (beforeChronicle && Array.isArray(beforeChronicle.content)) {
            const beforeChronicleIdSet = new Set(extractOrderedRowIds(beforeChronicle));
            const candidateHidden = currentHidden.filter(
              (id) => beforeChronicleIdSet.has(id) && (chronicleRowIdSet.size === 0 || chronicleRowIdSet.has(id)),
            );
            resolvedViaSnapshot = true;
            if (candidateHidden.length < currentHidden.length) {
              expectedHidden = candidateHidden;
              needsRepair = true;
              repairReason = 'rolled_back_via_history_snapshot';
            }
          }
        } catch {
          // Fall back to chronicle existence filtering below.
        }
      }

      if (!resolvedViaSnapshot && chronicleSheet) {
        const existingFiltered = currentHidden.filter((id) => chronicleRowIdSet.has(id));
        if (existingFiltered.length < currentHidden.length) {
          expectedHidden = existingFiltered;
          needsRepair = true;
          repairReason = 'pruned_nonexistent_chronicle_ids';
        }
      }

      nextLedger.snapshots[latestSummaryId] = expectedHidden;
    } else {
      const prunedExisting = chronicleSheet
        ? currentHidden.filter((id) => chronicleRowIdSet.has(id))
        : currentHidden;
      if (prunedExisting.length < currentHidden.length) {
        expectedHidden = prunedExisting;
        needsRepair = true;
        repairReason = 'pruned_nonexistent_chronicle_ids';
      }
      nextLedger.snapshots[latestSummaryId] = expectedHidden;
    }

    nextLedger.lastSummaryRowIds = [...summaryRowIds];
  }

  const ledgerChanged = !snapshotLedgerEquals(prevLedger, nextLedger);
  if (ledgerChanged) {
    writeGuardLedger(ctx, activeChatId, isolationKey, nextLedger);
  }

  if (needsRepair) {
    writeFlightModeHiddenRowIds(ctx, isolationKey, expectedHidden);
    await persistHostMetadataAndChat(ctx, { saveChat: true });
    if (typeof acuApi.syncWorldbookEntries === 'function') {
      await acuApi.syncWorldbookEntries({ createIfNeeded: true });
    }
    return {
      status: 'repaired',
      reason: repairReason,
      previousHidden: currentHidden,
      nextHidden: expectedHidden,
      restoredCount: Math.max(0, currentHidden.length - expectedHidden.length),
      summaryCount: m,
    };
  }

  if (ledgerChanged) {
    try {
      if (typeof ctx.saveMetadataDebounced === 'function') {
        ctx.saveMetadataDebounced();
      } else if (typeof ctx.saveMetadata === 'function') {
        await ctx.saveMetadata();
      }
    } catch {
      // Ignore metadata save error when only ledger updated.
    }
    return {
      status: 'ledger_updated',
      currentHidden,
      summaryCount: m,
    };
  }

  return {
    status: 'ok',
    currentHidden,
    summaryCount: m,
  };
}

/**
 * Inspects current classic mode and ledger state without mutating anything (for settings UI display).
 * @param {{ ctx: any, acuApi: any }} params
 */
export function inspectCurrentFlightGuardStatus({ ctx, acuApi }) {
  const connected = Boolean(acuApi && typeof acuApi.exportTableAsJson === 'function');
  const activeChatId = getActiveChatId(ctx);
  if (!activeChatId) {
    return {
      connected,
      hasChat: false,
      classicEnabled: false,
      summaryCount: 0,
      hiddenCount: 0,
      ledgerCount: 0,
    };
  }

  const isolationKey = String(acuApi?.getTableHistoryContext?.()?.isolationKey ?? '');
  const flightState = readFlightModeState(ctx, isolationKey);
  const liveData = connected ? acuApi.exportTableAsJson() : null;
  const bigSummarySheet = findSheet(liveData, flightState.bigSummarySheetKey, BIG_SUMMARY_SHEET_NAME);
  const summaryCount = extractOrderedRowIds(bigSummarySheet).length;
  const ledger = readGuardLedger(ctx, activeChatId, isolationKey);

  return {
    connected,
    hasChat: true,
    classicEnabled: flightState.enabled,
    summaryCount,
    hiddenCount: flightState.hiddenRowIds.length,
    ledgerCount: Object.keys(ledger.snapshots).length,
  };
}
