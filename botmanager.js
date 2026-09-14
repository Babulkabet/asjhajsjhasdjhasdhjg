import mineflayer from 'mineflayer';
import dns from 'dns';
import { createProxyStream } from './proxyconnect.js';
import { v4 as uuidv4 } from 'uuid';
import {
  customActivateBlock,
  customActivateEntity,
  customActivateItem,
  customDeactivateItem,
  customLeftClick,
  findBlockAtCursor,
} from './interact.js';
import { getSettings } from './settings.js';

// Глушим шумный лог из зависимости prismarine-chunk: при потере/повреждении части чанка
// (особенно часто бывает при подключении через прокси) она печатает это напрямую в консоль
// через console.log на каждый такой чанк — это не ошибка бота и не наш код, просто спам.
const _origConsoleLog = console.log;
console.log = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Ignoring block entities as chunk failed to load')) return;
  _origConsoleLog.apply(console, args);
};

// Простой построчный DSL для макроса восстановления, который пользователь пишет сам:
//   chat:/hub                    — написать в чат
//   wait:2000                    — подождать N миллисекунд
//   use                          — разовое использование предмета (ПКМ, короткий клик)
//   click:12:0:0                 — клик по слоту инвентаря/окна: слот:кнопка[0=ЛКМ,1=ПКМ]:режим[0=обычный,1=shift]
//   attack                       — разовая атака/удар (ЛКМ)
//   walk:forward:2000            — идти в направлении N мс (forward/back/left/right), потом остановиться
//   look:90:0                    — повернуться на yaw:pitch в ГРАДУСАХ (абсолютно)
//   jump                         — один прыжок
//   sneak:1000                   — присесть на N мс
//   sprint:2000                  — бежать (спринт) N мс
//   hold:left:3000                — зажать ЛКМ (аналог "бить не переставая") на N мс
//   hold:right:3000               — зажать ПКМ (использовать предмет и держать) на N мс
//   slot:0                        — выбрать слот хотбара 0-8
//   clicker:on:0:600              — включить автокликер: кнопка[0/1]:задержка мс
//   clicker:off                   — выключить автокликер
// ── РАСПОЗНАВАНИЕ ОТВЕТА /near (или аналога) ─────────────────────────────────
// Разные сервера шлют список игроков рядом в разном формате. Пробуем по очереди
// несколько распространённых вариантов, пока пользователь не задаст свой regex
// в поле "Паттерн". Каждый вариант указывает, в какой группе захвата ник, а в
// какой — дистанция (порядок групп у разных форматов разный).
const AUTO_NEAR_PATTERNS = [
  // "1. NICK - в 3 блока(ов)" (старый формат SunW)
  { re: /\d+\.\s*([A-Za-z0-9_]{3,16})\s*[–\-—]\s*в\s*(\d+)/i, nameIdx: 1, distIdx: 2 },
  // "Игроки рядом: (↓2) BudibuKiller" / "(2) NICK" — дистанция в скобках ПЕРЕД ником
  { re: /\(\s*[↓↑→←]?\s*(\d+)\s*\)\s*([A-Za-z0-9_]{3,16})/, nameIdx: 2, distIdx: 1 },
  // "NICK (2m)" / "NICK (2)" — дистанция в скобках ПОСЛЕ ника
  { re: /([A-Za-z0-9_]{3,16})\s*\(\s*(\d+)\s*m?\s*\)/i, nameIdx: 1, distIdx: 2 },
  // "NICK - 2 блок(ов)" / "NICK в 2 блоках"
  { re: /([A-Za-z0-9_]{3,16})\s*(?:[-–—]|в)\s*(\d+)\s*блок/i, nameIdx: 1, distIdx: 2 },
  // "NICK: 2m" / "NICK - 2m"
  { re: /([A-Za-z0-9_]{3,16})\s*[:\-–—]\s*(\d+)\s*m\b/i, nameIdx: 1, distIdx: 2 },
];

function extractAllNearMatches(clean, customPattern) {
  const results = [];
  const seen = new Set(); // защита от дублей — некоторые паттерны могут пересекаться

  const addFromRegex = (re, nameIdx, distIdx) => {
    // 'g' обязателен для matchAll — без него находили бы только первое совпадение,
    // из-за чего при нескольких игроках на /near срабатывал только один
    const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
    const globalRe = new RegExp(re.source, flags);
    for (const m of clean.matchAll(globalRe)) {
      const name = m[nameIdx];
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      results.push({ name, dist: m[distIdx] || '' });
    }
  };

  if (customPattern) {
    try {
      addFromRegex(new RegExp(customPattern, 'i'), 1, 2);
    } catch {
      if (clean.toLowerCase().includes(customPattern.toLowerCase())) results.push({ name: clean, dist: '' });
    }
    return results;
  }
  for (const { re, nameIdx, distIdx } of AUTO_NEAR_PATTERNS) {
    addFromRegex(re, nameIdx, distIdx);
  }
  return results;
}

// Для тестера паттерна (нужен только первый результат для наглядности)
function extractNearMatch(clean, customPattern) {
  return extractAllNearMatches(clean, customPattern)[0] || null;
}

function parseRecoverySequence(text) {
  return String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => !l.startsWith('#')) // строки-комментарии игнорируем
    .map(line => {
      const [type, ...rest] = line.split(':');
      const t = (type || '').trim().toLowerCase();
      if (t === 'chat') return { type: 'chat', text: rest.join(':').trim() };
      if (t === 'wait') return { type: 'wait', ms: Math.max(100, parseInt(rest[0]) || 1000) };
      if (t === 'click') return { type: 'click', slot: parseInt(rest[0]) || 0, button: parseInt(rest[1]) || 0, mode: parseInt(rest[2]) || 0 };
      if (t === 'attack') return { type: 'attack' };
      if (t === 'use') return { type: 'use' };
      if (t === 'walk') {
        const dir = (rest[0] || 'forward').trim().toLowerCase();
        if (!['forward', 'back', 'left', 'right'].includes(dir)) return null;
        return { type: 'walk', dir, ms: Math.max(100, parseInt(rest[1]) || 1000) };
      }
      if (t === 'look') return { type: 'look', yawDeg: parseFloat(rest[0]) || 0, pitchDeg: parseFloat(rest[1]) || 0 };
      if (t === 'jump') return { type: 'jump' };
      if (t === 'sneak') return { type: 'sneak', ms: Math.max(100, parseInt(rest[0]) || 1000) };
      if (t === 'sprint') return { type: 'sprint', ms: Math.max(100, parseInt(rest[0]) || 1000) };
      if (t === 'hold') {
        const btn = (rest[0] || 'left').trim().toLowerCase();
        if (!['left', 'right'].includes(btn)) return null;
        return { type: 'hold', button: btn, ms: Math.max(100, parseInt(rest[1]) || 1000) };
      }
      if (t === 'slot') return { type: 'slot', slot: Math.min(8, Math.max(0, parseInt(rest[0]) || 0)) };
      if (t === 'clicker') {
        const mode = (rest[0] || 'off').trim().toLowerCase();
        if (mode === 'on') return { type: 'clickerOn', button: parseInt(rest[1]) || 0, delay: parseInt(rest[2]) || 600 };
        return { type: 'clickerOff' };
      }
      // Реконнект/коннект/дисконнект
      if (t === 'reconnect') return { type: 'reconnect' };
      if (t === 'disconnect') return { type: 'disconnect' };
      if (t === 'connect') {
        const host = rest[0]?.trim() || null;
        const port = parseInt(rest[1]) || 25565;
        const version = rest[2]?.trim() || null;
        return { type: 'connect', host, port, version };
      }
      return null;
    })
    .filter(Boolean);
}

export class BotInstance {
  constructor(account, io, persist) {
    this.id = account.id || uuidv4();
    this.account = account; // { username, password, authType, proxy }
    this.io = io;
    this._persist = typeof persist === 'function' ? persist : () => {};
    this.bot = null;
    this.status = 'offline'; // offline | connecting | online | error
    this.chatLog = [];
    this.hud = { health: 0, food: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, ping: 0 };
    this.inventory = [];      // last known slots of bot.inventory (player inventory)
    this.window = null;       // currently open foreign window (chest/furnace/etc), if any
    this._reconnectTimer = null;
    this._hudTimer = null;
    this._holdKeys = new Set();
    this._invUpdateTimer = null;
    this._winUpdateTimer = null;
    this._clickerTimer = null;
    // Все автоматизации (кликер/авто-бал/авто-хил/авто-чат/авто-реконнект) при
    // наличии сохранённого состояния в account восстанавливаются здесь — иначе
    // после `npm start` настройки терялись, даже если формально лежали в JSON.
    this.clicker = {
      active: false,
      button: account.clicker?.button ?? 0,
      delay: account.clicker?.delay ?? 600,
    };
    this._clickerWasActive  = account.clicker?.active === true;  // запомненное состояние кликера до дисконнекта/рестарта
    this._autoBalWasActive  = account.autoBal?.active === true;  // то же для авто-бала
    this._autoHealWasActive = account.autoHeal?.active === true; // то же для авто-хила
    this._chatLoopTimer = null;
    this.chatLoop = {
      active: false,
      text: account.chatLoop?.text || '',
      delay: account.chatLoop?.delay || 5000,
    };
    this._macroLoopTimer = null;
    this.macroLoop = {
      active: false,
      text: account.macroLoop?.text || '',
      delay: account.macroLoop?.delay || 5000,
    };
    this._macroLoopWasActive = account.macroLoop?.active === true;
    this._chatLoopWasActive = account.chatLoop?.active === true;
    this.autoReconnect = !!account.autoReconnect;

    // ── Авторыбалка ──────────────────────────────────────────────────────────
    this.autoFish = { active: false };
    this._fishTimer = null;
    this._fishBobberEntityId = null;
    this._onFishBite = null;
    this._autoFishWasActive = account.autoFish?.active === true;

    // ── Автоскупщик ──────────────────────────────────────────────────────────
    this.autoShop = {
      active:     false,
      openCmd:    account.autoShop?.openCmd    ?? '',
      slots:      account.autoShop?.slots      ?? '',
      button:     account.autoShop?.button     ?? 0,
      delay:      account.autoShop?.delay      ?? 500,
      cycleDelay: account.autoShop?.cycleDelay ?? 1000,
    };
    this._autoShopTimer = null;
    this._autoShopWasActive = account.autoShop?.active === true;

    // ── Кости → Костная мука (авто) ─────────────────────────────────────────
    this.autoBoneMeal = {
      active:    false,
      lookYaw:   account.autoBoneMeal?.lookYaw   ?? 0,
      lookPitch: account.autoBoneMeal?.lookPitch ?? 90,
    };
    this._boneMealTimer = null;
    this._autoBoneMealWasActive = account.autoBoneMeal?.active === true;

    // ── Сканер чата ──────────────────────────────────────────────────────────
    this.chatScanner = account.chatScanner || { active: false, pattern: '', whitelist: [], action: '' };
    this._chatScannerWasActive = account.chatScanner?.active === true;
    this._chatScannerListener = null;
    this._chatScannerNearTimer = null;
    this._chatScannerAwaitingNearUntil = 0;
    this._manualDisconnect = false;
    this._reconnectAttempts = 0;
    this._reconnectScheduled = false;
    this.recoveryTriggers = account.recoveryTriggers || { onReconnect: false, onRespawn: false };
    this.recoverySequence = parseRecoverySequence(account.recoverySequenceText || '');
    this._recoveryRunning = false;
    this._lastRecoveryAt = 0;
    this._loggedIn = false;
    this._lastAutoLoginAt = 0;
    this._authAttempts = 0;
    const s = getSettings();
    // ВАЖНО: мёржим с дефолтами по полям, а не через account.authConfig || {defaults}.
    // Раньше если в accounts.json лежал ЧАСТИЧНЫЙ authConfig (например без поля
    // "enabled" — так бывает у записей, отредактированных руками или сохранённых
    // старой версией кода), весь блок дефолтов отбрасывался целиком, и в частности
    // "enabled" мог быть undefined → авто-логин молча выключался, даже если пароль
    // в accounts.json стоял правильный.
    const savedAuth = account.authConfig || {};
    this.authConfig = {
      enabled: savedAuth.enabled !== false, // отсутствие поля = включено
      registerCommand: savedAuth.registerCommand || s.authRegisterCommand,
      loginCommand: savedAuth.loginCommand || s.authLoginCommand,
      registerPattern: savedAuth.registerPattern || s.authRegisterPattern,
      loginPattern: savedAuth.loginPattern || s.authLoginPattern,
    };

    // ── Запомненные координаты — если бота увело далеко (кик из режима, телепорт
    // и т.п.), запускаем тот же макрос восстановления, что и на реконнект/респавн ──
    this.rememberedPos = account.rememberedPos || null;
    this._posWatchTimer = null;
    this._posExcursionHandled = false;
    this._lastExcursionTriggerAt = 0;

    // ── Авто-бал + инвест ─────────────────────────────────────────────────────
    this.autoBal = {
      active: false,
      interval: account.autoBal?.interval || 60000,
    }; // interval в мс
    this._autoBalTimer = null;
    this._balListening = false; // слушаем ли сейчас ответ /bal

    // ── Авто-хил ─────────────────────────────────────────────────────────────
    this.autoHeal = { active: false };
    this._autoHealTimer = null;

    // ── Авто-payday (/payday take → /rubpay {target} {amount}, раз в N часов) ──
    this.autoPayday = {
      active: false,
      intervalHours: account.autoPayday?.intervalHours || getSettings().autoPaydayIntervalHours || 4,
    };
    this._autoPaydayWasActive = account.autoPayday?.active === true;
    this._autoPaydayTimer = null;
  }

  emit(event, data) {
    this.io.emit(`bot:${this.id}:${event}`, data);
  }

  // Переносит текущее состояние автоматизаций на account (то, что реально
  // пишется в accounts.json через saveAccounts()) и просит сервер сохранить.
  _syncPersist() {
    this.account.autoReconnect = this.autoReconnect;
    this.account.macroLoop = { text: this.macroLoop.text, delay: this.macroLoop.delay, active: this.macroLoop.active };
    this.account.clicker  = { button: this.clicker.button, delay: this.clicker.delay, active: this.clicker.active };
    this.account.chatLoop = { text: this.chatLoop.text, delay: this.chatLoop.delay, active: this.chatLoop.active };
    this.account.autoBal  = { interval: this.autoBal.interval, active: this.autoBal.active };
    this.account.autoHeal = { active: this.autoHeal.active };
    this.account.autoPayday = { intervalHours: this.autoPayday.intervalHours, active: this.autoPayday.active };
    this.account.chatScanner = { ...this.chatScanner };
    this.account.autoFish = { active: this.autoFish.active };
    this.account.autoShop = {
      openCmd: this.autoShop.openCmd, slots: this.autoShop.slots, button: this.autoShop.button,
      delay: this.autoShop.delay, cycleDelay: this.autoShop.cycleDelay, active: this.autoShop.active,
    };
    this.account.autoBoneMeal = { lookYaw: this.autoBoneMeal.lookYaw, lookPitch: this.autoBoneMeal.lookPitch, active: this.autoBoneMeal.active };
    this._persist();
  }

  log(msg, type = 'info') {
    const entry = { ts: Date.now(), msg, type };
    // В chatLog храним только реальные сообщения чата (type='chat')
    // Служебные логи (info/warn/success/error) не засоряют историю
    if (type === 'chat') {
      this.chatLog.push(entry);
      if (this.chatLog.length > 300) this.chatLog.shift();
    }
    this.emit('log', entry);
    if (type === 'error' || type === 'warn') {
      console.log(`[Бот ${this.account.username}] [${type.toUpperCase()}] ${msg}`);
    }
  }

  setStatus(s) {
    this.status = s;
    this.io.emit('bot:status', { id: this.id, status: s });
  }

  async connect(server) {
    if (this.bot) await this.disconnect();
    this._manualDisconnect = false;
    this.server = server; // { host, port, version }
    this.account.lastServer = { host: server.host, port: server.port, version: server.version };
    this._persist();
    this.setStatus('connecting');
    this.log(`[Diag] Инициализация подключения к ${server.host}:${server.port}...`);

    try {
      const opts = {
        host: server.host,
        port: parseInt(server.port) || 25565,
        username: this.account.username,
        version: server.version || '1.16.5',
        hideErrors: false,
        checkTimeoutInterval: 60000,
        connectTimeout: 30000,
      };

      if (this.account.authType === 'microsoft') {
        opts.auth = 'microsoft';
      } else if (this.account.authType === 'mojang') {
        opts.auth = 'mojang';
        opts.password = this.account.password;
      } else {
        opts.auth = 'offline';
      }

      if (this.account.proxy && this.account.proxy.host) {
        this.log(`[Прокси] Шаг 1: Запрос туннеля через прокси-сервер ${this.account.proxy.host}:${this.account.proxy.port}...`);
        try {
          dns.lookup(server.host, (dnsErr, resolvedIp) => {
            if (!dnsErr) this.log(`[Diag] ${server.host} резолвится (локально, у тебя на машине) в IP: ${resolvedIp}. Прокси может резолвить домен иначе на своей стороне и получить другой IP.`);
          });

          const stream = await createProxyStream(
            this.account.proxy,
            server.host,
            parseInt(server.port) || 25565
          );

          // ХАК: Маскируем readyState сокета под 'opening'.
          // Это заставит Mineflayer не генерировать событие 'connect' мгновенно,
          // давая время загрузиться всем плагинам пакетов (Handshake, Login и т.д.)
          let fakeReadyState = 'opening';
          Object.defineProperty(stream, 'readyState', {
            get() { return fakeReadyState; },
            configurable: true
          });

          opts.stream = stream;
          this.log(`[Прокси] Шаг 2: Туннель к ${server.host}:${server.port} успешно открыт. Передаём поток в Mineflayer.`, 'success');

          this.log(`[Diag] Передача конфигурации в mineflayer.createBot(). Ожидание сокета...`);
          this.bot = mineflayer.createBot(opts);

          // Как только экземпляр собран, возвращаем статус сокета в 'open'
          // и принудительно вызываем событие 'connect', чтобы все плагины отработали синхронно
          fakeReadyState = 'open';
          stream.emit('connect');

          this._bindEvents();
        } catch (e) {
          this.log(`[Прокси] КРИТИЧЕСКИЙ СБОЙ: Не удалось открыть прокси-поток. Ошибка: ${e.message}`, 'error');
          if (e.stack) console.error(e.stack);
          this.setStatus('error');
          return;
        }
      } else {
        this.log(`[Сеть] Подключение выполняется напрямую (без прокси).`);
        this.bot = mineflayer.createBot(opts);
        this._bindEvents();
      }

    } catch (e) {
      this.log(`[Diag] Исключение при сборке инстанса бота: ${e.message}`, 'error');
      this.setStatus('error');
    }
  }

  _bindEvents() {
    const b = this.bot;

    if (b._client) {
      b._client.once('connect', () => {
        const usage = this.account.proxy && this.account.proxy.host ? 'через прокси' : 'напрямую';
        this.log(`[Сетевой сокет] Успешно соединён с удалённым узлом (${usage}). Ожидание пакетов авторизации...`, 'success');
      });
    }

    b.on('message', (msg, position) => {
      // position: 'chat' | 'system' | 'game_info' (actionbar) | 'say_command' | 'team_msg' | ...
      // 'game_info' — это actionbar ("Ваша территория" и т.п.) — не показываем в чате
      if (position === 'game_info') return;
      const text = msg.toAnsi ? msg.toAnsi() : msg.toString();
      this.log(text, 'chat');

      // ── Авто-бал: парсим ответ на /bal ────────────────────────────────────
      if (this._balListening) {
        const raw = msg.toString().replace(/[\x1b][^m]*m/g, '').replace(/,/g, '');
        const match = raw.match(/(?:balance|баланс|монет|coins?|\$)[^\d]*(\d+(?:\.\d+)?)/i)
                   || raw.match(/(\d+(?:\.\d+)?)\s*(?:монет|coins?|\$)/i)
                   || raw.match(/[^\d](\d{4,})/); // fallback: первое число ≥4 цифр
        if (match) {
          const amount = Math.floor(parseFloat(match[1]));
          if (amount > 0) {
            const investCmd = getSettings().autoBalInvestCommand.replace('{amount}', amount);
            this.log(`[Авто-бал] Найдено ${amount} монет → ${investCmd}`, 'info');
            setTimeout(() => {
              try { this.bot?.chat(investCmd); } catch {}
            }, 800);
          }
          this._balListening = false;
        }
      }

      // ── Авто-логин/регистрация (AuthMe и т.п.) ──────────────────────────────
      if (this.authConfig?.enabled && this.account.password) {
        const now = Date.now();
        const throttleOk = !this._lastAutoLoginAt || now - this._lastAutoLoginAt > 5000;
        const attemptsLeft = (this._authAttempts || 0) < 3;
        if (throttleOk && attemptsLeft) {
          let template = null;
          let kind = null;
          try {
            if (new RegExp(this.authConfig.registerPattern, 'i').test(text)) {
              template = this.authConfig.registerCommand;
              kind = 'регистрация';
            } else if (new RegExp(this.authConfig.loginPattern, 'i').test(text)) {
              template = this.authConfig.loginCommand;
              kind = 'вход';
            }
          } catch (e) {
            this.log(`[Авто-вход] Ошибка в regex-паттерне авторизации: ${e.message}`, 'error');
          }
          if (template) {
            this._lastAutoLoginAt = now;
            this._authAttempts = (this._authAttempts || 0) + 1;
            const extractedCmd = text.match(/\/[a-zA-Zа-яёА-ЯЁ_-]+/)?.[0];
            const cmd = extractedCmd
              ? (kind === 'регистрация'
                  ? `${extractedCmd} ${this.account.password} ${this.account.password}`
                  : `${extractedCmd} ${this.account.password}`)
              : template.replace(/\{password\}/g, this.account.password);
            this.log(`[Авто-вход] Обнаружен запрос (${kind}), попытка ${this._authAttempts}/3 → отправляю "${cmd.replace(this.account.password, '***')}"${extractedCmd ? ' (команда взята из подсказки сервера)' : ''}`, 'success');
            setTimeout(() => { try { this.bot?.chat(cmd); } catch {} }, 1500);
          }
        } else if (throttleOk && !attemptsLeft) {
          this.log('[Авто-вход] Превышен лимит попыток (3) — проверь пароль в настройках аккаунта.', 'error');
        }
      }
    });

    b.on('spawn', () => {
      this.setStatus('online');
      this.log('Заспавнился на сервере. Авторизация протокола завершена.', 'success');
      this._reconnectAttempts = 0;
      this._loggedIn = false;
      this._lastAutoLoginAt = 0;
      this._authAttempts = 0;
      if (this.authConfig?.enabled && this.account.password) {
        this.log(`[Авто-вход] Готов: пароль задан, жду от сервера запрос на /register или /login...`);
      } else if (!this.account.password) {
        this.log('[Авто-вход] Пароль не задан в настройках аккаунта — авто-логин не сработает.', 'warn');
      } else {
        this.log('[Авто-вход] Выключен в настройках этого аккаунта.', 'warn');
      }
      this._posExcursionHandled = false;
      this._lastExcursionTriggerAt = 0;
      if (this.rememberedPos) this._startPosWatch();
      this._startHud();
      this._bindInventory();

      if (this.recoveryTriggers?.onReconnect) {
        this.runRecoverySequence('переподключение').then(() => {
          this._restoreClickerIfNeeded();
          this._restoreAutoBalIfNeeded();
          this._restoreAutoHealIfNeeded();
          this._restoreAutoFishIfNeeded();
          this._restoreAutoShopIfNeeded();
          this._restoreAutoBoneMealIfNeeded();
          this._restoreChatScannerIfNeeded();
          this._restoreChatLoopIfNeeded();
          this._restoreMacroLoopIfNeeded();
          this._restoreAutoPaydayIfNeeded();
        });
      } else {
        setTimeout(() => {
          this._restoreClickerIfNeeded();
          this._restoreAutoBalIfNeeded();
          this._restoreAutoHealIfNeeded();
          this._restoreAutoFishIfNeeded();
          this._restoreAutoShopIfNeeded();
          this._restoreAutoBoneMealIfNeeded();
          this._restoreChatScannerIfNeeded();
          this._restoreChatLoopIfNeeded();
          this._restoreMacroLoopIfNeeded();
          this._restoreAutoPaydayIfNeeded();
        }, 3000);
      }
    });

    b.on('respawn', () => {
      const dim = this.bot?.game?.dimension ?? 'неизвестно';
      const dimName = dim === 'minecraft:overworld' ? '🌍 Верхний мир'
                    : dim === 'minecraft:the_nether' ? '🔥 Незер'
                    : dim === 'minecraft:the_end'    ? '🌑 Край'
                    : dim === 'overworld'             ? '🌍 Верхний мир'
                    : dim === 'nether'                ? '🔥 Незер'
                    : dim === 'end'                   ? '🌑 Край'
                    : `📍 ${dim}`;
      const msg = `Сменил мир → ${dimName}`;
      this.log(msg, 'info');
      this.emit('worldChange', { dimension: dim, label: dimName, username: this.account.username });
      if (this.recoveryTriggers?.onRespawn) this.runRecoverySequence('смерть/смена мира');
    });

    b.on('death', () => {
      this.log('Умер — ожидаем респавна', 'warn');
      setTimeout(() => { try { b.respawn(); } catch {} }, 1000);
    });

    b.on('health', () => {
      this.hud.health = b.health;
      this.hud.food = b.food;
      this.emit('hud', this.hud);
    });

    b.on('end', (reason) => {
      const isProxy = this.account.proxy && this.account.proxy.host ? `Прокси: ${this.account.proxy.host}` : 'Без прокси';
      this.log(`[Сессия закрыта] Соединение разорвано со стороны сервера (${isProxy}). Причина: ${reason || 'не указана'}`, 'warn');
      this._cleanup();
      this.setStatus('offline');
      this._scheduleReconnect();
    });

    b.on('error', (err) => {
      const isProxy = this.account.proxy && this.account.proxy.host ? `Прокси: ${this.account.proxy.host}` : 'Без прокси';
      this.log(`[Сетевой сбой] Ошибка протокола (${isProxy}): ${err.message}`, 'error');
      if (err.code) {
        this.log(`[Сетевой сбой] Системный код ошибки сокета: ${err.code}`, 'error');
      }
      this.setStatus('offline');
      this._scheduleReconnect();
    });

    b.on('kicked', (reason) => {
      this.log(`[Кикнут сервером] Причина: ${reason}`, 'error');
    });
  }

  _startHud() {
    this._stopHud();
    this._hudTimer = setInterval(() => {
      if (!this.bot?.entity) return;
      const pos = this.bot.entity.position;
      this.hud = {
        health: Math.round(this.bot.health || 0),
        food: Math.round(this.bot.food || 0),
        x: Math.round(pos.x),
        y: Math.round(pos.y),
        z: Math.round(pos.z),
        yaw: (this.bot.entity.yaw * 180 / Math.PI).toFixed(1),
        pitch: (this.bot.entity.pitch * 180 / Math.PI).toFixed(1),
        ping: this.bot._client?.latency || 0,
      };
      this.emit('hud', this.hud);
    }, 500);
  }

  _stopHud() {
    if (this._hudTimer) { clearInterval(this._hudTimer); this._hudTimer = null; }
  }

  _serializeSlots(slots) {
    return (slots || []).map((item, i) => item ? {
      slot: item.slot != null ? item.slot : i,
      type: item.type,
      name: item.name,
      displayName: item.displayName,
      count: item.count,
      durabilityUsed: item.durabilityUsed || 0,
      maxDurability: item.maxDurability || 0,
      enchants: (item.enchants || []).map(e => e.name),
      lore: this._extractLore(item),
    } : null);
  }

  // Строки Lore в NBT — это каждая отдельный JSON-компонент чата (или обычная
  // строка в старых версиях), парсим/красим их уже на клиенте, тут просто отдаём как есть.
  _extractLore(item) {
    try {
      const loreTag = item.nbt?.value?.display?.value?.Lore?.value?.value;
      if (Array.isArray(loreTag)) return loreTag.slice(0, 20);
    } catch {}
    return [];
  }

  _bindInventory() {
    const b = this.bot;
    if (!b || !b.inventory) return;

    this._emitInventory();
    b.inventory.on('updateSlot', () => this._queueEmitInventory());

    b.on('windowOpen', (window) => {
      this.window = window;
      this._emitWindow('open');
      window.on('updateSlot', () => this._queueEmitWindow());
    });

    b.on('windowClose', () => {
      this.window = null;
      this.emit('window:close', {});
    });
  }

  _queueEmitInventory() {
    if (this._invUpdateTimer) return;
    this._invUpdateTimer = setTimeout(() => {
      this._invUpdateTimer = null;
      this._emitInventory();
    }, 60);
  }
  _queueEmitWindow() {
    if (this._winUpdateTimer) return;
    this._winUpdateTimer = setTimeout(() => {
      this._winUpdateTimer = null;
      this._emitWindow('update');
    }, 60);
  }

  _emitInventory() {
    if (!this.bot?.inventory) return;
    this.inventory = this._serializeSlots(this.bot.inventory.slots);
    this.emit('inventory', { slots: this.inventory, selected: this.bot.quickBarSlot ?? 0 });
  }

  _windowSnapshot() {
    const w = this.window;
    if (!w) return null;
    let title = w.type || 'Меню';
    try {
      if (typeof w.title === 'string' && w.title) title = w.title;
      else if (w.title && typeof w.title.toString === 'function') title = w.title.toString();
    } catch {}
    return {
      id: w.id,
      title,
      type: w.type,
      inventoryStart: w.inventoryStart,
      slotCount: w.slots.length,
      slots: this._serializeSlots(w.slots),
    };
  }

  _emitWindow(kind) {
    const snap = this._windowSnapshot();
    if (!snap) return;
    this.emit(kind === 'open' ? 'window:open' : 'window:update', snap);
  }

  async clickSlot(slot, button = 0, mode = 0, timeoutMs = 5000) {
    if (!this.bot) return;
    const needsWindow = parseInt(slot) < 36;
    if (needsWindow && !this.window) {
      const opened = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 3000);
        this.bot.once('windowOpen', () => { clearTimeout(timer); resolve(true); });
      });
      if (!opened) {
        this.log(`Клик по слоту ${slot} пропущен: окно не открылось за 3с`, 'warn');
        return;
      }
    }
    try {
      await Promise.race([
        this.bot.clickWindow(parseInt(slot), parseInt(button) || 0, parseInt(mode) || 0),
        new Promise((_, reject) => setTimeout(() => reject(new Error('clickWindow timeout')), timeoutMs)),
      ]);
    } catch (e) {
      this.log(`Клик по слоту ${slot} пропущен: ${e.message}`, 'warn');
    }
  }

  async moveItem(from, to) {
    if (!this.bot || from == null || to == null || from === to) return;
    const clickWithTimeout = (slot) => Promise.race([
      this.bot.clickWindow(parseInt(slot), 0, 0),
      new Promise((_, reject) => setTimeout(() => reject(new Error('clickWindow timeout')), 5000)),
    ]);
    try {
      await clickWithTimeout(from);
      await clickWithTimeout(to);
    } catch (e) { this.log(`Ошибка перемещения предмета: ${e.message}`, 'warn'); }
  }

  closeWindow() {
    if (!this.bot) return;
    try { if (this.window) this.bot.closeWindow(this.window); } catch {}
    this.window = null;
  }

  _cleanup() {
    this._stopHud();
    this._stopPosWatch();
    // Запоминаем состояния ДО остановки — чтобы после реконнекта восстановить
    this._clickerWasActive  = this.clicker?.active  === true;
    this._autoBalWasActive  = this.autoBal?.active  === true;
    this._autoHealWasActive = this.autoHeal?.active === true;
    this._chatLoopWasActive = this.chatLoop?.active === true;
    this._macroLoopWasActive = this.macroLoop?.active === true;
    this._autoPaydayWasActive = this.autoPayday?.active === true;
    this._autoFishWasActive = this.autoFish?.active === true;
    this._autoShopWasActive = this.autoShop?.active === true;
    this._autoBoneMealWasActive = this.autoBoneMeal?.active === true;
    this.stopMacroLoop();
    this.stopAutoBal();
    this.stopAutoHeal();
    this.stopAutoFish();
    this.stopAutoShop();
    this.stopAutoBoneMeal();
    this._chatScannerWasActive = this.chatScanner?.active === true;
    this.stopChatScanner();
    this.stopClicker();
    this.stopChatLoop();
    this.stopAutoPayday();
    if (this._invUpdateTimer) { clearTimeout(this._invUpdateTimer); this._invUpdateTimer = null; }
    if (this._winUpdateTimer) { clearTimeout(this._winUpdateTimer); this._winUpdateTimer = null; }
    this._holdKeys.forEach(k => {
      try { this.bot?.setControlState(k, false); } catch {}
    });
    this._holdKeys.clear();
    if (this.bot) {
      try { this.bot.removeAllListeners(); } catch {}
      this.bot = null;
    }
    if (this.window) { this.window = null; this.emit('window:close', {}); }
    this.inventory = [];
    this.emit('inventory', { slots: [], selected: 0 });
  }

  async disconnect() {
    this.log('Отключение...');
    this._manualDisconnect = true;
    this._clickerWasActive  = false; // ручное отключение — не восстанавливаем состояния
    this._autoBalWasActive  = false;
    this._autoHealWasActive = false;
    this._chatLoopWasActive = false;
    this._macroLoopWasActive = false;
    this._autoPaydayWasActive = false;
    this._chatScannerWasActive = false;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.bot) {
      try { this.bot.quit('Disconnect'); } catch {}
      this._cleanup();
    }
    this.setStatus('offline');
  }

  // ── УПРАВЛЕНИЕ ──────────────────────────────────────────────────────────────

  chat(text) {
    if (!this.bot || this.status !== 'online') return;
    try { this.bot.chat(text); } catch (e) { this.log(e.message, 'error'); }
  }

  setKey(key, state) {
    if (!this.bot || this.status !== 'online') return;
    const allowed = ['forward','back','left','right','jump','sneak','sprint'];
    if (!allowed.includes(key)) return;
    try {
      this.bot.setControlState(key, state);
      if (state) this._holdKeys.add(key);
      else this._holdKeys.delete(key);
    } catch {}
  }

  look(yaw, pitch) {
    if (!this.bot || this.status !== 'online') return;
    try { this.bot.look(parseFloat(yaw), parseFloat(pitch), false); } catch {}
  }

  attack() {
    if (!this.bot || this.status !== 'online') return;
    try { customLeftClick(this.bot, 4.5); } catch {}
  }

  useItem() {
    if (!this.bot || this.status !== 'online') return;
    try { customActivateItem(this.bot); } catch {}
  }

  stopUseItem() {
    if (!this.bot || this.status !== 'online') return;
    try { customDeactivateItem(this.bot); } catch {}
  }

  selectSlot(slot) {
    if (!this.bot || this.status !== 'online') return;
    try { this.bot.setQuickBarSlot(parseInt(slot)); } catch {}
  }

  jump() {
    if (!this.bot || this.status !== 'online') return;
    try {
      this.bot.setControlState('jump', true);
      setTimeout(() => { try { this.bot?.setControlState('jump', false); } catch {} }, 250);
    } catch {}
  }

  // ── КЛИКЕР (ЛКМ/ПКМ с задержкой, включается и выключается вручную) ─────────
  startClicker(button = 0, delay = 600) {
    this.stopClicker();
    const btn = parseInt(button) === 1 ? 1 : 0;
    const ms = Math.max(15, parseInt(delay) || 600);
    this.clicker = { active: true, button: btn, delay: ms };
    this.log(`[Кликер] Запущен: ${btn === 0 ? 'ЛКМ' : 'ПКМ'}, задержка ${ms}мс`, 'success');
    this._clickerTimer = setInterval(() => {
      if (!this.bot || this.status !== 'online') return;
      try {
        if (btn === 0) {
          customLeftClick(this.bot, 4.5);
        } else {
          try {
            const target = findBlockAtCursor(this.bot, 4.5);
            if (target) {
              customActivateBlock(this.bot, target);
            } else {
              const entity = this.bot.entityAtCursor ? this.bot.entityAtCursor(4.5) : null;
              if (entity) {
                customActivateEntity(this.bot, entity);
              } else {
                customActivateItem(this.bot);
                setTimeout(() => { try { customDeactivateItem(this.bot); } catch {} }, 50);
              }
            }
          } catch {
            try { customActivateItem(this.bot); } catch {}
          }
        }
      } catch {}
    }, ms);
    this.io.emit(`bot:${this.id}:clicker`, this.clicker);
    this._syncPersist();
  }

  stopClicker() {
    if (this._clickerTimer) { clearInterval(this._clickerTimer); this._clickerTimer = null; }
    if (this.clicker?.active) {
      this.clicker = { ...this.clicker, active: false };
      this.log('[Кликер] Остановлен');
      this.io.emit(`bot:${this.id}:clicker`, this.clicker);
      this._syncPersist();
    }
  }

  // ── АВТО-ОТПРАВКА СООБЩЕНИЯ/КОМАНДЫ В ЧАТ ────────────────────────────────
  startChatLoop(text, delay = 5000) {
    this.stopChatLoop();
    const msg = String(text || '').trim();
    if (!msg) { this.log('[Авто-чат] Пустой текст команды — не запущен', 'warn'); return; }
    const ms = Math.max(1000, parseInt(delay) || 5000);
    this.chatLoop = { active: true, text: msg, delay: ms };
    this.log(`[Авто-чат] Запущен: "${msg}", задержка ${ms}мс`, 'success');
    this._chatLoopTimer = setInterval(() => {
      if (!this.bot || this.status !== 'online') return;
      try { this.bot.chat(msg); } catch (e) { this.log(`[Авто-чат] Ошибка отправки: ${e.message}`, 'error'); }
    }, ms);
    this.io.emit(`bot:${this.id}:chatLoop`, this.chatLoop);
    this._syncPersist();
  }

  stopChatLoop() {
    if (this._chatLoopTimer) { clearInterval(this._chatLoopTimer); this._chatLoopTimer = null; }
    if (this.chatLoop?.active) {
      this.chatLoop = { ...this.chatLoop, active: false };
      this.log('[Авто-чат] Остановлен');
      this.io.emit(`bot:${this.id}:chatLoop`, this.chatLoop);
      this._syncPersist();
    }
  }

  // ── Авто-реконнект ──────────────────────────────────────────────────────
  setAutoReconnect(enabled) {
    this.autoReconnect = !!enabled;
    this.log(`[Авто-реконнект] ${this.autoReconnect ? 'Включен' : 'Выключен'}`);
    this.io.emit(`bot:${this.id}:autoReconnect`, this.autoReconnect);
    this._syncPersist();
  }

  _scheduleReconnect() {
    if (!this.autoReconnect || this._manualDisconnect || !this.server) return;
    if (this._reconnectScheduled) return;
    this._reconnectScheduled = true;

    const delays = [5000, 10000, 30000, 60000, 120000];
    const delay = delays[Math.min(this._reconnectAttempts, delays.length - 1)];
    this._reconnectAttempts++;
    this.log(`[Авто-реконнект] Попытка №${this._reconnectAttempts}, следующий заход через ${Math.round(delay / 1000)}с (например, если сервер ушёл на рестарт)...`, 'warn');

    this._reconnectTimer = setTimeout(() => {
      this._reconnectScheduled = false;
      if (!this._manualDisconnect && this.autoReconnect) this.connect(this.server);
    }, delay);
  }

  // ── Настройка макроса восстановления ────────────────────────────────────
  setRecoveryConfig({ onReconnect, onRespawn, sequenceText }) {
    this.recoveryTriggers = { onReconnect: !!onReconnect, onRespawn: !!onRespawn };
    this.recoverySequence = parseRecoverySequence(sequenceText || '');
    this.account.recoveryTriggers = this.recoveryTriggers;
    this.account.recoverySequenceText = sequenceText || '';
    this.log(`[Восстановление] Настроено: ${this.recoverySequence.length} шаг(ов), триггеры: ${
      [this.recoveryTriggers.onReconnect && 'реконнект', this.recoveryTriggers.onRespawn && 'смерть/смена мира'].filter(Boolean).join(', ') || 'нет'
    }`);
  }

  setAuthConfig(cfg) {
    const s = getSettings();
    this.authConfig = {
      enabled: cfg?.enabled !== false,
      registerCommand: cfg?.registerCommand || s.authRegisterCommand,
      loginCommand: cfg?.loginCommand || s.authLoginCommand,
      registerPattern: cfg?.registerPattern || s.authRegisterPattern,
      loginPattern: cfg?.loginPattern || s.authLoginPattern,
    };
    this.account.authConfig = this.authConfig;
    this._persist();
    this.log('[Авто-вход] Настройки авторизации обновлены');
  }

  // ── Ручной выбор прокси из пула (кнопка 🪄 в плашке) ─────────────────────
  // proxy = null, useDirect = false → сбросить на авто-подбор из пула при следующем подключении.
  // proxy = null, useDirect = true  → подключаться со своего реального IP, без прокси вообще.
  setProxy(proxy, useDirect = false) {
    this.account.proxy = proxy && proxy.host ? proxy : null;
    this.account.useDirect = !!useDirect && !this.account.proxy;
    this._persist();
    if (this.account.useDirect) {
      this.log('[Прокси] Выбран режим "свой IP" — подключение без прокси');
    } else if (this.account.proxy) {
      this.log(`[Прокси] Выбран вручную: ${this.account.proxy.host}:${this.account.proxy.port}`);
    } else {
      this.log('[Прокси] Сброшено на авто-подбор из пула');
    }
  }

  rememberCurrentPosition() {
    if (!this.bot?.entity || this.status !== 'online') {
      this.log('[Координаты] Бот не в сети — нечего запоминать.', 'error');
      return null;
    }
    const p = this.bot.entity.position;
    this.rememberedPos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    this.account.rememberedPos = this.rememberedPos;
    this._posExcursionHandled = false;
    this._lastExcursionTriggerAt = 0;
    this.log(`[Координаты] Запомнил позицию: ${this.rememberedPos.x}, ${this.rememberedPos.y}, ${this.rememberedPos.z}`, 'success');
    this._startPosWatch();
    this.io.emit(`bot:${this.id}:rememberedPos`, this.rememberedPos);
    this._persist();
    return this.rememberedPos;
  }

  forgetRememberedPosition() {
    this.rememberedPos = null;
    this.account.rememberedPos = null;
    this._stopPosWatch();
    this.log('[Координаты] Забыл сохранённую позицию — слежение выключено.');
    this.io.emit(`bot:${this.id}:rememberedPos`, null);
    this._persist();
  }

  _startPosWatch() {
    this._stopPosWatch();
    this._posWatchTimer = setInterval(() => this._checkPosition(), 3000);
  }

  _stopPosWatch() {
    if (this._posWatchTimer) { clearInterval(this._posWatchTimer); this._posWatchTimer = null; }
  }

  _checkPosition() {
    if (!this.rememberedPos || !this.bot?.entity || this.status !== 'online') return;
    const p = this.bot.entity.position;
    const dx = p.x - this.rememberedPos.x;
    const dy = p.y - this.rememberedPos.y;
    const dz = p.z - this.rememberedPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const s = getSettings();
    const THRESHOLD = Math.max(1, parseFloat(s.posWatchThreshold) || 15);
    const RETRY_MS = Math.max(5000, (parseFloat(s.posWatchRetrySec) || 30) * 1000);

    if (dist > THRESHOLD) {
      const now = Date.now();
      if (!this._lastExcursionTriggerAt || now - this._lastExcursionTriggerAt >= RETRY_MS) {
        const isRetry = this._posExcursionHandled;
        this._posExcursionHandled = true;
        this._lastExcursionTriggerAt = now;
        this.log(`[Координаты] Позиция изменилась на ${Math.round(dist)} блоков от запомненной — запускаю макрос восстановления${isRetry ? ' (повтор, за 30с не вернулся)' : ''}.`, 'warn');
        this.runRecoverySequence('координаты изменились');
      }
    } else {
      this._posExcursionHandled = false;
      this._lastExcursionTriggerAt = 0;
    }
  }

  async runRecoverySequence(reasonLabel) {
    if (!this.bot || this.status !== 'online') return;
    if (!this.recoverySequence.length) return;
    if (Date.now() - this._lastRecoveryAt < 3000) return;
    this._lastRecoveryAt = Date.now();
    await this._runSteps(this.recoverySequence, reasonLabel);
  }

  // ── Разовый запуск произвольного макроса ────────────────────────────────
  async runMacroText(text) {
    const steps = parseRecoverySequence(text);
    if (!steps.length) {
      this.log('[Макрос] Пустой или нераспознанный текст — проверь синтаксис (chat/wait/click/attack/use/walk/look/jump/sneak/sprint/hold/slot/clicker)', 'warn');
      return;
    }
    await this._runSteps(steps, 'ручной запуск макроса');
  }

  // ── Бесконечный макрос: повторяет весь набор шагов по кругу с паузой между циклами ──
  startMacroLoop(text, delay = 5000) {
    this.stopMacroLoop();
    const steps = parseRecoverySequence(text);
    if (!steps.length) {
      this.log('[Макрос-цикл] Пустой или нераспознанный текст — не запущен', 'warn');
      return;
    }
    const ms = Math.max(1000, parseInt(delay) || 5000);
    this.macroLoop = { active: true, text: String(text || ''), delay: ms };
    this.log(`[Макрос-цикл] Запущен, пауза между циклами ${ms}мс`, 'success');

    const cycle = async () => {
      if (!this.macroLoop.active) return;
      if (!this.bot || this.status !== 'online') return;
      await this._runSteps(parseRecoverySequence(this.macroLoop.text), 'цикл макроса');
    };
    cycle(); // сразу первый проход
    this._macroLoopTimer = setInterval(cycle, ms);
    this.io.emit(`bot:${this.id}:macroLoop`, this.macroLoop);
    this._syncPersist();
  }

  stopMacroLoop() {
    if (this._macroLoopTimer) { clearInterval(this._macroLoopTimer); this._macroLoopTimer = null; }
    if (this.macroLoop?.active) {
      this.macroLoop = { ...this.macroLoop, active: false };
      this.log('[Макрос-цикл] Остановлен');
      this.io.emit(`bot:${this.id}:macroLoop`, this.macroLoop);
      this._syncPersist();
    }
  }

  // Общий исполнитель шагов (используется и recoverySequence, и ручным/циклическим макросом)
  async _runSteps(steps, reasonLabel) {
    if (!this.bot || this.status !== 'online') return;
    if (this._recoveryRunning) {
      this.log('[Макрос] Уже выполняется другой запуск — пропуск', 'warn');
      return;
    }
    this._recoveryRunning = true;
    this.log(`[Макрос] Запуск (${reasonLabel})`, 'success');

    try {
      for (const step of steps) {
        if (!this.bot || this.status !== 'online') break;
        if (reasonLabel === 'цикл макроса' && !this.macroLoop.active) break; // остановили во время выполнения
        switch (step.type) {
          case 'wait':
            await new Promise(r => setTimeout(r, step.ms));
            break;
          case 'chat':
            this.bot.chat(step.text);
            break;
          case 'click':
            if (!this.window) await new Promise(r => setTimeout(r, 500));
            await this.clickSlot(step.slot, step.button, step.mode);
            await new Promise(r => setTimeout(r, 300));
            break;
          case 'attack':
            this.attack();
            break;
          case 'use':
            customActivateItem(this.bot);
            await new Promise(r => setTimeout(r, 60));
            try { customDeactivateItem(this.bot); } catch {}
            break;
          case 'walk':
            try {
              this.bot.setControlState(step.dir, true);
              await new Promise(r => setTimeout(r, step.ms));
            } finally {
              try { this.bot?.setControlState(step.dir, false); } catch {}
            }
            break;
          case 'look':
            this.look(step.yawDeg * Math.PI / 180, step.pitchDeg * Math.PI / 180);
            break;
          case 'jump':
            this.jump();
            await new Promise(r => setTimeout(r, 300));
            break;
          case 'sneak':
            try {
              this.bot.setControlState('sneak', true);
              await new Promise(r => setTimeout(r, step.ms));
            } finally {
              try { this.bot?.setControlState('sneak', false); } catch {}
            }
            break;
          case 'sprint':
            try {
              this.bot.setControlState('sprint', true);
              await new Promise(r => setTimeout(r, step.ms));
            } finally {
              try { this.bot?.setControlState('sprint', false); } catch {}
            }
            break;
          case 'hold':
            if (step.button === 'right') {
              try {
                customActivateItem(this.bot);
                await new Promise(r => setTimeout(r, step.ms));
              } finally {
                try { customDeactivateItem(this.bot); } catch {}
              }
            } else {
              // "Зажать ЛКМ" эмулируем повторными ударами каждые ~180мс, как ручной клик игрока
              const until = Date.now() + step.ms;
              while (Date.now() < until) {
                if (!this.bot || this.status !== 'online') break;
                this.attack();
                await new Promise(r => setTimeout(r, 180));
              }
            }
            break;
          case 'slot':
            this.selectSlot(step.slot);
            break;
          case 'clickerOn':
            this.startClicker(step.button, step.delay);
            break;
          case 'clickerOff':
            this.stopClicker();
            break;

          case 'reconnect':
            this.log('[Макрос] Переподключение...', 'info');
            try { await this.disconnect(); } catch {}
            await new Promise(r => setTimeout(r, 2000));
            if (this.server) await this.connect(this.server);
            return; // прерываем текущий шаговый список — бот уйдёт в реконнект

          case 'disconnect':
            this.log('[Макрос] Отключение...', 'info');
            try { await this.disconnect(); } catch {}
            return;

          case 'connect': {
            const srv = step.host
              ? { host: step.host, port: step.port, version: step.version || this.server?.version || '1.16.5' }
              : this.server;
            if (!srv) { this.log('[Макрос] connect: сервер не задан', 'warn'); break; }
            this.log(`[Макрос] Подключение к ${srv.host}:${srv.port}...`, 'info');
            try { await this.disconnect(); } catch {}
            await new Promise(r => setTimeout(r, 1500));
            await this.connect(srv);
            return;
          }
        }
      }
      this.log('[Макрос] Проход завершён');
    } catch (e) {
      this.log(`[Макрос] Ошибка выполнения: ${e.message}`, 'error');
    } finally {
      this._recoveryRunning = false;
    }
  }

  // ── Восстановление после реконнекта ──────────────────────────────────────
  _restoreClickerIfNeeded() {
    if (!this._clickerWasActive) return;
    if (!this.bot || this.status !== 'online') return;
    this._clickerWasActive = false;
    const { button, delay } = this.clicker;
    this.log(`[Кликер] Автовосстановление после реконнекта: ${button === 0 ? 'ЛКМ' : 'ПКМ'}, задержка ${delay}мс`, 'success');
    this.startClicker(button, delay);
  }

  _restoreAutoBalIfNeeded() {
    if (!this._autoBalWasActive) return;
    if (!this.bot || this.status !== 'online') return;
    this._autoBalWasActive = false;
    const intervalSec = Math.round((this.autoBal?.interval || 60000) / 1000);
    this.log(`[Авто-бал] Автовосстановление после реконнекта (каждые ${intervalSec}с)`, 'success');
    this.startAutoBal(intervalSec);
  }

  _restoreAutoHealIfNeeded() {
    if (!this._autoHealWasActive) return;
    if (!this.bot || this.status !== 'online') return;
    this._autoHealWasActive = false;
    this.log('[Авто-хил] Автовосстановление после реконнекта', 'success');
    this.startAutoHeal();
  }

  _restoreChatLoopIfNeeded() {
    if (!this._chatLoopWasActive) return;
    if (!this.bot || this.status !== 'online') return;
    this._chatLoopWasActive = false;
    const { text, delay } = this.chatLoop;
    if (!text) return;
    this.log(`[Авто-чат] Автовосстановление после реконнекта: "${text}", задержка ${delay}мс`, 'success');
    this.startChatLoop(text, delay);
  }

  _restoreMacroLoopIfNeeded() {
    if (!this._macroLoopWasActive) return;
    if (!this.bot || this.status !== 'online') return;
    this._macroLoopWasActive = false;
    const { text, delay } = this.macroLoop;
    if (!text) return;
    this.log(`[Макрос-цикл] Автовосстановление после реконнекта, пауза ${delay}мс`, 'success');
    this.startMacroLoop(text, delay);
  }

  _restoreAutoPaydayIfNeeded() {
    if (!this._autoPaydayWasActive) return;
    if (!this.bot || this.status !== 'online') return;
    this._autoPaydayWasActive = false;
    const hours = this.autoPayday?.intervalHours || getSettings().autoPaydayIntervalHours || 4;
    this.log(`[Авто-payday] Автовосстановление после реконнекта (каждые ${hours}ч)`, 'success');
    this.startAutoPayday(hours);
  }

  // ── АВТО-БАЛ + ИНВЕСТ ────────────────────────────────────────────────────
  startAutoBal(intervalSec) {
    this.stopAutoBal();
    const s = getSettings();
    const ms = Math.max(10000, (parseInt(intervalSec) || s.autoBalIntervalSec || 60) * 1000);
    this.autoBal = { active: true, interval: ms };
    this.log(`[Авто-бал] Запущен: ${s.autoBalCommand} каждые ${Math.round(ms/1000)}с, монеты → ${s.autoBalInvestCommand.replace('{amount}', 'N')}`, 'success');
    const tick = () => {
      if (!this.bot || this.status !== 'online') return;
      this._balListening = true;
      try { this.bot.chat(getSettings().autoBalCommand); } catch {}
      setTimeout(() => { this._balListening = false; }, 10000);
    };
    tick();
    this._autoBalTimer = setInterval(tick, ms);
    this.io.emit(`bot:${this.id}:autoBal`, this.autoBal);
    this._syncPersist();
  }

  stopAutoBal() {
    if (this._autoBalTimer) { clearInterval(this._autoBalTimer); this._autoBalTimer = null; }
    this._balListening = false;
    if (this.autoBal?.active) {
      this.autoBal = { ...this.autoBal, active: false };
      this.log('[Авто-бал] Остановлен');
      this.io.emit(`bot:${this.id}:autoBal`, this.autoBal);
      this._syncPersist();
    }
  }

  // ── АВТО-ХИЛ ──────────────────────────────────────────────────────────────
  startAutoHeal() {
    this.stopAutoHeal();
    const s = getSettings();
    this.autoHeal = { active: true };
    const intervalMs = Math.max(10000, (parseInt(s.autoHealIntervalSec) || 120) * 1000);
    this.log(`[Авто-хил] Запущен: ${s.autoHealCommand} каждые ${Math.round(intervalMs/60000)} мин`, 'success');
    const tick = () => {
      if (!this.bot || this.status !== 'online') return;
      try { this.bot.chat(getSettings().autoHealCommand); } catch {}
    };
    tick();
    this._autoHealTimer = setInterval(tick, intervalMs);
    this.io.emit(`bot:${this.id}:autoHeal`, this.autoHeal);
    this._syncPersist();
  }

  stopAutoHeal() {
    if (this._autoHealTimer) { clearInterval(this._autoHealTimer); this._autoHealTimer = null; }
    if (this.autoHeal?.active) {
      this.autoHeal = { ...this.autoHeal, active: false };
      this.log('[Авто-хил] Остановлен');
      this.io.emit(`bot:${this.id}:autoHeal`, this.autoHeal);
      this._syncPersist();
    }
  }

  // ── АВТО-PAYDAY ───────────────────────────────────────────────────────────
  startAutoPayday(intervalHours) {
    this.stopAutoPayday();
    const s = getSettings();
    const hours = parseFloat(intervalHours) || s.autoPaydayIntervalHours || 4;
    const ms = Math.max(60000, hours * 3600000);
    this.autoPayday = { active: true, intervalHours: hours };
    const payPreview = s.autoPaydayPayCommand.replace('{target}', s.autoPaydayTarget).replace('{amount}', s.autoPaydayAmount);
    this.log(`[Авто-payday] Запущен: "${s.autoPaydayCommand}" → "${payPreview}", каждые ${hours}ч`, 'success');
    const tick = () => {
      if (!this.bot || this.status !== 'online') return;
      const st = getSettings();
      try { this.bot.chat(st.autoPaydayCommand); } catch (e) { this.log(`[Авто-payday] Ошибка отправки: ${e.message}`, 'error'); }
      setTimeout(() => {
        if (!this.bot || this.status !== 'online') return;
        const cmd = st.autoPaydayPayCommand.replace('{target}', st.autoPaydayTarget).replace('{amount}', st.autoPaydayAmount);
        try { this.bot.chat(cmd); } catch (e) { this.log(`[Авто-payday] Ошибка отправки: ${e.message}`, 'error'); }
      }, 1500);
    };
    tick();
    this._autoPaydayTimer = setInterval(tick, ms);
    this.io.emit(`bot:${this.id}:autoPayday`, this.autoPayday);
    this._syncPersist();
  }

  stopAutoPayday() {
    if (this._autoPaydayTimer) { clearInterval(this._autoPaydayTimer); this._autoPaydayTimer = null; }
    if (this.autoPayday?.active) {
      this.autoPayday = { ...this.autoPayday, active: false };
      this.log('[Авто-payday] Остановлен');
      this.io.emit(`bot:${this.id}:autoPayday`, this.autoPayday);
      this._syncPersist();
    }
  }

  // ── АВТОРЫБАЛКА ──────────────────────────────────────────────────────────────
  // Принцип: держим удочку в руке (ПКМ закидываем), ждём поклёвки (bobber_entity
  // начинает дёргаться / уходит вниз), вытаскиваем (ПКМ ещё раз).
  // Детектим поклёвку через пакет entity_velocity — у бобера резкое ускорение вниз.
  startAutoFish() {
    this.stopAutoFish();
    this.stopAutoShop();
    this.autoFish = { active: true };
    this.log('[Авторыбалка] Запущена — закидываю удочку', 'success');
    this._fishCast(); // первый заброс
    this.io.emit(`bot:${this.id}:autoFish`, this.autoFish);
    this._syncPersist();
  }

  _fishCast() {
    if (!this.bot || this.status !== 'online' || !this.autoFish?.active) return;
    try {
      // Убираем старый слушатель если был
      if (typeof this._onFishBite === 'function') {
        this.bot.off('entityVelocity', this._onFishBite);
      }
      this._onFishBite = null;

      // ПКМ — закидываем удочку
      customActivateItem(this.bot);

      // Ждём немного чтобы поплавок заспавнился, потом начинаем следить
      setTimeout(() => {
        if (!this.bot || !this.autoFish?.active) return;
        // Находим поплавок (fishing_bobber / FishingHook)
        this._fishBobberEntityId = null;
        for (const ent of Object.values(this.bot.entities || {})) {
          if (ent && (ent.name === 'fishing_bobber' || ent.objectType === 'FishingHook')) {
            if (!ent.owner || ent.owner === this.bot.entity) {
              this._fishBobberEntityId = ent.id;
              break;
            }
          }
        }

        // Слушаем два события:
        // 1. entityVelocity — поплавок дёргается вниз (vy < -0.15)
        // 2. entityGone — поплавок исчез (рыба поймана, либо леска порвалась)
        this._onFishBite = (entity) => {
          if (!this.autoFish?.active) return;
          if (!this._fishBobberEntityId) return;
          if (entity.id !== this._fishBobberEntityId) return;
          const vy = entity.velocity?.y ?? entity.vel?.y ?? 0;
          if (vy < -0.15) {
            this.log('[Авторыбалка] Поклёвка! Вытаскиваю...', 'success');
            if (typeof this._onFishBite === 'function') {
              this.bot.off('entityVelocity', this._onFishBite);
            }
            this._onFishBite = null;
            clearTimeout(this._fishTimer);
            // ПКМ — вытаскиваем
            customActivateItem(this.bot);
            setTimeout(() => { if (this.autoFish?.active) this._fishCast(); }, 1200);
          }
        };
        if (typeof this._onFishBite === 'function') {
          this.bot.on('entityVelocity', this._onFishBite);
        }

        // Таймаут: если 30 сек нет поклёвки — перезабрасываем (порвалась леска и т.д.)
        clearTimeout(this._fishTimer);
        this._fishTimer = setTimeout(() => {
          if (!this.autoFish?.active) return;
          this.bot?.off('entityVelocity', this._onFishBite);
          this.log('[Авторыбалка] Таймаут, перезабрасываю...', 'info');
          this._fishCast();
        }, 30000);
      }, 1500);
    } catch (e) {
      this.log(`[Авторыбалка] Ошибка: ${e.message}`, 'error');
    }
  }

  stopAutoFish() {
    clearTimeout(this._fishTimer);
    this._fishTimer = null;
    if (this.bot && typeof this._onFishBite === 'function') {
      this.bot.off('entityVelocity', this._onFishBite);
    }
    this._onFishBite = null;
    this._fishBobberEntityId = null;
    if (this.autoFish?.active) {
      this.autoFish = { active: false };
      this.log('[Авторыбалка] Остановлена');
      this.io.emit(`bot:${this.id}:autoFish`, this.autoFish);
      this._syncPersist();
    }
  }

  _restoreAutoFishIfNeeded() {
    if (!this._autoFishWasActive) return;
    this._autoFishWasActive = false;
    setTimeout(() => { if (this.status === 'online') this.startAutoFish(); }, 3000);
  }

  _restoreAutoShopIfNeeded() {
    if (!this._autoShopWasActive) return;
    this._autoShopWasActive = false;
    setTimeout(() => {
      if (this.status === 'online' && this.autoShop) this.startAutoShop(this.autoShop);
    }, 3000);
  }

  _restoreAutoBoneMealIfNeeded() {
    if (!this._autoBoneMealWasActive) return;
    this._autoBoneMealWasActive = false;
    setTimeout(() => {
      if (this.status === 'online' && this.autoBoneMeal) this.startAutoBoneMeal(this.autoBoneMeal);
    }, 3000);
  }

  // ── СКАНЕР ЧАТА ───────────────────────────────────────────────────────────────
  // Следит за сообщениями чата. Если сообщение совпадает с паттерном (regex или substring)
  // и содержит НЕ-whitelisted ник — выполняет action-команду.
  // Пример: /near пишет "babulkabetmen 5m" — action: chat:/clan someoneIsNear: {name}
  startChatScanner(config) {
    this.stopChatScanner();
    this.chatScanner = { active: true, ...config };

    const nearSec = parseFloat(config.nearInterval) || 0;
    const customPattern = (config.pattern || '').trim();

    this.log(`[Сканер чата] Запущен${nearSec > 0 ? ` | /near каждые ${nearSec}с` : ''} | паттерн: ${customPattern || 'авто (несколько распространённых форматов)'}`, 'success');

    // Таймер для периодической отправки /near. Помечаем окно ожидания ответа —
    // если ни один паттерн не совпадёт с пришедшей в этом окне строкой, покажем
    // её в логе как есть, чтобы можно было скопировать в тестер паттерна на сайте.
    if (nearSec > 0) {
      const sendNear = () => {
        if (!this.bot || this.status !== 'online' || !this.chatScanner?.active) return;
        this._chatScannerAwaitingNearUntil = Date.now() + 4000;
        try { this.bot.chat('/near'); } catch {}
      };
      sendNear(); // сразу первый раз
      this._chatScannerNearTimer = setInterval(sendNear, nearSec * 1000);
    }

    this._chatScannerListener = async (msg) => {
      if (!this.chatScanner?.active) return;

      // Убираем цветовые коды Minecraft (§X)
      const raw   = msg.toString();
      const clean = raw.replace(/§[0-9a-fk-or]/gi, '').trim();
      if (!clean) return;

      const foundAll = extractAllNearMatches(clean, customPattern);

      if (!foundAll.length) {
        // Не распознали строку. Если это, вероятно, ответ на только что
        // отправленный /near (есть цифра, и мы в окне ожидания) — покажем её
        // в логе как подсказку, чтобы было что вставить в тестер паттерна.
        if (this._chatScannerAwaitingNearUntil && Date.now() < this._chatScannerAwaitingNearUntil && /\d/.test(clean)) {
          this._chatScannerAwaitingNearUntil = 0; // одного раза достаточно
          this.log(`[Сканер чата] ❓ Строка не распознана (вставь в «Проверка паттерна» на сайте): "${clean}"`, 'warn');
        }
        return;
      }

      // Вайтлист — игнорируем своих ботов и разрешённые ники.
      // ВАЖНО: раньше при нескольких игроках на /near обрабатывался только ПЕРВЫЙ
      // найденный (даже если он в вайтлисте — остальные тоже не срабатывали).
      // Теперь каждый найденный ник проверяется и обрабатывается отдельно.
      const whitelist = (this.chatScanner.whitelist || []).map(n => n.toLowerCase().trim()).filter(Boolean);
      whitelist.push((this.account.username || '').toLowerCase()); // игнорируем себя

      for (const { name: capturedName, dist: capturedDist } of foundAll) {
        const nameLower = capturedName.toLowerCase();
        if (whitelist.some(w => w && nameLower === w)) continue;

        const action = (this.chatScanner.action || '')
          .replace(/\{name\}/g, capturedName)
          .replace(/\{dist\}/g, capturedDist)
          .replace(/\{msg\}/g,  clean);

        if (!action) continue;

        this.log(`[Сканер чата] ⚠ ${capturedName}${capturedDist ? ` в ${capturedDist} блоках` : ''} → ${action}`, 'warn');
        // Ждём каждый запуск по очереди — у _runSteps есть защита от параллельного
        // выполнения, без await второй/третий найденный ник молча бы пропускался.
        try { await this._runSteps(parseRecoverySequence(action), 'сканер чата'); } catch {}
      }
    };

    this.bot?.on('message', this._chatScannerListener);
    this.io.emit(`bot:${this.id}:chatScanner`, this.chatScanner);
    this._syncPersist();
  }

  stopChatScanner() {
    clearInterval(this._chatScannerNearTimer);
    this._chatScannerNearTimer = null;
    this._chatScannerAwaitingNearUntil = 0;
    if (this._chatScannerListener && this.bot) {
      this.bot.off('message', this._chatScannerListener);
    }
    this._chatScannerListener = null;
    if (this.chatScanner?.active) {
      this.chatScanner = { ...this.chatScanner, active: false };
      this.log('[Сканер чата] Остановлен');
      this.io.emit(`bot:${this.id}:chatScanner`, this.chatScanner);
      this._syncPersist();
    }
  }

  _restoreChatScannerIfNeeded() {
    if (!this._chatScannerWasActive) return;
    this._chatScannerWasActive = false;
    setTimeout(() => {
      if (this.status === 'online' && this.chatScanner) {
        this.startChatScanner(this.chatScanner);
      }
    }, 3000);
  }

  // ── АВТОСКУПЩИК ─────────────────────────────────────────────────────────────
  // 1. Шлёт команду открытия меню (один раз)
  // 2. Ждёт 1.5с чтобы меню открылось
  // 3. Циклически кликает по указанным слотам одной кнопкой (лкм/пкм)
  //    с заданной задержкой между кликами и паузой между циклами
startAutoShop(config = {}) {
    this.stopAutoShop();

    const button = parseInt(config.button) === 1 ? 1 : 0;
    const slots = String(config.slots ?? '')
      .split(',')
      .map(s => parseInt(s.trim()))
      .filter(n => Number.isInteger(n) && n >= 0);

    this.autoShop = {
      active:     true,
      openCmd:    config.openCmd    ?? '',
      slots:      config.slots      ?? '',
      button,
      delay:      Math.max(0, parseInt(config.delay) || 0),
      cycleDelay: Math.max(0, parseInt(config.cycleDelay) || 0),
    };

    if (!slots.length) {
      this.log('[Автоскупщик] Нет слотов — укажи слоты через запятую, например: 12,13', 'warn');
      this.autoShop = { ...this.autoShop, active: false };
      this._syncPersist();
      return;
    }

    this.log(`[Автоскупщик] Запущен | слоты: ${slots.join(',')} | ${button === 1 ? 'ПКМ' : 'ЛКМ'} | задержка ${this.autoShop.delay}мс | цикл каждые ${this.autoShop.cycleDelay}мс`, 'success');
    this.io.emit(`bot:${this.id}:autoShop`, this.autoShop);
    this._syncPersist();

    const doShop = async () => {
      if (!this.autoShop?.active || !this.bot || this.status !== 'online') return;

      // Команда открытия меню — 1 раз перед циклом
      if (this.autoShop.openCmd) {
        try { this.bot.chat(this.autoShop.openCmd); } catch {}
        await new Promise(r => setTimeout(r, 1500)); // ждём открытия меню
      }

      // Цикл кликов
      while (this.autoShop?.active && this.bot && this.status === 'online') {
        for (const slot of slots) {
          if (!this.autoShop?.active) break;
          await this.clickSlot(slot, this.autoShop.button, 0, 1200);
          if (this.autoShop.delay > 0) await new Promise(r => setTimeout(r, this.autoShop.delay));
        }
        // Пауза между циклами
        if (this.autoShop?.active) {
          await new Promise(r => setTimeout(r, this.autoShop.cycleDelay));
        }
      }
    };

    // Небольшая пауза перед стартом
    this._autoShopTimer = setTimeout(doShop, 200);
  }

  stopAutoShop() {
    clearTimeout(this._autoShopTimer);
    this._autoShopTimer = null;
    if (this.autoShop?.active) {
      this.autoShop = { ...this.autoShop, active: false };
      this.log('[Автоскупщик] Остановлен');
      this.io.emit(`bot:${this.id}:autoShop`, this.autoShop);
      this._syncPersist();
    }
  }

  // ── КОСТИ → КОСТНАЯ МУКА (авто) ──────────────────────────────────────────────
  // Каждые 300мс проверяет инвентарь: если есть кости — сразу перекрафчивает
  // их все в костную муку (без верстака, рецепт 1x1) и тут же выбрасывает муку,
  // предварительно наведя взгляд на заданный yaw/pitch.
  startAutoBoneMeal(config = {}) {
    this.stopAutoBoneMeal();

    this.autoBoneMeal = {
      active:     true,
      lookYaw:    parseFloat(config.lookYaw)   || 0,
      lookPitch:  parseFloat(config.lookPitch) || 0,
    };
    this.log(`[Кости→Мука] Запущен | взгляд ${this.autoBoneMeal.lookYaw}°/${this.autoBoneMeal.lookPitch}°`, 'success');
    this.io.emit(`bot:${this.id}:autoBoneMeal`, this.autoBoneMeal);
    this._syncPersist();

    const tick = async () => {
      if (!this.autoBoneMeal?.active || !this.bot || this.status !== 'online') return;
      try { await this._processBoneMeal(); } catch (e) { this.log(`[Кости→Мука] Ошибка: ${e.message}`, 'warn'); }
      if (this.autoBoneMeal?.active) {
        this._boneMealTimer = setTimeout(tick, 300);
      }
    };
    this._boneMealTimer = setTimeout(tick, 300);
  }

  stopAutoBoneMeal() {
    clearTimeout(this._boneMealTimer);
    this._boneMealTimer = null;
    if (this.autoBoneMeal?.active) {
      this.autoBoneMeal = { ...this.autoBoneMeal, active: false };
      this.log('[Кости→Мука] Остановлен');
      this.io.emit(`bot:${this.id}:autoBoneMeal`, this.autoBoneMeal);
      this._syncPersist();
    }
  }

  async _processBoneMeal() {
    const bot = this.bot;
    if (!bot) return;
    if (this.window) return; // не лезем в крафт, если открыто другое окно (например автоскупщик)

    const hasBoneNow = () => bot.inventory.items().some(i => i.name === 'bone');
    if (!hasBoneNow()) return;

    const CRAFT_OUTPUT_SLOT = 0;
    const CRAFT_INPUT_SLOT  = 1; // рецепт бесформенный (1 кость → 3 муки) — подходит любая из клеток 1-4
    const STEP_DELAY = 150; // пауза между кликами, чтобы сервер/античит успевал подтверждать транзакции

    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const clickTimeout = (slot, button, mode) => Promise.race([
      bot.clickWindow(slot, button, mode),
      new Promise((_, reject) => setTimeout(() => reject(new Error('click timeout')), 1500)),
    ]);

    // Возвращает в инвентарь то, что могло залипнуть в клетке крафта после
    // отклонённой транзакции — иначе кости "теряются" из виду (лежат в клетке,
    // но hasBoneNow() их уже не видит, и функция решает что делать больше нечего).
    const recoverCraftSlot = async () => {
      try {
        if (bot.inventory.slots[CRAFT_INPUT_SLOT]) {
          await clickTimeout(CRAFT_INPUT_SLOT, 0, 1);
        }
      } catch {}
    };

    let crafted = 0;
    let guard = 0;
    // За раз в клетку крафта помещается максимум один стак (обычно 64 кости) —
    // если костей больше, повторяем: следующий стак, следующий шифт-клик.
    while (hasBoneNow() && guard++ < 50) {
      const boneItem = bot.inventory.items()
        .filter(i => i.name === 'bone')
        .sort((a, b) => b.count - a.count)[0];
      if (!boneItem) break;
      try {
        // Берём весь стак костей на курсор
        await clickTimeout(boneItem.slot, 0, 0);
        await wait(STEP_DELAY);
        // Кладём в клетку крафта (2x2 крафт прямо в инвентаре, без верстака)
        await clickTimeout(CRAFT_INPUT_SLOT, 0, 0);
        await wait(STEP_DELAY);
        // Шифт-клик по результату — сразу крафтит и забирает ВЕСЬ возможный
        // выход из этого стака за одно действие, как ручной шифт-клик в игре
        await clickTimeout(CRAFT_OUTPUT_SLOT, 0, 1);
        crafted += boneItem.count;
        await wait(STEP_DELAY);

        // Если что-то не скрафталось и залипло в клетке — вернуть в инвентарь
        await recoverCraftSlot();
      } catch (e) {
        this.log(`[Кости→Мука] Ошибка крафта: ${e.message}`, 'warn');
        await recoverCraftSlot();
        break;
      }
    }
    if (crafted) this.log(`[Кости→Мука] Скрафчено ${crafted} костей стаком (шифт-клик)`, 'success');

    // Наводим взгляд перед броском
    try {
      this.look(this.autoBoneMeal.lookYaw * Math.PI / 180, this.autoBoneMeal.lookPitch * Math.PI / 180);
    } catch {}
    await wait(150);

    // Выбрасываем всю получившуюся костную муку (может быть несколько стаков)
    let dropGuard = 0;
    while (dropGuard++ < 20) {
      const bm = bot.inventory.items().find(i => i.name === 'bone_meal');
      if (!bm) break;
      try {
        await Promise.race([
          bot.toss(bm.type, null, bm.count),
          new Promise((_, reject) => setTimeout(() => reject(new Error('toss timeout')), 1200)),
        ]);
        await wait(STEP_DELAY);
      } catch (e) {
        this.log(`[Кости→Мука] Не удалось выбросить муку: ${e.message}`, 'warn');
        await wait(400); // даём серверу отойти перед следующей попыткой на будущем тике
        break;
      }
    }
  }

  getInventory() {
    if (!this.bot) return [];
    return (this.bot.inventory?.items() || []).map(i => ({
      slot: i.slot, name: i.name, count: i.count, displayName: i.displayName
    }));
  }

  toJSON() {
    return {
      id: this.id,
      account: { ...this.account, password: this.account.password ? '***' : '' },
      status: this.status,
      server: this.server || null,
      hud: this.hud,
      dimension: this.bot?.game?.dimension ?? null,
      chatLog: this.chatLog.slice(-50),
      inventory: this.inventory,
      window: this._windowSnapshot(),
      clicker: this.clicker,
      chatLoop: this.chatLoop,
      macroLoop: this.macroLoop,
      autoReconnect: this.autoReconnect,
      recoveryTriggers: this.recoveryTriggers,
      recoverySequenceText: this.account.recoverySequenceText || '',
      rememberedPos: this.rememberedPos,
      autoBal: this.autoBal,
      autoFish: this.autoFish,
      autoShop: this.autoShop,
      autoBoneMeal: this.autoBoneMeal,
      chatScanner: this.chatScanner,
      autoHeal: this.autoHeal,
      autoPayday: this.autoPayday,
      authConfig: this.authConfig,
    };
  }
}

export class BotManager {
  constructor(io, persist) {
    this.io = io;
    this.persist = typeof persist === 'function' ? persist : () => {};
    this.bots = new Map(); // id -> BotInstance
  }

  addAccount(account) {
    if (!account.id) account.id = uuidv4();
    const inst = new BotInstance(account, this.io, this.persist);
    this.bots.set(account.id, inst);
    return inst;
  }

  removeAccount(id) {
    const inst = this.bots.get(id);
    if (inst) { inst.disconnect(); this.bots.delete(id); }
  }

  get(id) { return this.bots.get(id); }

  getAll() { return Array.from(this.bots.values()).map(b => b.toJSON()); }

  async connectBot(id, server) {
    const inst = this.bots.get(id);
    if (inst) await inst.connect(server);
  }

  async disconnectBot(id) {
    const inst = this.bots.get(id);
    if (inst) await inst.disconnect();
  }

  async connectAll(server) {
    for (const inst of this.bots.values()) {
      if (inst.status === 'offline' || inst.status === 'error') {
        await inst.connect(server);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }

  async disconnectAll() {
    for (const inst of this.bots.values()) await inst.disconnect();
  }
}