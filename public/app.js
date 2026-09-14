const socket = io();

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = { bots: {}, settings: null };

// ── SETTINGS ──────────────────────────────────────────────────────────────────
async function loadSettingsUI() {
  try {
    const s = await fetch('/api/settings').then(r => r.json());
    state.settings = s;
    // Карточки могли уже отрендериться со встроенными запасными значениями
    // (localhost/25565/1.20.1) до того как настройки успели прийти — обновим
    // поля хоста/порта/версии только там, где бот ещё ни разу не подключался.
    Object.values(state.bots).forEach(b => {
      if (b.server?.host) return; // уже есть реальный сервер — не перетираем
      const hostEl = document.getElementById(`host-${b.id}`);
      const portEl = document.getElementById(`port-${b.id}`);
      if (hostEl && !hostEl.value) hostEl.value = s.defaultHost;
      if (portEl && !portEl.value) portEl.value = s.defaultPort;
    });
    const bulkHostEl = document.getElementById('bulkHost');
    const bulkPortEl = document.getElementById('bulkPort');
    if (bulkHostEl && !bulkHostEl.value) bulkHostEl.value = s.defaultHost;
    if (bulkPortEl && !bulkPortEl.value) bulkPortEl.value = s.defaultPort;
  } catch (e) {
    console.error('Не удалось загрузить настройки:', e);
  }
}
loadSettingsUI();

socket.on('settings:updated', (s) => {
  state.settings = s;
  if (document.getElementById('settingsTab')?.style.display === 'block') fillSettingsForm(s);
});

function fillSettingsForm(s) {
  if (!s) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
  set('setDefaultHost', s.defaultHost);
  set('setDefaultPort', s.defaultPort);
  set('setDefaultVersion', s.defaultVersion);
  set('setAutoBalCommand', s.autoBalCommand);
  set('setAutoBalInvestCommand', s.autoBalInvestCommand);
  set('setAutoBalIntervalSec', s.autoBalIntervalSec);
  set('setAutoHealCommand', s.autoHealCommand);
  set('setAutoHealIntervalSec', s.autoHealIntervalSec);
  set('setAutoShopSlots', s.autoShopSlots ?? '12,13');
  set('setAutoShopButton', s.autoShopButton ?? 0);
  set('setAutoShopDelay', s.autoShopDelay ?? 500);
  set('setAutoShopCycleDelay', s.autoShopCycleDelay ?? 1000);
  set('setAutoPaydayCommand', s.autoPaydayCommand);
  set('setAutoPaydayPayCommand', s.autoPaydayPayCommand);
  set('setAutoPaydayTarget', s.autoPaydayTarget);
  set('setAutoPaydayAmount', s.autoPaydayAmount);
  set('setAutoPaydayIntervalHours', s.autoPaydayIntervalHours);
  set('setPosWatchThreshold', s.posWatchThreshold);
  set('setPosWatchRetrySec', s.posWatchRetrySec);
  set('setProxyLimit', s.proxyLimit);
  set('setAuthRegisterCommand', s.authRegisterCommand);
  set('setAuthLoginCommand', s.authLoginCommand);
  set('setAuthRegisterPattern', s.authRegisterPattern);
  set('setAuthLoginPattern', s.authLoginPattern);
}

async function saveSiteSettings() {
  const get = id => document.getElementById(id)?.value ?? '';
  const patch = {
    defaultHost: get('setDefaultHost'),
    defaultPort: get('setDefaultPort'),
    defaultVersion: get('setDefaultVersion'),
    autoBalCommand: get('setAutoBalCommand'),
    autoBalInvestCommand: get('setAutoBalInvestCommand'),
    autoBalIntervalSec: get('setAutoBalIntervalSec'),
    autoHealCommand: get('setAutoHealCommand'),
    autoHealIntervalSec: get('setAutoHealIntervalSec'),
    autoShopSlots: get('setAutoShopSlots'),
    autoShopButton: parseInt(get('setAutoShopButton')) || 0,
    autoShopDelay: parseInt(get('setAutoShopDelay')) || 500,
    autoShopCycleDelay: parseInt(get('setAutoShopCycleDelay')) || 1000,
    autoPaydayCommand: get('setAutoPaydayCommand'),
    autoPaydayPayCommand: get('setAutoPaydayPayCommand'),
    autoPaydayTarget: get('setAutoPaydayTarget'),
    autoPaydayAmount: get('setAutoPaydayAmount'),
    autoPaydayIntervalHours: get('setAutoPaydayIntervalHours'),
    posWatchThreshold: get('setPosWatchThreshold'),
    posWatchRetrySec: get('setPosWatchRetrySec'),
    proxyLimit: get('setProxyLimit'),
    authRegisterCommand: get('setAuthRegisterCommand'),
    authLoginCommand: get('setAuthLoginCommand'),
    authRegisterPattern: get('setAuthRegisterPattern'),
    authLoginPattern: get('setAuthLoginPattern'),
  };
  const statusEl = document.getElementById('settingsSaveStatus');
  if (statusEl) { statusEl.textContent = '⏳ Сохраняю...'; statusEl.style.color = 'var(--text2)'; }
  try {
    const s = await fetch('/api/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch)
    }).then(r => r.json());
    state.settings = s;
    if (statusEl) { statusEl.textContent = '✅ Сохранено'; statusEl.style.color = 'var(--success)'; }
  } catch (e) {
    if (statusEl) { statusEl.textContent = '❌ ' + e.message; statusEl.style.color = 'var(--danger)'; }
  }
}

async function resetSiteSettings() {
  if (!confirm('Сбросить все настройки к значениям по умолчанию?')) return;
  const s = await fetch('/api/settings/reset', { method: 'POST' }).then(r => r.json());
  state.settings = s;
  fillSettingsForm(s);
  const statusEl = document.getElementById('settingsSaveStatus');
  if (statusEl) { statusEl.textContent = '↺ Сброшено'; statusEl.style.color = 'var(--warn)'; }
}

// ── SOCKET ────────────────────────────────────────────────────────────────────
socket.on('bots:init', (bots) => {
  bots.forEach(b => {
    state.bots[b.id] = b;
    renderCard(b);
  });
  renderBulkList();
  showEmptyIfNeeded();
});

socket.on('bot:status', ({ id, status }) => {
  if (!state.bots[id]) return;
  state.bots[id].status = status;
  updateCardStatus(id, status);
  updateBulkDot(id, status);
});

// Per-bot subscriptions — храним флаг чтобы не дублировать listeners
const _subscribed = new Set();
function subscribeBot(id) {
  if (_subscribed.has(id)) return;
  _subscribed.add(id);
  socket.on(`bot:${id}:hud`,          (hud)  => updateHud(id, hud));
  socket.on(`bot:${id}:log`,          (e)    => appendLog(id, e));
  socket.on(`bot:${id}:inventory`,    (data) => renderInventory(id, data));
  socket.on(`bot:${id}:window:open`,  (data) => renderWindow(id, data));
  socket.on(`bot:${id}:window:update`,(data) => renderWindow(id, data));
  socket.on(`bot:${id}:window:close`, ()     => hideWindowUI(id));
  socket.on(`bot:${id}:clicker`,      (c)    => updateClickerUI(id, c));
  socket.on(`bot:${id}:chatLoop`,     (c)    => updateChatLoopUI(id, c));
  socket.on(`bot:${id}:autoBal`,      (c)    => updateAutoBalUI(id, c));
  socket.on(`bot:${id}:rememberedPos`, (pos)  => updateRememberedPosUI(id, pos));
  socket.on(`bot:${id}:autoHeal`,     (c)    => updateAutoHealUI(id, c));
  socket.on(`bot:${id}:autoFish`,     (c)    => updateAutoFishUI(id, c));
  socket.on(`bot:${id}:autoShop`,     (c)    => updateAutoShopUI(id, c));
  socket.on(`bot:${id}:chatScanner`,  (c)    => updateChatScannerUI(id, c));
  socket.on(`bot:${id}:autoPayday`,   (c)    => updateAutoPaydayUI(id, c));
  socket.on(`bot:${id}:autoBoneMeal`, (c)    => updateAutoBoneMealUI(id, c));
  socket.on(`bot:${id}:macroLoop`,    (c)    => updateMacroLoopUI(id, c));
  socket.on(`bot:${id}:autoReconnect`,(en)   => {
    const cb = document.getElementById(`autoRc-${id}`);
    if (cb) cb.checked = en;
  });
}

// ── RENDER CARD ───────────────────────────────────────────────────────────────
function renderCard(b) {
  subscribeBot(b.id);
  const grid = document.getElementById('botsGrid');

  let el = document.getElementById(`card-${b.id}`);
  if (!el) {
    // Убираем заглушку
    const empty = grid.querySelector('.empty-state');
    if (empty) empty.remove();

    el = document.createElement('div');
    el.id = `card-${b.id}`;
    grid.appendChild(el);
  }
  el.className = `bot-card ${b.status}` + (focusedId === b.id ? ' focused' : '');
  el.innerHTML = cardHTML(b);

  // Подписки и восстановление состояния
  if (b.chatLog) b.chatLog.forEach(e => appendLog(b.id, e));
  initLookPad(b.id);
  initHotbar(b.id);
  ensurePlayerInvGrids(b.id);
  updateClickerUI(b.id, b.clicker || { active: false, button: 0, delay: 600 });
  updateAutoBalUI(b.id, b.autoBal   || { active: false, interval: 60000 });
  updateRememberedPosUI(b.id, b.rememberedPos || null);
  updateAutoHealUI(b.id, b.autoHeal || { active: false });
  updateAutoFishUI(b.id, b.autoFish || { active: false });
  updateAutoShopUI(b.id, b.autoShop || { active: false });
  updateChatScannerUI(b.id, b.chatScanner || { active: false });
  updateAutoPaydayUI(b.id, b.autoPayday || { active: false });
  updateAutoBoneMealUI(b.id, b.autoBoneMeal || { active: false });
  updateMacroLoopUI(b.id, b.macroLoop || { active: false, delay: 5000, text: '' });
  if (b.inventory && b.inventory.length) renderInventory(b.id, { slots: b.inventory });
  if (b.window) renderWindow(b.id, b.window);
  seedEnabledFeaturesFromServer(b.id, b.account?.enabledFeatures);
  applyFeatureVisibility(b.id);
}

// ── ДОП. ФУНКЦИИ В ПЛАШКЕ БОТА (кнопка ➕) ────────────────────────────────────
const FEATURE_LIST = [
  { key: 'clicker',     label: '🖱 Кликер' },
  { key: 'autobal',     label: '💰 Авто-бал + инвест' },
  { key: 'autoheal',    label: '💊 Авто-хил' },
  { key: 'autopayday',  label: '💵 Авто-payday' },
  { key: 'coordguard',  label: '📍 Слежение за позицией' },
  { key: 'autofish',    label: '🎣 Авторыбалка' },
  { key: 'autoshop',    label: '🛒 Автоскупщик' },
  { key: 'chatscanner', label: '👁 Сканер чата' },
  { key: 'autobonemeal', label: '🦴 Кости → Мука' },
];

function _featureStorageKey(id) { return `botFeatures:${id}`; }

function getEnabledFeatures(id) {
  try {
    return new Set(JSON.parse(localStorage.getItem(_featureStorageKey(id)) || '[]'));
  } catch { return new Set(); }
}

function saveEnabledFeatures(id, set) {
  localStorage.setItem(_featureStorageKey(id), JSON.stringify([...set]));
}

// Подхватываем список фич, сохранённый на сервере (в account), если в этом
// браузере ещё ничего локально не сохранено — чтобы список добавленных
// блоков не терялся при заходе с другого устройства/браузера.
function seedEnabledFeaturesFromServer(id, serverFeatures) {
  if (!Array.isArray(serverFeatures) || !serverFeatures.length) return;
  if (localStorage.getItem(_featureStorageKey(id)) !== null) return; // уже есть локально
  saveEnabledFeatures(id, new Set(serverFeatures));
}

function applyFeatureVisibility(id) {
  const enabled = getEnabledFeatures(id);
  FEATURE_LIST.forEach(f => {
    const el = document.getElementById(`feat-${f.key}-${id}`);
    if (el) el.classList.toggle('hidden', !enabled.has(f.key));
  });
}

function closeAllFeaturePickers(exceptId) {
  document.querySelectorAll('.feature-picker').forEach(el => {
    if (!exceptId || el.id !== `featurePicker-${exceptId}`) el.classList.add('hidden');
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.feature-picker') && !e.target.closest('[onclick^="toggleFeaturePicker"]')) {
    closeAllFeaturePickers();
  }
});

function renderFeaturePicker(id) {
  const el = document.getElementById(`featurePicker-${id}`);
  if (!el) return;
  const enabled = getEnabledFeatures(id);
  el.innerHTML = FEATURE_LIST.map(f => `
    <div class="proxy-picker-row${enabled.has(f.key) ? ' active' : ''}" onclick="toggleFeature('${id}','${f.key}')">
      <span>${f.label}</span>
      <span>${enabled.has(f.key) ? '✓' : ''}</span>
    </div>`).join('');
}

function toggleFeaturePicker(id) {
  const el = document.getElementById(`featurePicker-${id}`);
  if (!el) return;
  const willOpen = el.classList.contains('hidden');
  closeAllFeaturePickers(id);
  if (!willOpen) { el.classList.add('hidden'); return; }
  renderFeaturePicker(id);
  el.classList.remove('hidden');
}

function toggleFeature(id, key) {
  const enabled = getEnabledFeatures(id);
  if (enabled.has(key)) enabled.delete(key); else enabled.add(key);
  saveEnabledFeatures(id, enabled);
  applyFeatureVisibility(id);
  renderFeaturePicker(id);
  socket.emit('bot:setFeatureVisibility', { id, features: [...enabled] });
}

function cardHTML(b) {
  const versions = ['1.16.5','1.17.1','1.18.2','1.19.4','1.20.1','1.20.4','1.21'];
  const srv = b.server || {};
  // Учитываем сохранённую версию сервера, а не хардкодим первую из списка
  const curVer = srv.version || state.settings?.defaultVersion || '1.20.1';
  const vOpts = versions.map(v =>
    `<option${v === curVer ? ' selected' : ''}>${v}</option>`
  ).join('');

  return `
  <div class="card-header" onclick="toggleCollapse('${b.id}')">
    <div class="status-dot ${b.status}" id="dot-${b.id}"></div>
    <span class="card-name">${esc(b.account.username)}</span>
    <span class="card-status-text" id="statusText-${b.id}">${statusLabel(b.status)}</span>
    <div class="card-actions-top" onclick="event.stopPropagation()">
      <div style="position:relative;">
        <button class="btn btn-ghost btn-sm" title="Выбрать прокси (или свой IP) для этого бота" onclick="toggleProxyPicker('${b.id}')">🪄</button>
        <div class="proxy-picker hidden" id="proxyPicker-${b.id}"></div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="openModal('edit','${b.id}')">✏</button>
      <button class="btn btn-danger btn-sm" onclick="removeBot('${b.id}')">✕</button>
    </div>
  </div>
  <div class="card-body" id="body-${b.id}">

    <!-- SERVER -->
    <div class="server-row">
      <input placeholder="Хост" id="host-${b.id}" value="${esc(srv.host || state.settings?.defaultHost || 'localhost')}">
      <input placeholder="Порт" id="port-${b.id}" value="${srv.port || state.settings?.defaultPort || 25565}" style="width:72px">
      <select id="ver-${b.id}">${vOpts}</select>
    </div>
    <div style="display:flex;gap:6px">
      <button class="btn btn-success btn-sm" style="flex:1" onclick="connectBot('${b.id}')">▶ Подключить</button>
      <button class="btn btn-danger  btn-sm" style="flex:1" onclick="disconnectBot('${b.id}')">■ Отключить</button>
    </div>
    <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);cursor:pointer;">
      <input type="checkbox" id="autoRc-${b.id}" ${b.autoReconnect ? 'checked' : ''}
        onchange="toggleAutoReconnect('${b.id}', this.checked)">
      Авто-заход при обрыве связи
    </label>

    <!-- HUD -->
    <div class="hud">
      <div class="hud-cell"><div class="hud-label">❤ HP</div><div class="hud-val hp"   id="h-hp-${b.id}">—</div></div>
      <div class="hud-cell"><div class="hud-label">🍗 Еда</div><div class="hud-val food" id="h-food-${b.id}">—</div></div>
      <div class="hud-cell"><div class="hud-label">📍 XYZ</div><div class="hud-val" id="h-pos-${b.id}" style="font-size:10px">—</div></div>
      <div class="hud-cell"><div class="hud-label">📶 Ping</div><div class="hud-val" id="h-ping-${b.id}">—</div></div>
    </div>

    <!-- ДВИЖЕНИЕ И ВЗАИМОДЕЙСТВИЕ -->
    <div class="section-group">
      <div class="section-group-title">🎮 Управление</div>
      <div class="controls">
        <div class="dpad" id="dpad-${b.id}">
          <button class="dpad-empty"></button>
          <button data-key="forward"  onmousedown="keyDown('${b.id}','forward',this)"  onmouseup="keyUp('${b.id}','forward',this)"  ontouchstart="keyDown('${b.id}','forward',this)"  ontouchend="keyUp('${b.id}','forward',this)">▲</button>
          <button class="dpad-empty"></button>
          <button data-key="left"     onmousedown="keyDown('${b.id}','left',this)"     onmouseup="keyUp('${b.id}','left',this)"     ontouchstart="keyDown('${b.id}','left',this)"     ontouchend="keyUp('${b.id}','left',this)">◄</button>
          <button class="dpad-center dpad-empty"></button>
          <button data-key="right"    onmousedown="keyDown('${b.id}','right',this)"    onmouseup="keyUp('${b.id}','right',this)"    ontouchstart="keyDown('${b.id}','right',this)"    ontouchend="keyUp('${b.id}','right',this)">►</button>
          <button class="dpad-empty"></button>
          <button data-key="back"     onmousedown="keyDown('${b.id}','back',this)"     onmouseup="keyUp('${b.id}','back',this)"     ontouchstart="keyDown('${b.id}','back',this)"     ontouchend="keyUp('${b.id}','back',this)">▼</button>
          <button class="dpad-empty"></button>
        </div>

        <div class="side-btns">
          <button onclick="doJump('${b.id}')">↑ Прыжок</button>
          <button data-key="sneak"  onmousedown="keyDown('${b.id}','sneak',this)"  onmouseup="keyUp('${b.id}','sneak',this)">⬇ Присесть</button>
          <button data-key="sprint" onmousedown="keyDown('${b.id}','sprint',this)" onmouseup="keyUp('${b.id}','sprint',this)">⚡ Спринт</button>
          <button onclick="doAttack('${b.id}')">⚔ Атака</button>
          <button onmousedown="doUse('${b.id}',true)" onmouseup="doUse('${b.id}',false)" onmouseleave="doUse('${b.id}',false)">🖱 ПКМ</button>
        </div>

        <div class="look-pad-wrap">
          <div class="look-pad-label">Поворот</div>
          <div class="look-pad" id="lpad-${b.id}">
            <div class="look-dot" id="ldot-${b.id}"></div>
          </div>
          <div style="font-size:10px;color:var(--text2);text-align:center;margin-top:2px">
            Y:<span id="lyaw-${b.id}">0</span>° P:<span id="lpitch-${b.id}">0</span>°
          </div>
        </div>
      </div>
    </div>

    <!-- АВТОМАТИЗАЦИЯ -->
    <div class="section-group">
      <div class="section-group-title" style="display:flex;align-items:center;justify-content:space-between;">
        <span>🤖 Автоматизация</span>
        <div style="position:relative;">
          <button class="btn btn-ghost btn-sm" title="Добавить функцию" onclick="event.stopPropagation();toggleFeaturePicker('${b.id}')">➕</button>
          <div class="feature-picker hidden" id="featurePicker-${b.id}"></div>
        </div>
      </div>
      <div class="controls">
        <div class="feature-block hidden" data-feature="clicker" id="feat-clicker-${b.id}">
        <div class="clicker-block">
          <div class="clicker-title">🖱 Кликер</div>
          <select id="clickerBtn-${b.id}">
            <option value="0"${(b.clicker?.button ?? 0) === 0 ? ' selected' : ''}>ЛКМ</option>
            <option value="1"${b.clicker?.button === 1 ? ' selected' : ''}>ПКМ</option>
          </select>
          <input type="number" id="clickerDelay-${b.id}" value="${b.clicker?.delay || 600}"
            min="15" placeholder="мс">
          <button class="btn btn-success btn-sm" id="clickerToggle-${b.id}"
            onclick="toggleClicker('${b.id}')">▶ Старт</button>
        </div>
        </div>

        <div class="feature-block hidden" data-feature="autobal" id="feat-autobal-${b.id}">
        <div class="auto-bal-block">
          <div class="clicker-title">💰 Авто-бал + инвест</div>
          <input type="number" id="autoBalInterval-${b.id}" value="${Math.round((b.autoBal?.interval || 60000) / 1000)}"
            min="10" placeholder="сек" style="width:70px" title="Интервал в секундах">
          <span style="font-size:11px;color:var(--text2)">сек</span>
          <button class="btn btn-success btn-sm" id="autoBalToggle-${b.id}"
            onclick="toggleAutoBal('${b.id}')">▶ Старт</button>
          <div id="autoBalStatus-${b.id}" style="font-size:10px;color:var(--text2);margin-top:2px"></div>
        </div>
        </div>

        <div class="feature-block hidden" data-feature="autoheal" id="feat-autoheal-${b.id}">
        <div class="auto-heal-block">
          <div class="clicker-title">💊 Авто-хил</div>
          <button class="btn btn-success btn-sm" id="autoHealToggle-${b.id}"
            onclick="toggleAutoHeal('${b.id}')">▶ Старт</button>
          <span style="font-size:10px;color:var(--text2)" id="autoHealHint-${b.id}"></span>
        </div>
        </div>

        <div class="feature-block hidden" data-feature="autopayday" id="feat-autopayday-${b.id}">
        <div class="auto-heal-block">
          <div class="clicker-title">💵 Авто-payday</div>
          <input type="number" id="autoPaydayInterval-${b.id}" value="${b.autoPayday?.intervalHours || 4}"
            min="0.5" step="0.5" placeholder="ч" style="width:60px" title="Интервал в часах">
          <span style="font-size:11px;color:var(--text2)">ч</span>
          <button class="btn btn-success btn-sm" id="autoPaydayToggle-${b.id}"
            onclick="toggleAutoPayday('${b.id}')">▶ Старт</button>
          <span style="font-size:10px;color:var(--text2)" id="autoPaydayHint-${b.id}"></span>
        </div>
        </div>

        <div class="feature-block hidden" data-feature="coordguard" id="feat-coordguard-${b.id}">
        <div class="coord-guard-block" id="coordGuard-${b.id}">
          <div class="clicker-title">📍 Слежение за позицией</div>
          <button class="btn btn-ghost btn-sm" onclick="rememberPos('${b.id}')">Запомнить</button>
          <button class="btn btn-xs" id="forgetPosBtn-${b.id}" onclick="forgetPos('${b.id}')"
            style="display:none;background:var(--danger-bg);color:var(--danger);border:1px solid var(--danger)">
            ✕ Забыть
          </button>
          <span id="savedPosLabel-${b.id}" style="font-size:10px;color:var(--text2);display:none"></span>
          <button class="btn btn-ghost btn-xs" onclick="togglePosMacroPanel('${b.id}')" style="margin-left:4px">⚙ Макрос</button>
        </div>

        <div class="auto-heal-block" id="posMacroPanel-${b.id}" style="display:none;flex-direction:column;">
          <div class="clicker-title">⚙ Макрос при смещении позиции</div>
          <textarea id="posMacroText-${b.id}" rows="4"
            placeholder="chat:/hub&#10;wait:2000&#10;click:12:0:0"
            style="width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:6px;font-family:monospace;font-size:10px;resize:vertical;">${esc(b.account?.recoverySequenceText || '')}</textarea>
          <button class="btn btn-primary btn-sm" onclick="savePosMacro('${b.id}')">💾 Сохранить</button>
        </div>
        </div>

        <div class="feature-block hidden" data-feature="autofish" id="feat-autofish-${b.id}">
        <div class="auto-heal-block">
          <div class="clicker-title">🎣 Авторыбалка</div>
          <button class="btn btn-success btn-sm" id="autoFishToggle-${b.id}"
            onclick="toggleAutoFish('${b.id}')">▶ Старт</button>
          <span style="font-size:10px;color:var(--text2)" id="autoFishHint-${b.id}"></span>
        </div>
        </div>

        <div class="feature-block hidden" data-feature="autoshop" id="feat-autoshop-${b.id}">
        <div class="auto-heal-block" style="flex-direction:column;gap:5px;">
          <div class="clicker-title">🛒 Автоскупщик</div>

          <input id="shopOpenCmd-${b.id}"
            placeholder="Команда открытия меню: /shop"
            value="${esc(b.autoShop?.openCmd ?? '')}"
            style="width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:4px 7px;font-size:11px;">

          <div style="display:flex;gap:4px;align-items:center;">
            <input id="shopSlots-${b.id}"
              placeholder="Слоты через запятую: 12,13,14"
              value="${esc(b.autoShop?.slots ?? state.settings?.autoShopSlots ?? '')}"
              style="flex:1;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:4px 7px;font-size:11px;">
            <select id="shopButton-${b.id}" style="background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:4px 5px;font-size:11px;">
              <option value="0"${(b.autoShop?.button ?? state.settings?.autoShopButton ?? 0) === 0 ? ' selected' : ''}>ЛКМ</option>
              <option value="1"${(b.autoShop?.button ?? state.settings?.autoShopButton ?? 0) === 1 ? ' selected' : ''}>ПКМ</option>
            </select>
          </div>

          <div style="display:flex;gap:4px;align-items:center;">
            <span style="font-size:10px;color:var(--text2);">Задержка между кликами:</span>
            <input type="number" id="shopDelay-${b.id}" value="${b.autoShop?.delay ?? state.settings?.autoShopDelay ?? 500}" min="0"
              style="width:60px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:3px 5px;font-size:11px;">
            <span style="font-size:10px;color:var(--text2);">мс</span>
          </div>

          <div style="display:flex;gap:4px;align-items:center;">
            <span style="font-size:10px;color:var(--text2);">Пауза между циклами:</span>
            <input type="number" id="shopCycleDelay-${b.id}" value="${b.autoShop?.cycleDelay ?? state.settings?.autoShopCycleDelay ?? 1000}" min="0"
              style="width:60px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:3px 5px;font-size:11px;">
            <span style="font-size:10px;color:var(--text2);">мс</span>
          </div>

          <button class="btn btn-success btn-sm" id="autoShopToggle-${b.id}"
            onclick="toggleAutoShop('${b.id}')">▶ Старт</button>
        </div>
        </div>

        <div class="feature-block hidden" data-feature="chatscanner" id="feat-chatscanner-${b.id}">
        <div class="auto-heal-block" style="flex-direction:column;gap:5px;">
          <div class="clicker-title">👁 Сканер чата (/near)</div>

          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
            <span style="font-size:10px;color:var(--text2);">Слать /near каждые</span>
            <input type="number" id="scannerNearInterval-${b.id}"
              value="${b.chatScanner?.nearInterval || 5}" min="1" max="60" step="1"
              style="width:48px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:3px 5px;font-size:11px;">
            <span style="font-size:10px;color:var(--text2);">сек (0 = не слать, только слушать)</span>
          </div>

          <div style="font-size:10px;color:var(--text2);background:var(--bg2);border:1px solid var(--border);border-radius:5px;padding:4px 7px;line-height:1.55;">
            Поле «Паттерн» можно оставить пустым — бот сам попробует несколько
            распространённых форматов ответа <code>/near</code>, например:<br>
            <code style="font-size:9px;">1. NICK - в 3 блока</code> ·
            <code style="font-size:9px;">(↓2) NICK</code> ·
            <code style="font-size:9px;">NICK (2m)</code><br>
            Не сработало автоматически? Скопируй строку из чат-лога бота ниже
            (появится там с пометкой ❓) и проверь свой паттерн в «Проверке» →
          </div>

          <input id="scannerPattern-${b.id}"
            placeholder="Свой паттерн (regex), необязательно — см. подсказку выше"
            style="width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:4px 7px;font-size:10px;"
            value="${esc(b.chatScanner?.pattern || '')}">

          <textarea id="scannerWhitelist-${b.id}" rows="2"
            placeholder="Вайтлист ников — по одному на строку (эти ники игнорируются)"
            style="width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:4px 7px;font-size:10px;resize:vertical;">${esc((b.chatScanner?.whitelist || []).join('\n'))}</textarea>

          <textarea id="scannerAction-${b.id}" rows="2"
            placeholder="chat:/clan {name} рядом ({dist} блоков)!  ·  {name}/{dist}/{msg} — подставятся автоматически"
            style="width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:4px 7px;font-size:10px;font-family:monospace;resize:vertical;">${esc(b.chatScanner?.action || '')}</textarea>

          <details class="scanner-tester">
            <summary>🔍 Проверка паттерна на примере строки</summary>
            <div style="display:flex;gap:5px;margin-top:5px;flex-wrap:wrap;">
              <input id="scannerTestLine-${b.id}" placeholder="Вставь сюда точную строку из чата (например: Игроки рядом: (↓2) BudibuKiller)"
                style="flex:1;min-width:180px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:4px 7px;font-size:10px;">
              <button class="btn btn-ghost btn-sm" onclick="testScannerPattern('${b.id}')">Проверить</button>
            </div>
            <div id="scannerTestResult-${b.id}" style="font-size:10px;margin-top:4px;color:var(--text2);"></div>
          </details>

          <div style="display:flex;gap:5px;align-items:center;">
            <button class="btn btn-success btn-sm" id="chatScannerToggle-${b.id}"
              onclick="toggleChatScanner('${b.id}')">▶ Старт</button>
            <span style="font-size:9px;color:var(--text2);" id="chatScannerStatus-${b.id}"></span>
          </div>
        </div>
        </div>

        <div class="feature-block hidden" data-feature="autobonemeal" id="feat-autobonemeal-${b.id}">
        <div class="auto-heal-block" style="flex-direction:column;gap:5px;">
          <div class="clicker-title">🦴 Кости → Мука (авто)</div>
          <div style="font-size:10px;color:var(--text2);">
            Как только в инвентаре появляются кости — бот сразу крафтит из них костную муку и наводит взгляд перед броском, чтобы выкинуть её.
          </div>
          <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
            <span style="font-size:10px;color:var(--text2);">Взгляд (Yaw/Pitch °):</span>
            <input type="number" id="boneMealYaw-${b.id}" value="${b.autoBoneMeal?.lookYaw ?? 0}" placeholder="Yaw"
              style="width:60px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:3px 5px;font-size:11px;">
            <input type="number" id="boneMealPitch-${b.id}" value="${b.autoBoneMeal?.lookPitch ?? 90}" placeholder="Pitch"
              style="width:60px;background:var(--bg2);border:1px solid var(--border);border-radius:5px;color:var(--text);padding:3px 5px;font-size:11px;">
            <button class="btn btn-ghost btn-xs" onclick="setBoneMealLookHere('${b.id}')" title="Взять текущий взгляд бота">🎯 Тек.</button>
          </div>
          <button class="btn btn-success btn-sm" id="autoBoneMealToggle-${b.id}"
            onclick="toggleAutoBoneMeal('${b.id}')">▶ Старт</button>
        </div>
        </div>
      </div>
    </div>

    <!-- HOTBAR -->
    <div class="hotbar-row">
      <div class="hotbar" id="hotbar-${b.id}">
        ${[1,2,3,4,5,6,7,8,9].map(n => `
          <div class="inv-slot hotbar-slot${n===1?' active':''}" id="slot-${b.id}-${n}"
            data-id="${b.id}" data-hb="${n-1}">
            <span class="hotbar-num" onclick="event.stopPropagation();selectSlot('${b.id}',${n-1})">${n}</span>
          </div>`).join('')}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="toggleInv('${b.id}')">🎒 Инвентарь</button>
      <button class="btn btn-ghost btn-sm" onclick="toggleMacroPanel('${b.id}')">📜 Макрос</button>
    </div>

    <!-- INVENTORY PANEL -->
    <div class="inv-panel hidden" id="invPanel-${b.id}">
      <div class="inv-section-title">Броня</div>
      <div class="inv-grid armor" id="invArmor-${b.id}"></div>
      <div class="inv-section-title">Инвентарь</div>
      <div class="inv-grid main9" id="invMain-${b.id}"></div>
    </div>

    <!-- MACRO PANEL -->
    <div class="inv-panel hidden" id="macroPanel-${b.id}">
      <div class="inv-section-title">📜 Макрос</div>
      <textarea id="macroText-${b.id}" rows="7"
        placeholder="chat:/hub&#10;wait:2000&#10;walk:forward:1500&#10;look:90:0&#10;click:12:0:0&#10;attack&#10;use&#10;hold:right:3000&#10;clicker:on:0:600"
        style="width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:8px;font-family:monospace;font-size:11px;line-height:1.5;resize:vertical;">${esc(b.macroLoop?.text || '')}</textarea>
      <div style="font-size:10px;color:var(--text2);line-height:1.6;">
        <code>chat:текст</code> · <code>wait:мс</code> · <code>click:слот:кнопка:режим</code> · <code>attack</code> · <code>use</code> ·
        <code>walk:forward|back|left|right:мс</code> · <code>look:yaw:pitch(°)</code> · <code>jump</code> ·
        <code>sneak:мс</code> · <code>sprint:мс</code> · <code>hold:left|right:мс</code> · <code>slot:0-8</code> ·
        <code>clicker:on:кнопка:задержка</code> / <code>clicker:off</code> ·
        <code>reconnect</code> · <code>disconnect</code> · <code>connect:host:port:version</code> · строки с <code>#</code> — комментарии
      </div>

      <div class="macro-mode-row">
        <label class="macro-mode-option">
          <input type="radio" name="macroMode-${b.id}" value="once" checked onchange="onMacroModeChange('${b.id}')">
          <span>▶ Разовый запуск</span>
        </label>
        <label class="macro-mode-option">
          <input type="radio" name="macroMode-${b.id}" value="loop" onchange="onMacroModeChange('${b.id}')">
          <span>🔁 Бесконечный (по кругу)</span>
        </label>
        <span id="macroLoopDelayWrap-${b.id}" class="hidden" style="display:flex;align-items:center;gap:4px;">
          <span style="font-size:11px;color:var(--text2);">пауза между циклами</span>
          <input type="number" id="macroLoopDelay-${b.id}" value="${Math.max(1, Math.round((b.macroLoop?.delay || 5000) / 1000))}" min="1" style="width:60px" title="Секунд">
          <span style="font-size:11px;color:var(--text2);">сек</span>
        </span>
      </div>

      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        <input type="file" accept=".txt" id="macroFile-${b.id}" style="display:none" onchange="loadMacroFile('${b.id}', this)">
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('macroFile-${b.id}').click()">📂 Файл (.txt)</button>
        <button class="btn btn-success btn-sm" id="macroRunBtn-${b.id}" onclick="runOrToggleMacro('${b.id}')">▶ Запустить</button>
      </div>
    </div>

    <!-- WINDOW OVERLAY -->
    <div class="win-overlay hidden" id="winOverlay-${b.id}">
      <div class="win-box">
        <div class="win-header">
          <span id="winTitle-${b.id}">Меню</span>
          <button class="modal-close" onclick="closeWindowUI('${b.id}')">✕</button>
        </div>
        <div class="inv-grid main9" id="winTop-${b.id}"></div>
        <div class="win-divider"></div>
        <div class="inv-grid main9" id="winMain-${b.id}"></div>
        <div class="inv-grid main9" id="winHotbar-${b.id}"></div>
      </div>
    </div>

    <!-- CHAT -->
    <div class="chat-log" id="chatLog-${b.id}"></div>
    <div class="chat-input-row">
      <input id="chatIn-${b.id}" placeholder="Сообщение или /команда..."
        onkeydown="chatKey(event,'${b.id}')">
      <button onclick="sendChat('${b.id}')">➤</button>
    </div>
  </div>`;
}

// ── COLLAPSE ──────────────────────────────────────────────────────────────────
function toggleCollapse(id) {
  const body = document.getElementById(`body-${id}`);
  if (body) body.style.display = body.style.display === 'none' ? '' : 'none';
}

// ── STATUS ────────────────────────────────────────────────────────────────────
function statusLabel(s) {
  return { offline:'Оффлайн', connecting:'Подключение...', online:'Онлайн', error:'Ошибка' }[s] || s;
}
function updateCardStatus(id, status) {
  const card = document.getElementById(`card-${id}`);
  if (!card) return;
  card.className = `bot-card ${status}` + (card.classList.contains('focused') ? ' focused' : '');
  const dot = document.getElementById(`dot-${id}`);
  if (dot) dot.className = `status-dot ${status}`;
  const txt = document.getElementById(`statusText-${id}`);
  if (txt) txt.textContent = statusLabel(status);
}

// ── HUD ───────────────────────────────────────────────────────────────────────
function updateHud(id, hud) {
  const set = (sid, val) => { const el = document.getElementById(sid); if (el) el.textContent = val; };
  set(`h-hp-${id}`,   hud.health);
  set(`h-food-${id}`, hud.food);
  set(`h-pos-${id}`,  `${hud.x} ${hud.y} ${hud.z}`);
  set(`h-ping-${id}`, hud.ping + 'ms');
}

// ── CHAT LOG ──────────────────────────────────────────────────────────────────
// Флаг: пользователь прокрутил вверх — не дёргаем скролл на новых сообщениях
const _chatScrolledUp = {};

function _bindChatScroll(id) {
  const el = document.getElementById(`chatLog-${id}`);
  if (!el || el._scrollBound) return;
  el._scrollBound = true;
  el.addEventListener('scroll', () => {
    _chatScrolledUp[id] = el.scrollHeight - el.scrollTop - el.clientHeight > 24;
  });
}

// Убираем Minecraft §-коды И ANSI escape-коды (мы храним type==='chat' записи как есть)
function stripColors(s) {
  return (s || '')
    .replace(/\x1B\[[0-9;]*m/g, '')        // ANSI
    .replace(/§[0-9a-fk-orA-FK-OR]/g, '');  // Minecraft §-коды
}

function appendLog(id, entry) {
  if (entry.type !== 'chat') return;
  const el = document.getElementById(`chatLog-${id}`);
  if (!el) return;

  _bindChatScroll(id);

  const div = document.createElement('div');
  div.className = 'log-chat';
  div.textContent = stripColors(entry.msg);
  el.appendChild(div);

  // Держим не более 300 строк в DOM
  while (el.children.length > 300) el.removeChild(el.firstChild);

  if (!_chatScrolledUp[id]) el.scrollTop = el.scrollHeight;
}

// ── CHAT INPUT ────────────────────────────────────────────────────────────────
function sendChat(id) {
  const inp = document.getElementById(`chatIn-${id}`);
  const text = inp.value.trim();
  if (!text) return;
  socket.emit('bot:chat', { id, text });
  inp.value = '';
}
function chatKey(e, id) { if (e.key === 'Enter') sendChat(id); }

// ── CONTROLS ──────────────────────────────────────────────────────────────────
function keyDown(id, key, el) { socket.emit('bot:key', { id, key, state: true });  el.classList.add('held'); }
function keyUp(id, key, el)   { socket.emit('bot:key', { id, key, state: false }); el.classList.remove('held'); }
function doJump(id)          { socket.emit('bot:jump',    { id }); }
function doAttack(id)        { socket.emit('bot:attack',  { id }); }
function doUse(id, state)    { socket.emit('bot:useItem', { id, state }); }

// ── КЛИКЕР ────────────────────────────────────────────────────────────────────
const clickerState = {};
function toggleClicker(id) {
  const active = !clickerState[id]?.active;
  const button = document.getElementById(`clickerBtn-${id}`)?.value || '0';
  const delay  = document.getElementById(`clickerDelay-${id}`)?.value || '600';
  socket.emit('bot:clicker', { id, active, button, delay });
}
function updateClickerUI(id, c) {
  clickerState[id] = c;
  const btn = document.getElementById(`clickerToggle-${id}`);
  if (!btn) return;
  if (c.active) {
    btn.textContent = '■ Стоп';
    btn.className = 'btn btn-danger btn-sm';
  } else {
    btn.textContent = '▶ Старт';
    btn.className = 'btn btn-success btn-sm';
  }
}

// ── АВТО-ОТПРАВКА СООБЩЕНИЯ (для одиночного бота нет UI, но статус может прийти) ──
function updateChatLoopUI() { /* пока нет отдельного UI на карточке — задел на будущее */ }

// ── АВТО-БАЛ ─────────────────────────────────────────────────────────────────
const _autoBalState = {};
function toggleAutoBal(id) {
  const active = !_autoBalState[id]?.active;
  const interval = parseInt(document.getElementById(`autoBalInterval-${id}`)?.value) || 60;
  socket.emit('bot:autoBal', { id, active, interval });
}
function updateAutoBalUI(id, c) {
  _autoBalState[id] = c;
  const btn = document.getElementById(`autoBalToggle-${id}`);
  const inp = document.getElementById(`autoBalInterval-${id}`);
  const status = document.getElementById(`autoBalStatus-${id}`);
  if (btn) {
    btn.textContent = c.active ? '■ Стоп' : '▶ Старт';
    btn.className   = c.active ? 'btn btn-danger btn-sm' : 'btn btn-success btn-sm';
  }
  if (inp) inp.disabled = c.active;
  if (status) status.textContent = c.active
    ? `Работает: /bal каждые ${Math.round((c.interval||60000)/1000)}с → /clan invest`
    : '';
}

// ── АВТО-ХИЛ ─────────────────────────────────────────────────────────────────
const _autoHealState = {};
function toggleAutoHeal(id) {
  const active = !_autoHealState[id]?.active;
  socket.emit('bot:autoHeal', { id, active });
}
function updateAutoHealUI(id, c) {
  _autoHealState[id] = c;
  const btn = document.getElementById(`autoHealToggle-${id}`);
  if (btn) {
    btn.textContent = c.active ? '■ Стоп' : '▶ Старт';
    btn.className   = c.active ? 'btn btn-danger btn-sm' : 'btn btn-success btn-sm';
  }
}

// ── АВТО-PAYDAY ───────────────────────────────────────────────────────────────
const _autoPaydayState = {};
function toggleAutoPayday(id) {
  const active = !_autoPaydayState[id]?.active;
  const intervalHours = parseFloat(document.getElementById(`autoPaydayInterval-${id}`)?.value) || 4;
  socket.emit('bot:autoPayday', { id, active, intervalHours });
}
function updateAutoPaydayUI(id, c) {
  _autoPaydayState[id] = c;
  const btn = document.getElementById(`autoPaydayToggle-${id}`);
  const inp = document.getElementById(`autoPaydayInterval-${id}`);
  if (btn) {
    btn.textContent = c.active ? '■ Стоп' : '▶ Старт';
    btn.className   = c.active ? 'btn btn-danger btn-sm' : 'btn btn-success btn-sm';
  }
  if (inp) inp.disabled = c.active;
}

// ── АВТО-РЕКОННЕКТ ────────────────────────────────────────────────────────────
function toggleAutoReconnect(id, enabled) {
  socket.emit('bot:autoReconnect', { id, enabled });
}

// ── HOTBAR ────────────────────────────────────────────────────────────────────
const activeSlots = {};
function initHotbar(id) { activeSlots[id] = 1; }
function selectSlot(id, slot) {
  const prev = activeSlots[id] || 1;
  document.getElementById(`slot-${id}-${prev}`)?.classList.remove('active');
  const cur = slot + 1;
  activeSlots[id] = cur;
  document.getElementById(`slot-${id}-${cur}`)?.classList.add('active');
  socket.emit('bot:slot', { id, slot });
}

// ── ИНВЕНТАРЬ ─────────────────────────────────────────────────────────────────
function ensurePlayerInvGrids(id) {
  const armorGrid = document.getElementById(`invArmor-${id}`);
  const mainGrid  = document.getElementById(`invMain-${id}`);
  if (!armorGrid || !mainGrid) return;
  if (!armorGrid.dataset.built) {
    ['Шлем','Нагрудник','Штаны','Ботинки'].forEach((lbl, i) =>
      armorGrid.appendChild(makeInvSlotEl(id, 5 + i, lbl))
    );
    armorGrid.dataset.built = '1';
  }
  if (!mainGrid.dataset.built) {
    for (let s = 9; s <= 35; s++) mainGrid.appendChild(makeInvSlotEl(id, s));
    mainGrid.dataset.built = '1';
  }
}

function makeInvSlotEl(id, slot, label) {
  const div = document.createElement('div');
  div.className = 'inv-slot';
  div.id = `pslot-${id}-${slot}`;
  div.dataset.slot = slot;
  if (label) div.dataset.label = label;
  div.addEventListener('click',       e => invClick(id, slot, 0, e.shiftKey ? 1 : 0));
  div.addEventListener('contextmenu', e => { e.preventDefault(); invClick(id, slot, 1, e.shiftKey ? 1 : 0); });
  return div;
}

function invClick(id, slot, button, mode) {
  socket.emit('bot:invClick', { id, slot, button, mode });
}

function toggleInv(id) {
  document.getElementById(`invPanel-${id}`)?.classList.toggle('hidden');
}

// ── МАКРОС (разовый запуск) ────────────────────────────────────────────────
function toggleMacroPanel(id) {
  document.getElementById(`macroPanel-${id}`)?.classList.toggle('hidden');
}

function loadMacroFile(id, inputEl) {
  const file = inputEl.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.txt')) {
    alert('Ожидается .txt файл');
    inputEl.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const ta = document.getElementById(`macroText-${id}`);
    if (ta) ta.value = e.target.result;
  };
  reader.onerror = () => alert('Не удалось прочитать файл');
  reader.readAsText(file, 'utf-8');
  inputEl.value = ''; // чтобы можно было выбрать тот же файл повторно
}

function onMacroModeChange(id) {
  const mode = document.querySelector(`input[name="macroMode-${id}"]:checked`)?.value || 'once';
  const delayWrap = document.getElementById(`macroLoopDelayWrap-${id}`);
  if (delayWrap) delayWrap.classList.toggle('hidden', mode !== 'loop');
  updateMacroRunBtn(id);
}

function updateMacroRunBtn(id) {
  const mode = document.querySelector(`input[name="macroMode-${id}"]:checked`)?.value || 'once';
  const btn = document.getElementById(`macroRunBtn-${id}`);
  if (!btn) return;
  if (mode === 'loop' && _macroLoopState[id]?.active) {
    btn.textContent = '■ Остановить цикл';
    btn.className = 'btn btn-danger btn-sm';
  } else {
    btn.textContent = mode === 'loop' ? '🔁 Запустить цикл' : '▶ Запустить';
    btn.className = 'btn btn-success btn-sm';
  }
}

function runOrToggleMacro(id) {
  const mode = document.querySelector(`input[name="macroMode-${id}"]:checked`)?.value || 'once';
  const ta = document.getElementById(`macroText-${id}`);
  const text = ta?.value.trim();

  if (mode === 'once') {
    if (!text) return alert('Макрос пуст!');
    socket.emit('bot:runMacro', { id, text });
    return;
  }

  // Бесконечный режим — кнопка работает как старт/стоп
  if (_macroLoopState[id]?.active) {
    socket.emit('bot:macroLoop', { id, active: false });
    return;
  }
  if (!text) return alert('Макрос пуст!');
  const delaySec = Math.max(1, parseInt(document.getElementById(`macroLoopDelay-${id}`)?.value) || 5);
  socket.emit('bot:macroLoop', { id, active: true, text, delay: delaySec * 1000 });
}

const _macroLoopState = {};
function updateMacroLoopUI(id, c) {
  _macroLoopState[id] = c;
  if (c?.active) {
    // Сервер сам сообщает что цикл активен (например восстановился после реконнекта) —
    // переключаем UI в режим "Бесконечный", чтобы кнопка и подписи не расходились с реальностью.
    const loopRadio = document.querySelector(`input[name="macroMode-${id}"][value="loop"]`);
    if (loopRadio) loopRadio.checked = true;
    const delayWrap = document.getElementById(`macroLoopDelayWrap-${id}`);
    if (delayWrap) delayWrap.classList.remove('hidden');
    const delayInp = document.getElementById(`macroLoopDelay-${id}`);
    if (delayInp) delayInp.value = Math.max(1, Math.round((c.interval || c.delay || 5000) / 1000));
    const ta = document.getElementById(`macroText-${id}`);
    if (ta && !ta.value.trim() && c.text) ta.value = c.text;
  }
  updateMacroRunBtn(id);
}

// ── MINECRAFT CHAT-КОМПОНЕНТЫ ────────────────────────────────────────────────
// Заголовки окон и строки lore предметов сервер шлёт в "чат-JSON" формате:
// {"text":"","extra":[{"bold":true,"color":"#fb4e04","text":"▶ "}, ...]}
// Раньше просто пытались взять component.text — а он у составных сообщений
// пустой (текст лежит в extra[]), поэтому на экран лез сырой JSON целиком.
function mcComponentToRuns(input) {
  // Возвращает плоский список {text, color, bold, italic, underlined, strikethrough}
  let comp = input;
  if (typeof comp === 'string') {
    const s = comp.trim();
    if (s.startsWith('{') || s.startsWith('[')) {
      try { comp = JSON.parse(s); } catch { return [{ text: stripMcColorCodes(comp) }]; }
    } else {
      return [{ text: stripMcColorCodes(comp) }];
    }
  }
  const runs = [];
  const walk = (node, inherited) => {
    if (node == null) return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, inherited)); return; }
    if (typeof node === 'string') { runs.push({ ...inherited, text: node }); return; }
    if (typeof node !== 'object') return;
    const style = {
      color: node.color ?? inherited.color,
      bold: node.bold ?? inherited.bold,
      italic: node.italic ?? inherited.italic,
      underlined: node.underlined ?? inherited.underlined,
      strikethrough: node.strikethrough ?? inherited.strikethrough,
    };
    const text = node.text ?? (node.translate ? `[${node.translate}]` : '');
    if (text) runs.push({ ...style, text });
    if (node.extra) walk(node.extra, style);
  };
  walk(comp, {});
  return runs.length ? runs : [{ text: '' }];
}

const MC_NAMED_COLORS = {
  black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
  dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
  dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
  red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF',
};
function stripMcColorCodes(s) {
  return String(s || '').replace(/§[0-9a-fk-or]/gi, '');
}
function mcComponentToHtml(input) {
  return mcComponentToRuns(input).map(r => {
    if (!r.text) return '';
    const color = r.color ? (MC_NAMED_COLORS[r.color] || r.color) : null;
    const styles = [];
    if (color) styles.push(`color:${esc(color)}`);
    if (r.bold) styles.push('font-weight:700');
    if (r.italic) styles.push('font-style:italic');
    const deco = [r.underlined && 'underline', r.strikethrough && 'line-through'].filter(Boolean).join(' ');
    if (deco) styles.push(`text-decoration:${deco}`);
    const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
    return `<span${styleAttr}>${esc(r.text)}</span>`;
  }).join('');
}
function mcComponentToPlainText(input) {
  return mcComponentToRuns(input).map(r => r.text).join('');
}

// ── ИКОНКИ ПРЕДМЕТОВ ──────────────────────────────────────────────────────────
// Берём готовые текстуры из репозитория PrismarineJS/minecraft-assets через CDN —
// без локальной зависимости (пакет весит ~350МБ, тащить его в проект не нужно).
// На каждую версию своя папка данных; сопоставляем версии из выпадающего списка
// с ближайшей доступной. Если иконки для конкретного предмета нет — тихо
// откатываемся на текстовую подпись (как было раньше), без битых картинок.
const MC_ASSET_VERSION_MAP = {
  '1.16.5': '1.16.4', '1.17.1': '1.17.1', '1.18.2': '1.18.1', '1.19.4': '1.19.1',
  '1.20.1': '1.20.2', '1.20.4': '1.20.2', '1.21': '1.21.1',
};
function mcAssetVersion(version) {
  return MC_ASSET_VERSION_MAP[version] || '1.20.2';
}
function itemIconUrl(name, version) {
  const v = mcAssetVersion(version);
  return `https://cdn.jsdelivr.net/gh/PrismarineJS/minecraft-assets@master/data/${v}/items/${encodeURIComponent(name)}.png`;
}

// ── ТУЛТИП ПРЕДМЕТА (имя + лор при наведении) ────────────────────────────────
let _itemTooltipEl = null;
function _ensureItemTooltip() {
  if (_itemTooltipEl) return _itemTooltipEl;
  const el = document.createElement('div');
  el.className = 'item-tooltip hidden';
  document.body.appendChild(el);
  _itemTooltipEl = el;
  return el;
}
function showItemTooltip(evt, item) {
  const el = _ensureItemTooltip();
  const nameHtml = mcComponentToHtml(item.displayName || item.name || '?');
  const countPart = item.count > 1 ? ` <span class="item-tooltip-count">×${item.count}</span>` : '';
  let html = `<div class="item-tooltip-name">${nameHtml}${countPart}</div>`;
  if (item.lore && item.lore.length) {
    html += item.lore.map(l => `<div class="item-tooltip-lore">${mcComponentToHtml(l)}</div>`).join('');
  }
  if (item.maxDurability) {
    const pct = Math.max(0, Math.round(100 * (1 - item.durabilityUsed / item.maxDurability)));
    html += `<div class="item-tooltip-durability">Прочность: ${pct}%</div>`;
  }
  if (item.enchants?.length) {
    html += `<div class="item-tooltip-lore">✨ ${esc(item.enchants.join(', '))}</div>`;
  }
  el.innerHTML = html;
  el.classList.remove('hidden');
  positionItemTooltip(evt);
}
function positionItemTooltip(evt) {
  const el = _itemTooltipEl;
  if (!el || el.classList.contains('hidden')) return;
  const pad = 14;
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  const rect = el.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = evt.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight) y = evt.clientY - rect.height - pad;
  el.style.left = Math.max(4, x) + 'px';
  el.style.top = Math.max(4, y) + 'px';
}
function hideItemTooltip() {
  _itemTooltipEl?.classList.add('hidden');
}

function fillSlotEl(slotEl, item, botId) {
  if (!slotEl) return;
  let content = slotEl.querySelector('.item-content');
  if (!content) {
    content = document.createElement('div');
    content.className = 'item-content';
    slotEl.insertBefore(content, slotEl.firstChild);
  }
  content.innerHTML = '';
  slotEl.classList.toggle('filled', !!item);
  slotEl.title = '';
  slotEl.onmouseenter = null;
  slotEl.onmousemove = null;
  slotEl.onmouseleave = null;
  if (!item) {
    if (slotEl.dataset.label) slotEl.title = slotEl.dataset.label;
    return;
  }

  const version = state.bots[botId]?.server?.version;
  const iconWrap = document.createElement('div');
  iconWrap.className = 'item-icon-wrap';
  const nameSpan = document.createElement('div');
  nameSpan.className = 'item-name';
  nameSpan.textContent = (item.displayName || item.name || '').slice(0, 10);

  if (item.name) {
    const img = document.createElement('img');
    img.className = 'item-icon';
    img.alt = '';
    img.loading = 'lazy';
    img.src = itemIconUrl(item.name, version);
    img.onerror = () => {
      // Иконки для этого предмета/версии нет — просто показываем текстовую подпись
      img.remove();
      iconWrap.classList.add('no-icon');
      content.appendChild(nameSpan);
    };
    iconWrap.appendChild(img);
    content.appendChild(iconWrap);
  } else {
    content.appendChild(nameSpan);
  }

  if (item.count > 1) {
    const c = document.createElement('span');
    c.className = 'item-count';
    c.textContent = item.count;
    content.appendChild(c);
  }

  if (item.maxDurability) {
    const pct = Math.max(0, Math.round(100 * (1 - item.durabilityUsed / item.maxDurability)));
    const bar = document.createElement('div');
    bar.className = 'item-durability';
    bar.style.width = pct + '%';
    bar.style.background = pct > 30 ? 'var(--success)' : 'var(--danger)';
    content.appendChild(bar);
  }

  // Богатый тултип вместо нативного title — имя + лор + прочность + зачарования
  slotEl.onmouseenter = e => showItemTooltip(e, item);
  slotEl.onmousemove  = e => positionItemTooltip(e);
  slotEl.onmouseleave = hideItemTooltip;
}

function renderInventory(id, data) {
  ensurePlayerInvGrids(id);
  const slots = data.slots || [];
  for (let i = 5; i <= 8; i++)  fillSlotEl(document.getElementById(`pslot-${id}-${i}`), slots[i], id);
  for (let i = 9; i <= 35; i++) fillSlotEl(document.getElementById(`pslot-${id}-${i}`), slots[i], id);
  for (let n = 1; n <= 9; n++) {
    const hbSlot = document.getElementById(`slot-${id}-${n}`);
    if (!hbSlot) continue;
    const realSlot = 35 + n;
    hbSlot.dataset.slot = realSlot;
    hbSlot.onclick = e => { e.stopPropagation(); invClick(id, realSlot, 0, e.shiftKey ? 1 : 0); };
    hbSlot.oncontextmenu = e => { e.preventDefault(); invClick(id, realSlot, 1, 0); };
    fillSlotEl(hbSlot, slots[realSlot], id);
  }
}

// ── ОКНА (сундук / печь / верстак) ────────────────────────────────────────────
function makeWinSlotEl(id, slot) {
  const div = document.createElement('div');
  div.className = 'inv-slot';
  div.id = `wslot-${id}-${slot}`;
  div.dataset.slot = slot;
  div.addEventListener('click',       e => invClick(id, slot, 0, e.shiftKey ? 1 : 0));
  div.addEventListener('contextmenu', e => { e.preventDefault(); invClick(id, slot, 1, e.shiftKey ? 1 : 0); });
  return div;
}

function renderWindow(id, win) {
  if (!win) return;
  // Оверлей живёт внутри карточки (position:fixed работает и без переноса в body,
  // т.к. у .bot-card нет transform/filter) — не переносим его, иначе при
  // повторном renderCard() плодятся элементы-сироты с задублированным id.
  const overlay = document.getElementById(`winOverlay-${id}`);
  const titleEl = document.getElementById(`winTitle-${id}`);
  const topEl   = document.getElementById(`winTop-${id}`);
  const mainEl  = document.getElementById(`winMain-${id}`);
  const hotEl   = document.getElementById(`winHotbar-${id}`);
  if (!overlay || !topEl || !mainEl || !hotEl) return;

  overlay.classList.remove('hidden');

  if (titleEl) {
    titleEl.innerHTML = mcComponentToHtml(win.title || 'Меню');
  }

  const invStart  = win.inventoryStart ?? win.slots.length;
  const total     = win.slotCount ?? win.slots.length;
  const mainCount = 27;
  const buildKey  = `${win.id}:${total}`;

  if (overlay.dataset.builtFor !== buildKey) {
    topEl.innerHTML = ''; mainEl.innerHTML = ''; hotEl.innerHTML = '';
    for (let i = 0; i < invStart; i++) topEl.appendChild(makeWinSlotEl(id, i));
    for (let i = invStart; i < Math.min(invStart + mainCount, total); i++) mainEl.appendChild(makeWinSlotEl(id, i));
    for (let i = invStart + mainCount; i < total; i++) hotEl.appendChild(makeWinSlotEl(id, i));
    overlay.dataset.builtFor = buildKey;
  }

  (win.slots || []).forEach((item, i) =>
    fillSlotEl(document.getElementById(`wslot-${id}-${i}`), item, id)
  );
}

function hideWindowUI(id) {
  const o = document.getElementById(`winOverlay-${id}`);
  if (o) { o.classList.add('hidden'); o.dataset.builtFor = ''; }
}
function closeWindowUI(id) {
  hideWindowUI(id);
  socket.emit('bot:windowClose', { id });
}

// ── LOOK PAD ──────────────────────────────────────────────────────────────────
// Единый набор document/window-listener'ов на весь документ (не по одному на
// каждый renderCard()), иначе при каждом реконнекте socket.io плодятся
// дублирующиеся глобальные обработчики mousemove/touchmove.
let _lookActivePad = null;
let _lookActiveId  = null;

document.addEventListener('mousemove', e => {
  if (!_lookActivePad || !_lookActiveId) return;
  _doLook(_lookActiveId, _lookActivePad, e.clientX, e.clientY);
});
document.addEventListener('mouseup', () => { _lookActivePad = null; _lookActiveId = null; });
document.addEventListener('touchmove', e => {
  if (!_lookActivePad || !_lookActiveId) return;
  _doLook(_lookActiveId, _lookActivePad, e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });
document.addEventListener('touchend', () => { _lookActivePad = null; _lookActiveId = null; });

function _doLook(id, pad, cx, cy) {
  const rect = pad.getBoundingClientRect();
  const dx = Math.max(-1, Math.min(1, (cx - rect.left - rect.width / 2) / (rect.width / 2)));
  const dy = Math.max(-1, Math.min(1, (cy - rect.top - rect.height / 2) / (rect.height / 2)));
  const yaw   = dx * Math.PI;
  const pitch = dy * (Math.PI / 2);
  const dot = document.getElementById(`ldot-${id}`);
  if (dot) { dot.style.left = (50 + dx * 40) + '%'; dot.style.top = (50 + dy * 40) + '%'; }
  const yEl = document.getElementById(`lyaw-${id}`);
  const pEl = document.getElementById(`lpitch-${id}`);
  if (yEl) yEl.textContent = (yaw * 180 / Math.PI).toFixed(0);
  if (pEl) pEl.textContent = (pitch * 180 / Math.PI).toFixed(0);
  socket.emit('bot:look', { id, yaw, pitch });
}

function initLookPad(id) {
  const pad = document.getElementById(`lpad-${id}`);
  if (!pad) return;
  pad.addEventListener('mousedown', e => { _lookActivePad = pad; _lookActiveId = id; _doLook(id, pad, e.clientX, e.clientY); });
  pad.addEventListener('touchstart', e => { _lookActivePad = pad; _lookActiveId = id; _doLook(id, pad, e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
}

// ── KEYBOARD (WASD) ───────────────────────────────────────────────────────────
let focusedId = null;
const keyMap  = { w:'forward', s:'back', a:'left', d:'right', ' ':'jump' };
const heldKeys = new Set();

document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  const key = keyMap[e.key];
  if (!key || !focusedId || heldKeys.has(key)) return;
  e.preventDefault();
  heldKeys.add(key);
  socket.emit('bot:key', { id: focusedId, key, state: true });
  document.getElementById(`dpad-${focusedId}`)?.querySelector(`[data-key="${key}"]`)?.classList.add('held');
});
document.addEventListener('keyup', e => {
  const key = keyMap[e.key];
  if (!key) return;
  heldKeys.delete(key);
  if (!focusedId) return;
  socket.emit('bot:key', { id: focusedId, key, state: false });
  document.getElementById(`dpad-${focusedId}`)?.querySelector(`[data-key="${key}"]`)?.classList.remove('held');
});
// Если вкладка/окно теряет фокус, зажатые клавиши физически не отпустятся —
// снимаем их принудительно, иначе бот может уехать "в стену" навсегда.
window.addEventListener('blur', () => {
  if (!focusedId) { heldKeys.clear(); return; }
  heldKeys.forEach(key => {
    socket.emit('bot:key', { id: focusedId, key, state: false });
    document.getElementById(`dpad-${focusedId}`)?.querySelector(`[data-key="${key}"]`)?.classList.remove('held');
  });
  heldKeys.clear();
});

// Клик по карточке — фокус для WASD
document.addEventListener('click', e => {
  const card = e.target.closest('.bot-card');
  document.querySelectorAll('.bot-card.focused').forEach(c => c.classList.remove('focused'));
  if (card) {
    const id = card.id.replace('card-', '');
    focusedId = id;
    card.classList.add('focused');
  } else {
    focusedId = null;
  }
});

// ── CONNECT / DISCONNECT ──────────────────────────────────────────────────────
async function connectBot(id) {
  const host    = document.getElementById(`host-${id}`).value.trim();
  const port    = document.getElementById(`port-${id}`).value.trim();
  const version = document.getElementById(`ver-${id}`).value;
  if (!host) return alert('Укажи хост');
  await fetch(`/api/bots/${id}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host, port, version })
  });
}
async function disconnectBot(id) {
  await fetch(`/api/bots/${id}/disconnect`, { method: 'POST' });
}

// ── REMOVE ────────────────────────────────────────────────────────────────────
async function removeBot(id) {
  if (!confirm('Удалить аккаунт?')) return;
  await fetch(`/api/bots/${id}`, { method: 'DELETE' });
  document.getElementById(`card-${id}`)?.remove();
  delete state.bots[id];
  if (focusedId === id) focusedId = null;
  renderBulkList();
  showEmptyIfNeeded();
}

// ── MODAL ─────────────────────────────────────────────────────────────────────
function openModal(mode, id) {
  document.getElementById('modalOverlay').classList.remove('hidden');
  document.getElementById('modalTitle').textContent = mode === 'add' ? 'Добавить аккаунт' : 'Редактировать';
  document.getElementById('editId').value = id || '';

  if (mode === 'edit' && id) {
    const b = state.bots[id];
    if (!b) return;
    const acc = b.account;
    document.getElementById('mUsername').value  = acc.username || '';
    document.getElementById('mAuthType').value  = acc.authType || 'offline';
    document.getElementById('mPassword').value  = '';
    // proxy теперь из пула, не редактируется тут
    document.getElementById('mAuthRegisterCommand').value = acc.authConfig?.registerCommand === state.settings?.authRegisterCommand ? '' : (acc.authConfig?.registerCommand || '');
    document.getElementById('mAuthLoginCommand').value    = acc.authConfig?.loginCommand === state.settings?.authLoginCommand ? '' : (acc.authConfig?.loginCommand || '');
    document.getElementById('mRecOnReconnect').checked = !!b.recoveryTriggers?.onReconnect;
    document.getElementById('mRecOnRespawn').checked   = !!b.recoveryTriggers?.onRespawn;
    document.getElementById('mRecSequence').value      = b.recoverySequenceText || '';
  } else {
    ['mUsername','mPassword','mAuthRegisterCommand','mAuthLoginCommand'].forEach(fid => {
      document.getElementById(fid).value = '';
    });
    document.getElementById('mAuthType').value         = 'offline';
    // proxy type reset not needed
    document.getElementById('mRecOnReconnect').checked = false;
    document.getElementById('mRecOnRespawn').checked   = false;
    document.getElementById('mRecSequence').value      = '';
  }
  togglePasswordField();
}
function closeModal() { document.getElementById('modalOverlay').classList.add('hidden'); }
function togglePasswordField() {
  // Пароль здесь — НЕ пароль от Mojang/Microsoft аккаунта, а пароль для входа
  // на сервер (AuthMe и т.п., команда /login). Он нужен именно при Offline-типе
  // авторизации (крякнутый клиент) — то есть почти всегда в этом проекте.
  // Раньше поле скрывалось при offline — это было перепутано, показываем всегда.
  document.getElementById('passRow').style.display = '';
}

async function saveAccount() {
  const username = document.getElementById('mUsername').value.trim();
  if (!username) return alert('Введи никнейм');
  const id = document.getElementById('editId').value;

  // Прокси назначается автоматически из пула при подключении
  const proxy = null;

  const registerCommand = document.getElementById('mAuthRegisterCommand').value.trim();
  const loginCommand    = document.getElementById('mAuthLoginCommand').value.trim();

  const payload = {
    username,
    authType: document.getElementById('mAuthType').value,
    password: document.getElementById('mPassword').value,
    proxy,
    authConfig: (registerCommand || loginCommand) ? { registerCommand, loginCommand } : { registerCommand: '', loginCommand: '' },
    recoveryTriggers: {
      onReconnect: document.getElementById('mRecOnReconnect').checked,
      onRespawn:   document.getElementById('mRecOnRespawn').checked,
    },
    recoverySequenceText: document.getElementById('mRecSequence').value,
  };

  if (id) {
    const res = await fetch(`/api/bots/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const b = await res.json();
    state.bots[id] = b;
    const nameEl = document.querySelector(`#card-${id} .card-name`);
    if (nameEl) nameEl.textContent = username;
  } else {
    const res = await fetch('/api/bots', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const b = await res.json();
    state.bots[b.id] = b;
    renderCard(b);
    renderBulkList();
  }
  closeModal();
  showEmptyIfNeeded();
}

// ── MANAGE PANEL ──────────────────────────────────────────────────────────────
// Видимость управляется только классом .open (max-height в CSS) — единообразно
// с разметкой в index.html, никакого отдельного .hidden здесь.
// ── TABS & THEME ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  const managePanel  = document.getElementById('managePanel');
  const proxyTab     = document.getElementById('proxyTab');
  const settingsTab  = document.getElementById('settingsTab');

  managePanel.classList.remove('open');
  proxyTab.style.display = 'none';
  settingsTab.style.display = 'none';

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));

  if (tab === 'manage') {
    document.getElementById('tabManage').classList.add('active');
    managePanel.classList.add('open');
    renderBulkList();
    _proxyTabVisible = false;
  } else if (tab === 'proxy') {
    document.getElementById('tabProxy').classList.add('active');
    proxyTab.style.display = 'block';
    _proxyTabVisible = true;
    loadProxiesUI();
  } else if (tab === 'settings') {
    document.getElementById('tabSettings').classList.add('active');
    settingsTab.style.display = 'block';
    _proxyTabVisible = false;
    fillSettingsForm(state.settings);
  } else {
    document.getElementById('tabBots').classList.add('active');
    _proxyTabVisible = false;
  }
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light');
  document.getElementById('themeBtn').textContent = isLight ? '☀️' : '🌙';
  localStorage.setItem('ultbot-theme', isLight ? 'light' : 'dark');
}

// Восстанавливаем тему при загрузке
(function() {
  const saved = localStorage.getItem('ultbot-theme');
  if (saved === 'light') {
    document.body.classList.add('light');
    const btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = '☀️';
  }
})();

function togglePanel() {
  switchTab(document.getElementById('managePanel').classList.contains('open') ? 'bots' : 'manage');
}

function renderBulkList() {
  const list = document.getElementById('bulkList');
  if (!list) return;
  list.innerHTML = '';
  Object.values(state.bots).forEach(b => {
    const div = document.createElement('div');
    div.className = 'bulk-card';
    div.id = `bulk-${b.id}`;
    div.innerHTML = `
      <input type="checkbox" id="bc-${b.id}" checked>
      <div class="bulk-dot ${b.status}" id="bdot-${b.id}"></div>
      <span>${esc(b.account?.username || '?')}</span>`;
    list.appendChild(div);
  });
}

function updateBulkDot(id, status) {
  const dot = document.getElementById(`bdot-${id}`);
  if (dot) dot.className = `bulk-dot ${status}`;
}

// Единая функция получения выбранных ботов (раньше было два дублирующих варианта)
function getSelectedIds() {
  return Object.keys(state.bots).filter(id => {
    const cb = document.getElementById(`bc-${id}`);
    return cb?.checked;
  });
}

async function bulkConnect() {
  const host    = document.getElementById('bulkHost').value.trim();
  const port    = document.getElementById('bulkPort').value.trim();
  const version = document.getElementById('bulkVersion').value;
  if (!host) return alert('Укажи хост');
  const ids = getSelectedIds();
  if (!ids.length) return alert('Не выбрано ни одного бота!');
  const autoJoin = document.getElementById('bulkAutoJoin')?.checked;
  for (const id of ids) {
    await fetch(`/api/bots/${id}/connect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, version })
    });
    if (autoJoin) socket.emit('bot:autoReconnect', { id, enabled: true });
    await sleep(800);
  }
}

async function bulkDisconnect() {
  const ids = getSelectedIds();
  if (!ids.length) return alert('Не выбрано ни одного бота!');
  for (const id of ids) {
    await fetch(`/api/bots/${id}/disconnect`, { method: 'POST' });
    await sleep(300);
  }
}

function setBulkAutoReconnect(enabled) {
  const ids = getSelectedIds();
  if (!ids.length) return alert('Не выбрано ни одного бота!');
  socket.emit('bots:bulkAction', { ids, action: 'autoReconnect', data: { enabled } });
}

function bulkClicker(active) {
  const ids = getSelectedIds();
  if (!ids.length) return alert('Не выбрано ни одного бота!');
  const button = document.getElementById('bulkClickerBtn').value;
  const delay  = document.getElementById('bulkClickerDelay').value;
  socket.emit('bots:bulkAction', { ids, action: 'clicker', data: { active, button, delay } });
}

function bulkClickSlot() {
  const slot = parseInt(document.getElementById('bulkSlotInput').value);
  if (isNaN(slot)) return alert('Введите корректный номер слота!');
  sendBulkAction('clickSlot', { slot });
}

function sendBulkAction(action, data = {}) {
  const ids = getSelectedIds();
  if (!ids.length) return alert('Не выбрано ни одного бота!');
  socket.emit('bots:bulkAction', { ids, action, data });
}

// Авто-отправка сообщения выбранным ботам
let _chatLoopActiveIds = [];
function toggleBulkChatLoop() {
  const toggle   = document.getElementById('bulkChatLoopToggle');
  const statusEl = document.getElementById('bulkChatLoopStatus');
  if (toggle.checked) {
    const text  = document.getElementById('bulkChatLoopInput').value.trim();
    const delay = Math.max(1000, parseInt(document.getElementById('bulkChatLoopDelay').value) || 5000);
    const ids   = getSelectedIds();
    if (!text)       { alert('Введите команду/сообщение!'); toggle.checked = false; return; }
    if (!ids.length) { alert('Не выбрано ни одного бота!'); toggle.checked = false; return; }
    _chatLoopActiveIds = ids;
    socket.emit('bots:bulkAction', { ids, action: 'chatLoop', data: { active: true, text, delay } });
    statusEl.textContent = `Вкл. · каждые ${delay}мс · ${ids.length} бот(ов)`;
  } else {
    const ids = _chatLoopActiveIds.length ? _chatLoopActiveIds : getSelectedIds();
    socket.emit('bots:bulkAction', { ids, action: 'chatLoop', data: { active: false } });
    _chatLoopActiveIds = [];
    statusEl.textContent = 'Выкл.';
  }
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function showEmptyIfNeeded() {
  const grid = document.getElementById('botsGrid');
  const hasCards = !!grid.querySelector('.bot-card');
  const empty    = grid.querySelector('.empty-state');
  if (!hasCards && !empty) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="icon">🤖</div>
        <p>Нет аккаунтов. Добавь первый!</p>
        <button class="btn btn-primary" onclick="openModal('add')">+ Добавить аккаунт</button>
      </div>`;
  } else if (hasCards && empty) {
    empty.remove();
  }
}

// ── INIT ──────────────────────────────────────────────────────────────────────
showEmptyIfNeeded();


// ── ВКЛАДКА ПРОКСИ ───────────────────────────────────────────────────────────
let _proxyTabVisible = false;

function showProxyTab() { switchTab('proxy'); }

async function loadProxiesUI() {
  try {
    const [proxies, usageData] = await Promise.all([
      fetch('/api/proxies').then(r => r.json()),
      fetch('/api/proxies/usage').then(r => r.json()),
    ]);
    const usageResp = usageData.usage || usageData; // подстраховка на случай старого формата ответа
    const limit = usageData.limit || state.settings?.proxyLimit || 3;

    // Заполняем textarea
    const textarea = document.getElementById('proxyInput');
    if (textarea && !textarea.value.trim()) {
      textarea.value = proxies.map(p => {
        let line = `${p.host}:${p.port}`;
        if (p.username) line += `:${p.username}:${p.password || ''}`;
        return line;
      }).join('\n');
    }

    // Рендерим таблицу
    const list = document.getElementById('proxyList');
    if (!list) return;
    if (!proxies.length) {
      list.innerHTML = '<div style="color:var(--text2);font-size:12px">Прокси не добавлены</div>';
      return;
    }

    const rows = proxies.map((p, i) => {
      const key   = `${p.host}:${p.port}`;
      const count = usageResp[key] || 0;
      const free  = limit - count;
      const color = free <= 0 ? '#f56565' : free === 1 ? '#ed8936' : '#68d391';
      return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">
        <span style="font-family:monospace;flex:1">${p.type || 'socks5'}://${p.username ? p.username+'@' : ''}${p.host}:${p.port}</span>
        <span style="color:${color};font-weight:600">${count}/${limit} ботов</span>
        <span id="proxyTestResult-${i}" style="font-size:11px;color:var(--text2)"></span>
        <button class="btn btn-ghost btn-sm" onclick="testPoolProxy(${i})">🔍 Проверить</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteProxy(${i})">✕</button>
      </div>`;
    }).join('');

    list.innerHTML = `<div style="font-size:11px;color:var(--text2);margin-bottom:6px">Всего прокси: ${proxies.length} | Лимит на прокси: ${limit} | Свободных слотов: ${proxies.reduce((a,p)=>a+Math.max(0,limit-(usageResp[p.host+':'+p.port]||0)),0)}</div>${rows}`;
  } catch (e) {
    console.error('loadProxiesUI:', e);
  }
}

async function saveProxies() {
  const textarea = document.getElementById('proxyInput');
  const status   = document.getElementById('proxySaveStatus');
  const lines    = textarea?.value || '';
  try {
    const r = await fetch('/api/proxies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines }),
    });
    const data = await r.json();
    if (status) status.textContent = `✅ Сохранено ${data.count} прокси`;
    textarea.value = '';
    await loadProxiesUI();
    setTimeout(() => { if (status) status.textContent = ''; }, 3000);
  } catch (e) {
    if (status) status.textContent = '❌ Ошибка: ' + e.message;
  }
}

async function deleteProxy(idx) {
  await fetch(`/api/proxies/${idx}`, { method: 'DELETE' });
  await loadProxiesUI();
}

async function testPoolProxy(idx) {
  const el = document.getElementById(`proxyTestResult-${idx}`);
  try {
    const proxies = await fetch('/api/proxies').then(r => r.json());
    const p = proxies[idx];
    if (!p) return;
    if (el) { el.textContent = '⏳ Проверяю...'; el.style.color = 'var(--text2)'; }
    const r = await fetch('/api/proxy-test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p),
    });
    const d = await r.json();
    if (el) {
      el.textContent = d.ok ? '✅ Работает' : `❌ ${d.error || 'Ошибка'}`;
      el.style.color = d.ok ? 'var(--success)' : 'var(--danger)';
    }
  } catch (e) {
    if (el) { el.textContent = '❌ ' + e.message; el.style.color = 'var(--danger)'; }
  }
}

// Обновляем список когда сервер сообщает об изменениях
socket.on('proxies:updated', () => {
  if (_proxyTabVisible) loadProxiesUI();
});

// ── БЫСТРЫЙ ВЫБОР ПРОКСИ ДЛЯ БОТА (кнопка 🪄 в плашке) ────────────────────────
function closeAllProxyPickers(exceptId) {
  document.querySelectorAll('.proxy-picker').forEach(el => {
    if (!exceptId || el.id !== `proxyPicker-${exceptId}`) el.classList.add('hidden');
  });
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.proxy-picker') && !e.target.closest('[onclick^="toggleProxyPicker"]')) {
    closeAllProxyPickers();
  }
});

async function toggleProxyPicker(id) {
  const el = document.getElementById(`proxyPicker-${id}`);
  if (!el) return;
  const willOpen = el.classList.contains('hidden');
  closeAllProxyPickers(id);
  if (!willOpen) { el.classList.add('hidden'); return; }

  el.classList.remove('hidden');
  el.innerHTML = `<div style="padding:8px;font-size:11px;color:var(--text2)">⏳ Загружаю прокси...</div>`;
  try {
    const [proxies, usageData] = await Promise.all([
      fetch('/api/proxies').then(r => r.json()),
      fetch('/api/proxies/usage').then(r => r.json()),
    ]);
    const usage = usageData.usage || usageData;
    const limit = usageData.limit || state.settings?.proxyLimit || 3;
    const currentProxy = state.bots[id]?.account?.proxy;
    const isDirect = !!state.bots[id]?.account?.useDirect;
    const isCurrentAuto = !isDirect && (!currentProxy || !currentProxy.host);

    // --- СТИЛЬ ПОДСВЕТКИ ---
    const highlightStyle = "background-color: #ffeb3b; color: #000; padding: 2px 4px; border-radius: 4px; font-weight: bold;";

    // Пытаемся достать фактический IP бота (если он есть в state) или берем хост текущего прокси
    const actualIp = state.bots[id]?.ip || state.bots[id]?.lastIp || (currentProxy ? currentProxy.host : null);

    // Блок, который покажет подсвеченный IP в самом верху плашки
    const lastIpHeader = actualIp
      ? `<div style="padding: 6px 8px; font-size: 12px; border-bottom: 1px solid rgba(255,255,255,0.1); margin-bottom: 4px; color: var(--text2)">
          Последний IP: <span style="${highlightStyle}">${actualIp}</span>
         </div>`
      : '';

    const directRow = `<div class="proxy-picker-row${isDirect ? ' active' : ''}" onclick="selectBotProxy('${id}', 'direct')" title="Без прокси — подключение с реального IP этого сервера">
      <span style="${isDirect ? highlightStyle : ''}">🌐 Свой IP (без прокси)</span>
    </div>`;

    const autoRow = `<div class="proxy-picker-row${isCurrentAuto ? ' active' : ''}" onclick="selectBotProxy('${id}', null)">
      <span style="${isCurrentAuto ? highlightStyle : ''}">🎲 Авто (из пула)</span>
    </div>`;

    const rows = proxies.map(p => {
      const key = `${p.host}:${p.port}`;
      const count = usage[key] || 0;
      const full = count >= limit;
      // Проверяем, является ли этот прокси тем, с которого бот сидит сейчас
      const isCurrent = !isDirect && currentProxy && currentProxy.host === p.host && String(currentProxy.port) === String(p.port);

      return `<div class="proxy-picker-row${isCurrent ? ' active' : ''}${full ? ' full' : ''}"
          onclick='selectBotProxy("${id}", ${JSON.stringify(p).replace(/'/g, "&#39;")})'>
        <span style="font-family:monospace; ${isCurrent ? highlightStyle : ''}">${p.host}:${p.port}</span>
        <span style="color:${full ? 'var(--danger)' : 'var(--text2)'}">${count}/${limit}</span>
      </div>`;
    }).join('');

    // Собираем всё вместе: заголовок с IP + кнопки (прямой/авто) + список прокси
    el.innerHTML = lastIpHeader + directRow + autoRow + (proxies.length
      ? rows
      : `<div style="padding:8px;font-size:11px;color:var(--text2)">Пул прокси пуст — добавь во вкладке «Прокси»</div>`);
  } catch (e) {
    el.innerHTML = `<div style="padding:8px;font-size:11px;color:var(--danger)">❌ ${e.message}</div>`;
  }
}

// proxy: object — конкретный прокси · null — авто из пула · 'direct' — без прокси (свой IP).
// Только СОХРАНЯЕТ выбор — подключаться нужно отдельно кнопкой "▶ Подключить"
// (раньше выбор сразу форсировал (пере)подключение, что было неудобно).
async function selectBotProxy(id, proxy) {
  closeAllProxyPickers();
  const useDirect = proxy === 'direct';
  const proxyPayload = useDirect ? null : proxy;
  try {
    await fetch(`/api/bots/${id}/proxy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxy: proxyPayload, useDirect })
    });
    if (state.bots[id]) {
      state.bots[id].account.proxy = proxyPayload;
      state.bots[id].account.useDirect = useDirect;
    }
  } catch (e) {
    console.error('selectBotProxy:', e);
  }
}


// ── КООРДИНАТЫ / POSITION GUARD ───────────────────────────────────────────────
function rememberPos(id) {
  socket.emit('bot:rememberPos', { id });
}

function forgetPos(id) {
  socket.emit('bot:forgetPos', { id });
}

function updateRememberedPosUI(id, pos) {
  const label   = document.getElementById(`savedPosLabel-${id}`);
  const forgetBtn = document.getElementById(`forgetPosBtn-${id}`);
  const remBtn  = document.querySelector(`#coordGuard-${id} .btn-ghost`);

  if (pos) {
    if (label) {
      label.style.display = 'inline';
      label.textContent   = `${pos.x}, ${pos.y}, ${pos.z}`;
    }
    if (forgetBtn) forgetBtn.style.display = 'inline-flex';
    if (remBtn) {
      remBtn.textContent = '📍 Обновить координаты';
      remBtn.style.background = 'var(--success-bg)';
      remBtn.style.borderColor = 'var(--success)';
      remBtn.style.color = 'var(--success)';
    }
  } else {
    if (label)    { label.style.display = 'none'; label.textContent = ''; }
    if (forgetBtn) forgetBtn.style.display = 'none';
    if (remBtn) {
      remBtn.textContent = '📍 Запомнить координаты';
      remBtn.style.background = '';
      remBtn.style.borderColor = '';
      remBtn.style.color = '';
    }
  }
}

// ── АВТОСКУПЩИК ──────────────────────────────────────────────────────────────
function toggleAutoShop(id) {
  const btn = document.getElementById(`autoShopToggle-${id}`);
  const active      = btn?.classList.contains('btn-danger') ? false : true;
  const openCmd     = document.getElementById(`shopOpenCmd-${id}`)?.value.trim() || '';
  const slots       = document.getElementById(`shopSlots-${id}`)?.value.trim() || '';
  const button      = parseInt(document.getElementById(`shopButton-${id}`)?.value) || 0;
  const delay       = parseInt(document.getElementById(`shopDelay-${id}`)?.value) || 0;
  const cycleDelay  = parseInt(document.getElementById(`shopCycleDelay-${id}`)?.value) || 0;
  socket.emit('bot:autoShop', { id, active, openCmd, slots, button, delay, cycleDelay });
}

function updateAutoShopUI(id, c) {
  const btn = document.getElementById(`autoShopToggle-${id}`);
  if (!btn) return;
  if (c?.active) {
    btn.textContent = '■ Стоп'; btn.className = 'btn btn-danger btn-sm';
  } else {
    btn.textContent = '▶ Старт'; btn.className = 'btn btn-success btn-sm';
  }
}

// ── КОСТИ → КОСТНАЯ МУКА ─────────────────────────────────────────────────────
function toggleAutoBoneMeal(id) {
  const btn = document.getElementById(`autoBoneMealToggle-${id}`);
  const active     = !btn?.classList.contains('btn-danger');
  const lookYaw    = parseFloat(document.getElementById(`boneMealYaw-${id}`)?.value) || 0;
  const lookPitch  = parseFloat(document.getElementById(`boneMealPitch-${id}`)?.value) || 0;
  socket.emit('bot:autoBoneMeal', { id, active, lookYaw, lookPitch });
}

function updateAutoBoneMealUI(id, c) {
  const btn = document.getElementById(`autoBoneMealToggle-${id}`);
  if (!btn) return;
  if (c?.active) {
    btn.textContent = '■ Стоп'; btn.className = 'btn btn-danger btn-sm';
  } else {
    btn.textContent = '▶ Старт'; btn.className = 'btn btn-success btn-sm';
  }
}

function setBoneMealLookHere(id) {
  const yawEl = document.getElementById(`lyaw-${id}`);
  const pitchEl = document.getElementById(`lpitch-${id}`);
  const yawInput = document.getElementById(`boneMealYaw-${id}`);
  const pitchInput = document.getElementById(`boneMealPitch-${id}`);
  if (yawEl && yawInput) yawInput.value = yawEl.textContent;
  if (pitchEl && pitchInput) pitchInput.value = pitchEl.textContent;
}

// ── АВТОРЫБАЛКА ──────────────────────────────────────────────────────────────
function toggleAutoFish(id) {
  const btn = document.getElementById(`autoFishToggle-${id}`);
  const active = !btn?.classList.contains('btn-danger');
  socket.emit('bot:autoFish', { id, active });
}

socket.on('bot:*:autoFish', () => {}); // placeholder
// Динамически подписываемся в subscribeBot

function updateAutoFishUI(id, c) {
  const btn  = document.getElementById(`autoFishToggle-${id}`);
  const hint = document.getElementById(`autoFishHint-${id}`);
  if (!btn) return;
  if (c?.active) {
    btn.textContent = '■ Стоп'; btn.className = 'btn btn-danger btn-sm';
    if (hint) hint.textContent = '🎣 Удочка заброшена...';
  } else {
    btn.textContent = '▶ Старт'; btn.className = 'btn btn-success btn-sm';
    if (hint) hint.textContent = '';
  }
}

// ── СКАНЕР ЧАТА ──────────────────────────────────────────────────────────────
function toggleChatScanner(id) {
  const btn = document.getElementById(`chatScannerToggle-${id}`);
  const active        = btn?.classList.contains('btn-danger') ? false : true;
  const pattern       = document.getElementById(`scannerPattern-${id}`)?.value || '';
  const whitelist     = document.getElementById(`scannerWhitelist-${id}`)?.value || '';
  const action        = document.getElementById(`scannerAction-${id}`)?.value || '';
  const nearInterval  = parseFloat(document.getElementById(`scannerNearInterval-${id}`)?.value) || 5;
  socket.emit('bot:chatScanner', { id, active, pattern, whitelist, action, nearInterval });
}

function updateChatScannerUI(id, c) {
  const btn    = document.getElementById(`chatScannerToggle-${id}`);
  const status = document.getElementById(`chatScannerStatus-${id}`);
  if (!btn) return;
  if (c?.active) {
    btn.textContent = '■ Стоп'; btn.className = 'btn btn-danger btn-sm';
    if (status) status.textContent = c.nearInterval > 0 ? `⏱ /near каждые ${c.nearInterval}с` : '⚡ Только слушаю';
  } else {
    btn.textContent = '▶ Старт'; btn.className = 'btn btn-success btn-sm';
    if (status) status.textContent = '';
  }
}

// Та же логика распознавания, что и на сервере (botmanager.js → extractNearMatch),
// продублирована здесь чтобы тестер работал мгновенно, без реального бота/сервера.
const AUTO_NEAR_PATTERNS = [
  { re: /\d+\.\s*([A-Za-z0-9_]{3,16})\s*[–\-—]\s*в\s*(\d+)/i, nameIdx: 1, distIdx: 2 },
  { re: /\(\s*[↓↑→←]?\s*(\d+)\s*\)\s*([A-Za-z0-9_]{3,16})/, nameIdx: 2, distIdx: 1 },
  { re: /([A-Za-z0-9_]{3,16})\s*\(\s*(\d+)\s*m?\s*\)/i, nameIdx: 1, distIdx: 2 },
  { re: /([A-Za-z0-9_]{3,16})\s*(?:[-–—]|в)\s*(\d+)\s*блок/i, nameIdx: 1, distIdx: 2 },
  { re: /([A-Za-z0-9_]{3,16})\s*[:\-–—]\s*(\d+)\s*m\b/i, nameIdx: 1, distIdx: 2 },
];
function extractNearMatchClient(clean, customPattern) {
  if (customPattern) {
    try {
      const re = new RegExp(customPattern, 'i');
      const m = clean.match(re);
      if (m) return { name: m[1] || m[0], dist: m[2] || '', via: 'свой паттерн' };
    } catch (e) {
      if (clean.toLowerCase().includes(customPattern.toLowerCase())) return { name: clean, dist: '', via: 'подстрока (регэксп невалиден)' };
    }
    return null;
  }
  for (const { re, nameIdx, distIdx } of AUTO_NEAR_PATTERNS) {
    const m = clean.match(re);
    if (m && m[nameIdx]) return { name: m[nameIdx], dist: m[distIdx] || '', via: 'авто-формат' };
  }
  return null;
}

function testScannerPattern(id) {
  const line = (document.getElementById(`scannerTestLine-${id}`)?.value || '').trim();
  const pattern = document.getElementById(`scannerPattern-${id}`)?.value.trim() || '';
  const resEl = document.getElementById(`scannerTestResult-${id}`);
  if (!resEl) return;
  if (!line) { resEl.innerHTML = '<span style="color:var(--warn)">Вставь строку для проверки</span>'; return; }

  const clean = line.replace(/§[0-9a-fk-or]/gi, '').trim();
  const found = extractNearMatchClient(clean, pattern);
  if (!found) {
    resEl.innerHTML = `<span style="color:var(--danger)">❌ Не совпало ни с чем (${pattern ? 'свой паттерн' : 'все авто-форматы'}). ` +
      `Подбери свой regex в поле «Паттерн» — первая группа <code>()</code> = имя, вторая = дистанция.</span>`;
    return;
  }
  resEl.innerHTML = `<span style="color:var(--success)">✅ Совпало (${found.via}): имя = <b>${esc(found.name)}</b>` +
    (found.dist ? `, дистанция = <b>${esc(found.dist)}</b>` : ', дистанция не найдена') + `</span>`;
}

// ── МАКРОС ПОЗИЦИИ ────────────────────────────────────────────────────────────
function togglePosMacroPanel(id) {
  const p = document.getElementById(`posMacroPanel-${id}`);
  if (!p) return;
  p.style.display = p.style.display === 'none' ? 'flex' : 'none';
}

function savePosMacro(id) {
  const text = document.getElementById(`posMacroText-${id}`)?.value || '';
  socket.emit('bot:setPosMacro', { id, text });
  showToast('Макрос позиции сохранён');
}