import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_SCOPED_CONFIG_FIELD,
  CHAT_SCOPED_CONFIG_OWNER_FIELD,
  FLIGHT_GUARD_LEDGER_FIELD,
  reconcileFlightModeHiddenRows,
  inspectCurrentFlightGuardStatus,
  readFlightModeState,
  findLatestBigSummaryFloorIndex,
} from '../core.js';

function createMockHost({
  chatId = 'chat-1',
  isolationKey = '',
  flightEnabled = true,
  hiddenRowIds = [],
  bigSummaryRows = [],
  chronicleRows = [],
  chatMessages = [{ is_user: false, mes: 'greeting' }],
  extraScopedConfig = {},
  preloadedLedger = null,
  historySnapshots = null,
} = {}) {
  const scopedConfig = {
    version: 1,
    template: { custom: true },
    plot: { keep: 123 },
    ...extraScopedConfig,
    flightModeByIsolationKey: {
      ...(extraScopedConfig.flightModeByIsolationKey || {}),
      [isolationKey]: {
        enabled: flightEnabled,
        enabledAt: 1700000000000,
        hiddenRowIds: [...hiddenRowIds],
        bigSummarySheetKey: 'sheet_da_zong_jie',
        archive: { chronicleExportConfig: { entryType: 'keyword' } },
      },
    },
  };

  const chat = chatMessages.map((m) => ({ ...m }));
  chat[0][CHAT_SCOPED_CONFIG_FIELD] = JSON.parse(JSON.stringify(scopedConfig));

  const chatMetadata = {
    [CHAT_SCOPED_CONFIG_FIELD]: JSON.parse(JSON.stringify(scopedConfig)),
    [CHAT_SCOPED_CONFIG_OWNER_FIELD]: chatId,
  };
  if (preloadedLedger) {
    chatMetadata[FLIGHT_GUARD_LEDGER_FIELD] = JSON.parse(JSON.stringify(preloadedLedger));
  }

  let saveMetadataCalls = 0;
  let saveMetadataDebouncedCalls = 0;
  let saveChatConditionalCalls = 0;
  let syncWorldbookCalls = 0;
  const queriedHistoryIndices = [];

  const ctx = {
    chat,
    chatId,
    chatMetadata,
    getCurrentChatId: () => chatId,
    updateChatMetadata(patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete chatMetadata[k];
        else chatMetadata[k] = JSON.parse(JSON.stringify(v));
      }
    },
    async saveMetadata() {
      saveMetadataCalls += 1;
    },
    saveMetadataDebounced() {
      saveMetadataDebouncedCalls += 1;
    },
    async saveChatConditional() {
      saveChatConditionalCalls += 1;
    },
  };

  let currentData = {
    mate: { type: 'chatSheets', version: 1 },
    sheet_da_zong_jie: {
      uid: 'sheet_da_zong_jie',
      name: '大总结',
      content: [['row_id', '总结'], ...bigSummaryRows],
    },
    sheet_chronicle: {
      uid: 'sheet_chronicle',
      name: '纪要表',
      content: [['row_id', '时间跨度', '纪要'], ...chronicleRows],
    },
  };

  const acuApi = {
    getTableHistoryContext: () => ({
      version: 1,
      chatId,
      isolationKey,
    }),
    exportTableAsJson: () => currentData,
    setLiveData(nextData) {
      currentData = nextData;
    },
    async exportTableSnapshotsAtMessages(indices) {
      queriedHistoryIndices.push([...indices]);
      if (!historySnapshots) {
        return { success: false, code: 'replay_failed', error: 'no snapshot configured' };
      }
      return {
        success: true,
        snapshots: indices.map((messageIndex) => ({
          messageIndex,
          data: JSON.parse(JSON.stringify(historySnapshots[messageIndex] || {})),
        })),
      };
    },
    async syncWorldbookEntries() {
      syncWorldbookCalls += 1;
      return true;
    },
  };

  return {
    ctx,
    acuApi,
    counters: () => ({
      saveMetadataCalls,
      saveMetadataDebouncedCalls,
      saveChatConditionalCalls,
      syncWorldbookCalls,
      queriedHistoryIndices,
    }),
  };
}

test('Repairs residual hiddenRowIds when the only big-summary floor is deleted (m drops to 0)', async () => {
  const hidden = Array.from({ length: 15 }, (_, i) => String(i + 1));
  const chronicleRows = hidden.map((id) => [id, `2026-01-0${id}`, `Event ${id}`]);

  const { ctx, acuApi, counters } = createMockHost({
    hiddenRowIds: hidden,
    bigSummaryRows: [], // 16th floor carrying the 1st big-summary row was deleted
    chronicleRows,
    extraScopedConfig: {
      template: { keepTemplate: 'yes' },
      flightModeByIsolationKey: {
        other_tag: { enabled: true, hiddenRowIds: ['99'], bigSummarySheetKey: 'sheet_da_zong_jie' },
      },
    },
  });

  const result = await reconcileFlightModeHiddenRows({ ctx, acuApi });
  assert.equal(result.status, 'repaired');
  assert.equal(result.reason, 'all_summaries_deleted');
  assert.equal(result.restoredCount, 15);
  assert.deepEqual(result.nextHidden, []);

  // Verify both chatMetadata and chat[0] synced, unrelated keys preserved
  assert.deepEqual(readFlightModeState(ctx, '').hiddenRowIds, []);
  assert.deepEqual(ctx.chat[0][CHAT_SCOPED_CONFIG_FIELD].flightModeByIsolationKey[''].hiddenRowIds, []);
  assert.deepEqual(ctx.chatMetadata[CHAT_SCOPED_CONFIG_FIELD].template, { keepTemplate: 'yes' });
  assert.deepEqual(ctx.chatMetadata[CHAT_SCOPED_CONFIG_FIELD].plot, { keep: 123 });
  assert.deepEqual(readFlightModeState(ctx, 'other_tag').hiddenRowIds, ['99']);

  const c = counters();
  assert.equal(c.saveMetadataCalls, 1);
  assert.equal(c.saveChatConditionalCalls, 1);
  assert.equal(c.syncWorldbookCalls, 1);
});

test('Multi-stage rollback via snapshot ledger restores stage-2 rows while keeping stage-1 rows hidden', async () => {
  const chronicleRows = [
    ['1', 't1', 'c1'],
    ['2', 't2', 'c2'],
    ['3', 't3', 'c3'],
    ['4', 't4', 'c4'],
    ['5', 't5', 'c5'],
  ];

  // Stage 1: first big summary created hiding ['1', '2']
  const { ctx, acuApi, counters } = createMockHost({
    hiddenRowIds: ['1', '2'],
    bigSummaryRows: [['1', 'Summary stage 1']],
    chronicleRows,
  });

  const step1 = await reconcileFlightModeHiddenRows({ ctx, acuApi });
  assert.equal(step1.status, 'ledger_updated');

  // Stage 2: second big summary created hiding ['1', '2', '3', '4'], row '5' added same turn
  ctx.chatMetadata[CHAT_SCOPED_CONFIG_FIELD].flightModeByIsolationKey[''].hiddenRowIds = ['1', '2', '3', '4'];
  ctx.chat[0][CHAT_SCOPED_CONFIG_FIELD].flightModeByIsolationKey[''].hiddenRowIds = ['1', '2', '3', '4'];
  acuApi.setLiveData({
    sheet_da_zong_jie: {
      uid: 'sheet_da_zong_jie',
      name: '大总结',
      content: [['row_id', '总结'], ['1', 'Summary stage 1'], ['2', 'Summary stage 2']],
    },
    sheet_chronicle: {
      uid: 'sheet_chronicle',
      name: '纪要表',
      content: [['row_id', '时间跨度', '纪要'], ...chronicleRows],
    },
  });

  const step2 = await reconcileFlightModeHiddenRows({ ctx, acuApi });
  assert.equal(step2.status, 'ledger_updated');

  // User deletes the floor that created stage-2 big summary (row '5' also disappears,大总结 rolls back to ['1'])
  acuApi.setLiveData({
    sheet_da_zong_jie: {
      uid: 'sheet_da_zong_jie',
      name: '大总结',
      content: [['row_id', '总结'], ['1', 'Summary stage 1']],
    },
    sheet_chronicle: {
      uid: 'sheet_chronicle',
      name: '纪要表',
      content: [['row_id', '时间跨度', '纪要'], ...chronicleRows.slice(0, 4)],
    },
  });

  const step3 = await reconcileFlightModeHiddenRows({ ctx, acuApi });
  assert.equal(step3.status, 'repaired');
  assert.equal(step3.reason, 'rolled_back_to_ledger_snapshot');
  assert.deepEqual(step3.previousHidden, ['1', '2', '3', '4']);
  assert.deepEqual(step3.nextHidden, ['1', '2']);
  assert.equal(step3.restoredCount, 2);
  assert.deepEqual(readFlightModeState(ctx, '').hiddenRowIds, ['1', '2']);
  assert.equal(counters().syncWorldbookCalls, 1);
});

test('Pre-existing chat rollback without prior ledger recovers exact hidden set via exportTableSnapshotsAtMessages', async () => {
  // Chat messages: 0 = full checkpoint, 1..2 = stage 1, 3 = stage 1 big-summary insertion, 4..5 = more turns (2nd big summary floor deleted)
  const chatMessages = [
    {
      is_user: false,
      mes: 'init',
      TavernDB_ACU_IsolatedData: {
        '': { storageFrame: { checkpoint: { kind: 'full' }, logEntries: [] } },
      },
    },
    { is_user: true, mes: 'u1' },
    { is_user: false, mes: 'a1' },
    {
      is_user: false,
      mes: 'a2-big-summary-1',
      TavernDB_ACU_IsolatedData: {
        '': {
          storageFrame: {
            logEntries: [{ changedSheetKeys: ['sheet_da_zong_jie', 'sheet_chronicle'] }],
          },
        },
      },
    },
    { is_user: true, mes: 'u3' },
    { is_user: false, mes: 'a3' },
  ];

  const chronicleRows = [
    ['1', 't1', 'c1'],
    ['2', 't2', 'c2'],
    ['3', 't3', 'c3'],
    ['4', 't4', 'c4'],
  ];

  const { ctx, acuApi, counters } = createMockHost({
    hiddenRowIds: ['1', '2', '3', '4'], // stale IDs leaked from deleted 2nd big-summary floor
    bigSummaryRows: [['1', 'Summary stage 1']],
    chronicleRows,
    chatMessages,
    historySnapshots: {
      // Snapshot right before index 3 (at kStar - 1 = 2) only had rows '1' and '2'
      2: {
        sheet_chronicle: {
          uid: 'sheet_chronicle',
          name: '纪要表',
          content: [['row_id', '时间跨度', '纪要'], ['1', 't1', 'c1'], ['2', 't2', 'c2']],
        },
      },
    },
  });

  assert.equal(findLatestBigSummaryFloorIndex(ctx.chat, '', 'sheet_da_zong_jie'), 3);

  const result = await reconcileFlightModeHiddenRows({ ctx, acuApi });
  assert.equal(result.status, 'repaired');
  assert.equal(result.reason, 'rolled_back_via_history_snapshot');
  assert.deepEqual(result.nextHidden, ['1', '2']);
  assert.equal(result.restoredCount, 2);
  assert.deepEqual(counters().queriedHistoryIndices, [[2]]);
  assert.equal(counters().syncWorldbookCalls, 1);
});

test('Safety guards: skips disabled flight mode, empty/unloaded tables, and leaves steady state untouched', async () => {
  // 1. Flight mode disabled
  const disabledHost = createMockHost({
    flightEnabled: false,
    hiddenRowIds: ['1', '2'],
    bigSummaryRows: [],
  });
  const r1 = await reconcileFlightModeHiddenRows(disabledHost);
  assert.equal(r1.status, 'skipped_disabled');
  assert.deepEqual(readFlightModeState(disabledHost.ctx, '').hiddenRowIds, ['1', '2']);

  // 2. exportTableAsJson returns empty object (not yet hydrated into runtime)
  const unloadedHost = createMockHost({
    flightEnabled: true,
    hiddenRowIds: ['1', '2'],
  });
  unloadedHost.acuApi.exportTableAsJson = () => ({});
  const r2 = await reconcileFlightModeHiddenRows(unloadedHost);
  assert.equal(r2.status, 'skipped_not_ready');
  assert.deepEqual(readFlightModeState(unloadedHost.ctx, '').hiddenRowIds, ['1', '2']);

  // 3. Normal steady state (ledger recorded, re-running is a no-op ok)
  const steadyHost = createMockHost({
    flightEnabled: true,
    hiddenRowIds: ['1', '2'],
    bigSummaryRows: [['1', 'Summary 1']],
    chronicleRows: [['1', 't1', 'c1'], ['2', 't2', 'c2'], ['3', 't3', 'c3']],
  });
  const first = await reconcileFlightModeHiddenRows(steadyHost);
  assert.equal(first.status, 'ledger_updated');
  const second = await reconcileFlightModeHiddenRows(steadyHost);
  assert.equal(second.status, 'ok');
  assert.equal(steadyHost.counters().syncWorldbookCalls, 0);

  const statusSummary = inspectCurrentFlightGuardStatus(steadyHost);
  assert.deepEqual(statusSummary, {
    connected: true,
    hasChat: true,
    classicEnabled: true,
    summaryCount: 1,
    hiddenCount: 2,
    ledgerCount: 1,
  });
});
