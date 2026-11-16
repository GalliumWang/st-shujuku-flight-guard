import {
  inspectCurrentFlightGuardStatus,
  reconcileFlightModeHiddenRows,
} from './core.js';

const EXTENSION_KEY = 'st_shujuku_flight_guard';
const SINGLETON_KEY = '__ST_SHUJUKU_FLIGHT_GUARD_LOADED__';
const LOG_PREFIX = '[ACU-Flight-Guard]';

const DEFAULT_SETTINGS = {
  enabled: true,
  showToast: true,
};

let isFilling = false;
let isSelfSyncing = false;
let reconcileInFlight = false;
let pendingRerun = false;
let pendingReason = '';
let reconcileTimer = null;
let hookedAcuApi = null;
let tableUpdateHandler = null;
let tableFillStartHandler = null;

function getCtx() {
  try {
    return globalThis.SillyTavern?.getContext?.() || null;
  } catch {
    return null;
  }
}

function getAcuApi() {
  return globalThis.AutoCardUpdaterAPI || null;
}

function ensureExtensionSettings(ctx) {
  if (!ctx || !ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') {
    return { ...DEFAULT_SETTINGS };
  }
  const existing = ctx.extensionSettings[EXTENSION_KEY];
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    ctx.extensionSettings[EXTENSION_KEY] = { ...DEFAULT_SETTINGS };
  } else {
    if (typeof existing.enabled !== 'boolean') existing.enabled = DEFAULT_SETTINGS.enabled;
    if (typeof existing.showToast !== 'boolean') existing.showToast = DEFAULT_SETTINGS.showToast;
  }
  return ctx.extensionSettings[EXTENSION_KEY];
}

function notifyToast(type, message) {
  try {
    const toastrApi = globalThis.toastr;
    if (toastrApi && typeof toastrApi[type] === 'function') {
      toastrApi[type](message, '大总结删楼守护');
    }
  } catch {
    // Ignore toast failures in headless/non-UI hosts.
  }
}

function updateStatusUi() {
  const statusEl = document.getElementById('acu-fg-status-box');
  if (!statusEl) return;

  const ctx = getCtx();
  const acuApi = getAcuApi();
  const status = inspectCurrentFlightGuardStatus({ ctx, acuApi });

  const setField = (id, text) => {
    const node = document.getElementById(id);
    if (node) node.textContent = text;
  };

  setField('acu-fg-status-acu', status.connected ? '已连接 AutoCardUpdaterAPI' : '等待数据库插件就绪...');
  if (!status.hasChat) {
    setField('acu-fg-status-mode', '未打开对话');
    setField('acu-fg-status-summary', '—');
    setField('acu-fg-status-hidden', '—');
    setField('acu-fg-status-ledger', '—');
    return;
  }

  setField('acu-fg-status-mode', status.classicEnabled ? '经典表格模式 (已开启)' : '非经典模式 (未开启)');
  setField('acu-fg-status-summary', `${status.summaryCount} 条`);
  setField('acu-fg-status-hidden', `${status.hiddenCount} 条`);
  setField('acu-fg-status-ledger', `${status.ledgerCount} 个阶段快照`);
}

async function runReconcile(reason, { manual = false } = {}) {
  const ctx = getCtx();
  const settings = ensureExtensionSettings(ctx);
  if (!manual && !settings.enabled) {
    updateStatusUi();
    return null;
  }
  if (!manual && isFilling) {
    return null;
  }

  const acuApi = getAcuApi();
  if (!ctx || !acuApi) {
    updateStatusUi();
    if (manual) notifyToast('warning', '数据库插件 (AutoCardUpdaterAPI) 尚未就绪。');
    return null;
  }

  if (reconcileInFlight) {
    pendingRerun = true;
    pendingReason = reason;
    return null;
  }

  reconcileInFlight = true;
  try {
    isSelfSyncing = true;
    const result = await reconcileFlightModeHiddenRows({ ctx, acuApi });
    updateStatusUi();

    if (result?.status === 'repaired') {
      console.info(
        `${LOG_PREFIX} [${reason}] 已修复隐藏纪要 (${result.reason}): 恢复 ${result.restoredCount} 条可见纪要 (hiddenRowIds: ${result.previousHidden.length} -> ${result.nextHidden.length})`,
      );
      if (settings.showToast || manual) {
        notifyToast(
          'success',
          `检测到“大总结”回退，已自动恢复 ${result.restoredCount} 条被隐藏的纪要并刷新世界书。`,
        );
      }
    } else if (manual) {
      if (result?.status === 'skipped_disabled') {
        notifyToast('info', '当前对话未开启经典表格模式，无需处理。');
      } else if (result?.status === 'skipped_not_ready') {
        notifyToast('warning', '当前对话尚未加载大总结表数据，请稍后再试。');
      } else {
        notifyToast('info', `检查完成：当前大总结 ${result?.summaryCount ?? 0} 条，隐藏纪要与状态一致。`);
      }
    }

    return result;
  } catch (error) {
    console.warn(`${LOG_PREFIX} [${reason}] 对齐检查失败:`, error);
    if (manual) {
      notifyToast('error', `检查失败: ${error?.message || String(error)}`);
    }
    return null;
  } finally {
    // Allow shujuku's synchronous _notifyTableUpdate callbacks triggered by syncWorldbookEntries to settle before clearing.
    setTimeout(() => {
      isSelfSyncing = false;
    }, 50);
    reconcileInFlight = false;
    if (pendingRerun) {
      const nextReason = pendingReason || 'queued';
      pendingRerun = false;
      pendingReason = '';
      scheduleReconcile(nextReason, 150);
    }
  }
}

function scheduleReconcile(reason, delayMs = 200) {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void runReconcile(reason);
  }, delayMs);
}

function attachAcuHooks() {
  const acuApi = getAcuApi();
  if (!acuApi || hookedAcuApi === acuApi) {
    return Boolean(hookedAcuApi);
  }
  if (
    typeof acuApi.registerTableUpdateCallback !== 'function'
    || typeof acuApi.exportTableAsJson !== 'function'
  ) {
    return false;
  }

  tableFillStartHandler = () => {
    isFilling = true;
  };
  tableUpdateHandler = () => {
    isFilling = false;
    if (isSelfSyncing) return;
    scheduleReconcile('acu_table_update', 180);
  };

  if (typeof acuApi.registerTableFillStartCallback === 'function') {
    acuApi.registerTableFillStartCallback(tableFillStartHandler);
  }
  acuApi.registerTableUpdateCallback(tableUpdateHandler);
  hookedAcuApi = acuApi;
  updateStatusUi();
  console.info(`${LOG_PREFIX} 已挂接 AutoCardUpdaterAPI 回调。`);
  return true;
}

function waitForAcuHooks(maxWaitMs = 60000) {
  if (attachAcuHooks()) {
    scheduleReconcile('init', 400);
    return;
  }
  const startedAt = Date.now();
  const pollTimer = setInterval(() => {
    if (attachAcuHooks()) {
      clearInterval(pollTimer);
      scheduleReconcile('init_poll', 400);
      return;
    }
    if (Date.now() - startedAt >= maxWaitMs) {
      clearInterval(pollTimer);
      updateStatusUi();
    }
  }, 300);
}

function mountSettingsPanel() {
  if (document.getElementById('acu-flight-guard-settings')) return;
  const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
  if (!container) return;

  const ctx = getCtx();
  const settings = ensureExtensionSettings(ctx);

  const wrapper = document.createElement('div');
  wrapper.id = 'acu-flight-guard-settings';
  wrapper.className = 'acu-fg-drawer';
  wrapper.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>数据库经典模式 · 大总结删楼守护</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="acu-fg-body">
          <label class="acu-fg-toggle">
            <input type="checkbox" id="acu-fg-enabled" ${settings.enabled ? 'checked' : ''} />
            <span>启用大总结删楼隐藏纪要自动恢复</span>
          </label>
          <label class="acu-fg-toggle">
            <input type="checkbox" id="acu-fg-toast" ${settings.showToast ? 'checked' : ''} />
            <span>自动恢复纪要时弹出提示通知</span>
          </label>
          <div id="acu-fg-status-box" class="acu-fg-status-box">
            <div class="acu-fg-status-row"><span class="acu-fg-status-label">数据库插件</span><span id="acu-fg-status-acu" class="acu-fg-status-value">检测中...</span></div>
            <div class="acu-fg-status-row"><span class="acu-fg-status-label">当前会话模式</span><span id="acu-fg-status-mode" class="acu-fg-status-value">—</span></div>
            <div class="acu-fg-status-row"><span class="acu-fg-status-label">大总结行数</span><span id="acu-fg-status-summary" class="acu-fg-status-value">—</span></div>
            <div class="acu-fg-status-row"><span class="acu-fg-status-label">已隐藏纪要数</span><span id="acu-fg-status-hidden" class="acu-fg-status-value">—</span></div>
            <div class="acu-fg-status-row"><span class="acu-fg-status-label">阶段快照账本</span><span id="acu-fg-status-ledger" class="acu-fg-status-value">—</span></div>
          </div>
          <div class="acu-fg-actions">
            <button type="button" id="acu-fg-check-now" class="menu_button acu-fg-btn">立即检查并对齐当前对话</button>
          </div>
          <p class="acu-fg-note">当经典模式删楼或切分支回退导致「大总结」行被删但 <code>hiddenRowIds</code> 残留时，自动还原对应纪要行可见状态并同步世界书，零额外 Token 消耗。</p>
        </div>
      </div>
    </div>
  `;

  container.appendChild(wrapper);

  const enabledInput = document.getElementById('acu-fg-enabled');
  const toastInput = document.getElementById('acu-fg-toast');
  const checkBtn = document.getElementById('acu-fg-check-now');

  enabledInput?.addEventListener('change', (ev) => {
    const currentCtx = getCtx();
    const s = ensureExtensionSettings(currentCtx);
    s.enabled = Boolean(ev.target?.checked);
    currentCtx?.saveSettingsDebounced?.();
    if (s.enabled) scheduleReconcile('setting_enabled', 150);
  });

  toastInput?.addEventListener('change', (ev) => {
    const currentCtx = getCtx();
    const s = ensureExtensionSettings(currentCtx);
    s.showToast = Boolean(ev.target?.checked);
    currentCtx?.saveSettingsDebounced?.();
  });

  checkBtn?.addEventListener('click', () => {
    attachAcuHooks();
    void runReconcile('manual_button', { manual: true });
  });

  updateStatusUi();
}

function registerHostEvents(ctx) {
  const source = ctx?.eventSource;
  const types = ctx?.eventTypes || ctx?.event_types;
  if (!source || typeof source.on !== 'function' || !types) return;

  if (types.CHAT_CHANGED) {
    source.on(types.CHAT_CHANGED, () => {
      isFilling = false;
      attachAcuHooks();
      updateStatusUi();
      scheduleReconcile('chat_changed', 900);
    });
  }

  if (types.APP_READY) {
    source.on(types.APP_READY, () => {
      mountSettingsPanel();
      attachAcuHooks();
      updateStatusUi();
    });
  }
}

async function waitForHostContext(maxWaitMs = 20000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const ctx = getCtx();
    if (ctx && ctx.eventSource && (ctx.eventTypes || ctx.event_types)) {
      return ctx;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return getCtx();
}

async function main() {
  if (globalThis[SINGLETON_KEY]) return;
  globalThis[SINGLETON_KEY] = true;

  const ctx = await waitForHostContext();
  if (!ctx) {
    console.warn(`${LOG_PREFIX} 未检测到 SillyTavern.getContext()，停止初始化。`);
    return;
  }

  ensureExtensionSettings(ctx);
  mountSettingsPanel();
  registerHostEvents(ctx);
  waitForAcuHooks();
}

void main();
