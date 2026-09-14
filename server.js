// ── Глобальная защита процесса от необработанных ошибок ─────────────────────
// ECONNRESET и прочие сетевые сбои внутри mineflayer/minecraft-protocol иногда
// всплывают как необработанные события 'error' и роняют весь Node-процесс.
// Эти обработчики перехватывают их, логируют и продолжают работу.
process.on('uncaughtException', (err) => {
  const ignore = ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND'];
  if (ignore.includes(err.code)) {
    console.warn(`[Process] Сетевая ошибка проигнорирована (${err.code}): ${err.message}`);
  } else {
    console.error('[Process] uncaughtException — продолжаем работу:', err);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[Process] unhandledRejection — продолжаем работу:', reason);
});

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { BotManager } from './botmanager.js';
import { testProxyTunnel } from './proxyconnect.js';
import { getSettings, saveSettings, resetSettings, SETTINGS_DEFAULTS } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const PROXIES_FILE  = path.join(__dirname, 'proxies.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const BACKUPS_DIR   = path.join(__dirname, 'backups');
const manager = new BotManager(io, () => saveAccounts());

// ── АВТО-БЭКАП ДАННЫХ ПРИ КАЖДОМ ЗАПУСКЕ ────────────────────────────────────────
// accounts.json / proxies.json / settings.json — это ЛОКАЛЬНЫЕ данные, их нет
// ни в одном архиве с обновлениями кода (и не будет — иначе твои аккаунты и
// прокси затирались бы чужими при каждом обновлении). Но если при обновлении
// файлов проекта случайно удалить/перезаписать папку целиком — данные пропадут
// безвозвратно. Поэтому при каждом старте сервера делаем снимок в backups/ и
// храним последние 10 — на всякий случай.
function backupDataFiles() {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const [label, file] of [['accounts', ACCOUNTS_FILE], ['proxies', PROXIES_FILE], ['settings', SETTINGS_FILE]]) {
      if (!fs.existsSync(file)) continue;
      fs.copyFileSync(file, path.join(BACKUPS_DIR, `${label}-${stamp}.json`));
    }
    // Чистим старые бэкапы — оставляем последние 10 на каждый файл
    const files = fs.readdirSync(BACKUPS_DIR);
    for (const label of ['accounts', 'proxies', 'settings']) {
      const group = files.filter(f => f.startsWith(label + '-')).sort().reverse();
      group.slice(10).forEach(f => { try { fs.unlinkSync(path.join(BACKUPS_DIR, f)); } catch {} });
    }
  } catch (e) {
    console.error('[Backup] Не удалось сделать бэкап данных:', e.message);
  }
}
backupDataFiles();

// ── Пул прокси ────────────────────────────────────────────────────────────────
function loadProxies() {
  try {
    if (fs.existsSync(PROXIES_FILE)) {
      return JSON.parse(fs.readFileSync(PROXIES_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function saveProxies(list) {
  fs.writeFileSync(PROXIES_FILE, JSON.stringify(list, null, 2));
}

// Парсим строку прокси: ip:port:user:pass или socks5://user:pass@ip:port
function parseProxyLine(line) {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;
  // Формат с протоколом: socks5://user:pass@host:port
  const urlMatch = line.match(/^(socks5|socks4|http):\/\/(?:([^:@]+):([^@]*)@)?([^:]+):(\d+)/i);
  if (urlMatch) {
    return { type: urlMatch[1].toLowerCase(), username: urlMatch[2]||'', password: urlMatch[3]||'', host: urlMatch[4], port: urlMatch[5] };
  }
  // Формат: ip:port:user:pass  или  ip:port
  const parts = line.split(':');
  if (parts.length >= 2) {
    return { type: 'socks5', host: parts[0], port: parts[1], username: parts[2]||'', password: parts[3]||'' };
  }
  return null;
}

// Выбрать прокси для нового бота (наименее загруженный, < лимита из настроек)
function pickProxy() {
  const proxies = loadProxies();
  if (!proxies.length) return null;
  const limit = Math.max(1, parseInt(getSettings().proxyLimit) || 3);
  // Считаем сколько ботов на каждый прокси
  const usage = {};
  for (const inst of manager.bots.values()) {
    const p = inst.account.proxy;
    if (p && p.host) {
      const key = `${p.host}:${p.port}`;
      usage[key] = (usage[key] || 0) + 1;
    }
  }
  // Ищем прокси с местом
  for (const proxy of proxies) {
    const key = `${proxy.host}:${proxy.port}`;
    if ((usage[key] || 0) < limit) return proxy;
  }
  return null; // все заняты
}

// ── Загрузка сохранённых аккаунтов ──────────────────────────────────────────
function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'));
      data.forEach(acc => { delete acc.proxy; manager.addAccount(acc); }); // proxy теперь из пула
      console.log(`Загружено аккаунтов: ${data.length}`);
    }
  } catch (e) { console.error('Ошибка загрузки аккаунтов:', e.message); }
}

function saveAccounts() {
  try {
    const data = Array.from(manager.bots.values()).map(b => b.account);
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('Ошибка сохранения:', e.message); }
}

// ── REST API ─────────────────────────────────────────────────────────────────

// Прокси пул
app.get('/api/proxies', (req, res) => res.json(loadProxies()));

app.post('/api/proxies', (req, res) => {
  const { lines } = req.body; // строки через \n
  const parsed = String(lines || '').split('\n')
    .map(parseProxyLine).filter(Boolean);
  saveProxies(parsed);
  io.emit('proxies:updated', parsed);
  res.json({ ok: true, count: parsed.length });
});

app.delete('/api/proxies/:idx', (req, res) => {
  const list = loadProxies();
  list.splice(parseInt(req.params.idx), 1);
  saveProxies(list);
  io.emit('proxies:updated', list);
  res.json({ ok: true });
});

// Текущая нагрузка на прокси
app.get('/api/proxies/usage', (req, res) => {
  const usage = {};
  for (const inst of manager.bots.values()) {
    const p = inst.account.proxy;
    if (p && p.host) {
      const key = `${p.host}:${p.port}`;
      usage[key] = (usage[key] || 0) + 1;
    }
  }
  res.json({ usage, limit: Math.max(1, parseInt(getSettings().proxyLimit) || 3) });
});

app.get('/api/bots', (req, res) => res.json(manager.getAll()));

// ── Настройки сайта (то, что раньше было зашито прямо в коде) ────────────────
app.get('/api/settings', (req, res) => res.json(getSettings()));

app.post('/api/settings', (req, res) => {
  const allowedKeys = Object.keys(SETTINGS_DEFAULTS);
  const patch = {};
  for (const k of allowedKeys) {
    if (req.body[k] !== undefined && req.body[k] !== '') patch[k] = req.body[k];
  }
  const updated = saveSettings(patch);
  io.emit('settings:updated', updated);
  res.json(updated);
});

app.post('/api/settings/reset', (req, res) => {
  const updated = resetSettings();
  io.emit('settings:updated', updated);
  res.json(updated);
});

app.post('/api/bots', (req, res) => {
  const acc = req.body;
  if (!acc.username) return res.status(400).json({ error: 'username required' });
  const inst = manager.addAccount(acc);
  saveAccounts();
  res.json(inst.toJSON());
});

// Проверка прокси: реальный туннель (SOCKS/HTTP рукопожатие через прокси до внешнего хоста),
// а не просто "открылся ли TCP до самого прокси" — так ловим ECONNRESET/авторизацию заранее.
app.post('/api/proxy-test', async (req, res) => {
  console.log(' Данные формы прокси:', req.body);

  const host = req.body.host || req.body.ip || req.body.proxyHost || req.body.proxyIp;
  const port = req.body.port || req.body.proxyPort;

  if (!host || !port) {
    const noFieldsError = `Ошибка: Неверные поля запроса. Сервер получил: ${JSON.stringify(req.body)}`;
    return res.status(400).json({ ok: false, success: false, error: noFieldsError, message: noFieldsError, msg: noFieldsError });
  }

  const proxy = {
    type: req.body.type || 'socks5',
    host,
    port,
    username: req.body.username,
    password: req.body.password,
  };

  const result = await testProxyTunnel(proxy);
  const message = result.ok ? 'Туннель через прокси установлен успешно!' : result.error;
  res.json({ ok: result.ok, success: result.ok, error: result.ok ? null : result.error, message, msg: message });
});

app.put('/api/bots/:id', (req, res) => {
  const inst = manager.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'not found' });
  Object.assign(inst.account, req.body);
  if (req.body.recoveryTriggers || req.body.recoverySequenceText !== undefined) {
    inst.setRecoveryConfig({
      onReconnect: req.body.recoveryTriggers?.onReconnect,
      onRespawn: req.body.recoveryTriggers?.onRespawn,
      sequenceText: req.body.recoverySequenceText
    });
  }
  if (req.body.authConfig !== undefined) {
    inst.setAuthConfig(req.body.authConfig);
  }
  saveAccounts();
  res.json(inst.toJSON());
});

app.delete('/api/bots/:id', (req, res) => {
  manager.removeAccount(req.params.id);
  saveAccounts();
  res.json({ ok: true });
});

// ВАЖНО: маршруты /api/bots/all/... должны идти РАНЬШЕ /api/bots/:id/..., иначе Express
// матчит "all" как :id (роут /:id/connect зарегистрирован первым и перехватывает запрос
// раньше, чем Express дойдёт до /all/connect) — бот с id="all" не находится → 404.
app.post('/api/bots/all/connect', async (req, res) => {
  await manager.connectAll(req.body);
  res.json({ ok: true });
});

app.post('/api/bots/all/disconnect', async (req, res) => {
  await manager.disconnectAll();
  res.json({ ok: true });
});

app.post('/api/bots/all/chat', (req, res) => {
  const text = req.body.text || '';
  let sent = 0;
  manager.bots.forEach(inst => {
    if (inst.status === 'online') { inst.chat(text); sent++; }
  });
  res.json({ ok: true, sent });
});

app.post('/api/bots/:id/connect', async (req, res) => {
  const inst = manager.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'not found' });
  // Автоматически назначаем прокси из пула, ЕСЛИ у бота нет своего И явно не
  // включён режим "свой IP" (useDirect) — раньше это было неразличимо: и
  // "прокси ещё не назначен" и "явно без прокси" выглядели одинаково (proxy=null),
  // поэтому нельзя было отправить бота на подключение с реального IP.
  if (!inst.account.useDirect && (!inst.account.proxy || !inst.account.proxy.host)) {
    const proxy = pickProxy();
    if (proxy) { inst.account.proxy = proxy; saveAccounts(); }
  }
  await manager.connectBot(req.params.id, req.body);
  res.json({ ok: true });
});

// Ручной выбор конкретного прокси для бота (кнопка 🪄 в плашке бота).
// proxy: null, useDirect: false — сбросить на авто-подбор из пула при следующем подключении.
// proxy: null, useDirect: true  — подключаться напрямую, без прокси вообще.
// proxy: {...}                  — использовать именно этот прокси.
app.post('/api/bots/:id/proxy', async (req, res) => {
  const inst = manager.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'not found' });
  inst.setProxy(req.body.proxy || null, !!req.body.useDirect);
  saveAccounts();
  if (req.body.reconnect && inst.status !== 'offline') {
    await inst.disconnect();
    if (inst.server) await inst.connect(inst.server);
  }
  res.json(inst.toJSON());
});

app.post('/api/bots/:id/disconnect', async (req, res) => {
  await manager.disconnectBot(req.params.id);
  res.json({ ok: true });
});

app.get('/api/bots/:id/inventory', (req, res) => {
  const inst = manager.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'not found' });
  res.json(inst.getInventory());
});

// Эти три нужны в первую очередь для tg_bridge.py (кнопки бота в Telegram),
// но, конечно, ими можно пользоваться и напрямую — REST-alias к тем же методам,
// что дергаются через socket.io из веб-интерфейса.
app.post('/api/bots/:id/jump', (req, res) => {
  const inst = manager.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'not found' });
  inst.jump();
  res.json({ ok: true });
});

app.post('/api/bots/:id/attack', (req, res) => {
  const inst = manager.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'not found' });
  inst.attack();
  res.json({ ok: true });
});

app.post('/api/bots/:id/use', (req, res) => {
  const inst = manager.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'not found' });
  inst.useItem();
  // Короткое разовое использование (ПКМ), а не "зажать" — сами отпускаем через мгновение
  setTimeout(() => inst.stopUseItem(), 250);
  res.json({ ok: true });
});

app.post('/api/bots/:id/chat', (req, res) => {
  const inst = manager.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'not found' });
  inst.chat(req.body.text || '');
  res.json({ ok: true });
});

// ── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('UI подключился');
  socket.emit('bots:init', manager.getAll());

  socket.on('bot:chat', ({ id, text }) => manager.get(id)?.chat(text));
  socket.on('bot:key', ({ id, key, state }) => manager.get(id)?.setKey(key, state));
  socket.on('bot:look', ({ id, yaw, pitch }) => manager.get(id)?.look(yaw, pitch));
  socket.on('bot:jump', ({ id }) => manager.get(id)?.jump());
  socket.on('bot:attack', ({ id }) => manager.get(id)?.attack());
  socket.on('bot:useItem', ({ id, state }) => state ? manager.get(id)?.useItem() : manager.get(id)?.stopUseItem());
  socket.on('bot:slot', ({ id, slot }) => manager.get(id)?.selectSlot(slot));
  socket.on('bot:rememberPos', ({ id }) => manager.get(id)?.rememberCurrentPosition());
  socket.on('bot:forgetPos', ({ id }) => manager.get(id)?.forgetRememberedPosition());

  // Кликер (ЛКМ/ПКМ с задержкой) и авто-реконнект на тот же сервер
  socket.on('bot:clicker', ({ id, active, button, delay }) => {
    const inst = manager.get(id);
    if (!inst) return;
    if (active) inst.startClicker(button, delay);
    else inst.stopClicker();
  });
  socket.on('bot:autoReconnect', ({ id, enabled }) => manager.get(id)?.setAutoReconnect(enabled));

  // Авто-отправка сообщения/команды в чат по таймеру (тумблер вкл/выкл + задержка)
  socket.on('bot:autoBal', ({ id, active, interval }) => {
    const inst = manager.get(id);
    if (!inst) return;
    if (active) inst.startAutoBal(interval);
    else inst.stopAutoBal();
  });

  // Сохранить макрос слежения за позицией
  socket.on('bot:setPosMacro', ({ id, text }) => {
    const inst = manager.get(id);
    if (!inst) return;
    inst.account.recoverySequenceText = text;
    inst.recoverySequence = parseRecoverySequence ? parseRecoverySequence(text) : [];
    // Пересохраняем аккаунты
    saveAccounts?.();
  });

  // Автоскупщик
  socket.on('bot:autoShop', ({ id, active, openCmd, slots, button, delay, cycleDelay }) => {
    const inst = manager.get(id);
    if (!inst) return;
    if (active) inst.startAutoShop({ openCmd, slots, button, delay, cycleDelay });
    else inst.stopAutoShop();
  });

  // Кости → костная мука (авто)
  socket.on('bot:autoBoneMeal', ({ id, active, lookYaw, lookPitch }) => {
    const inst = manager.get(id);
    if (!inst) return;
    if (active) inst.startAutoBoneMeal({ lookYaw, lookPitch });
    else inst.stopAutoBoneMeal();
  });

  // Список доп-функций, добавленных в плашку бота через ➕ (какие блоки показывать)
  socket.on('bot:setFeatureVisibility', ({ id, features }) => {
    const inst = manager.get(id);
    if (!inst) return;
    inst.account.enabledFeatures = Array.isArray(features) ? features.filter(f => typeof f === 'string') : [];
    saveAccounts();
  });

  // Авторыбалка
  socket.on('bot:autoFish', ({ id, active }) => {
    const inst = manager.get(id);
    if (!inst) return;
    if (active) inst.startAutoFish();
    else inst.stopAutoFish();
  });

  // Сканер чата
  socket.on('bot:chatScanner', ({ id, active, pattern, whitelist, action, nearInterval }) => {
    const inst = manager.get(id);
    if (!inst) return;
    if (active) inst.startChatScanner({ pattern, whitelist: (whitelist||'').split('\n').map(s=>s.trim()).filter(Boolean), action, nearInterval });
    else inst.stopChatScanner();
  });

  socket.on('bot:autoHeal', ({ id, active }) => {
    const inst = manager.get(id);
    if (!inst) return;
    if (active) inst.startAutoHeal();
    else inst.stopAutoHeal();
  });

  socket.on('bot:autoPayday', ({ id, active, intervalHours }) => {
    const inst = manager.get(id);
    if (!inst) return;
    if (active) inst.startAutoPayday(intervalHours);
    else inst.stopAutoPayday();
  });

  socket.on('bot:chatLoop', ({ id, active, text, delay }) => {
    const inst = manager.get(id);
    if (!inst) return;
    if (active) inst.startChatLoop(text, delay);
    else inst.stopChatLoop();
  });

  // Инвентарь и меню (сундуки, печи, верстак и т.д.)
  socket.on('bot:invClick', ({ id, slot, button, mode }) => manager.get(id)?.clickSlot(slot, button, mode));
  socket.on('bot:invMove', ({ id, from, to }) => manager.get(id)?.moveItem(from, to));
  socket.on('bot:windowClose', ({ id }) => manager.get(id)?.closeWindow());
  socket.on('bot:runMacro', ({ id, text }) => manager.get(id)?.runMacroText(text));
  socket.on('bot:macroLoop', ({ id, active, text, delay }) => {
    const inst = manager.get(id);
    if (!inst) return;
    if (active) inst.startMacroLoop(text, delay);
    else inst.stopMacroLoop();
  });

  socket.on('disconnect', () => console.log('UI отключился'));

  socket.on('send_command', ({ botId, command }) => {
      const botInstance = manager.get(botId); // Используем ваш существующий manager
      if (botInstance && botInstance.bot) {
          console.log(`[Command] Отправка '${command}' боту ${botId}`);
          botInstance.bot.chat(command);
      } else {
          console.error("Бот не найден или не инициализирован");
      }
  });
  socket.on('bots:bulkAction', ({ ids, action, data }) => {
      if (!ids || !Array.isArray(ids)) return;

      ids.forEach(id => {
          const inst = manager.get(id);
          if (!inst) return;

          // Эти действия имеет смысл выполнять и для офлайн-ботов
          if (action === 'connect') { inst.connect(data); return; }
          if (action === 'disconnect') { inst.disconnect(); return; }
          if (action === 'autoReconnect') { inst.setAutoReconnect(data.enabled); return; }
          if (action === 'chatLoop') {
              if (data.active) inst.startChatLoop(data.text, data.delay);
              else inst.stopChatLoop();
              return;
          }

          if (inst.status !== 'online') return;

          switch (action) {
              case 'chat':
                  inst.chat(data.text);
                  break;
              case 'jump':
                  inst.jump();
                  break;
              case 'attack':
                  inst.attack();
                  break;
              case 'look':
                  inst.look(data.yaw, data.pitch);
                  break;
              case 'clickSlot':
                  inst.clickSlot(data.slot, 0, 0);
                  break;
              case 'clicker':
                  if (data.active) inst.startClicker(data.button, data.delay);
                  else inst.stopClicker();
                  break;
              case 'useItem':
                  if (data.state) inst.useItem();
                  else inst.stopUseItem();
                  break;
          }
      });
  });
});

// ── Старт ────────────────────────────────────────────────────────────────────
loadAccounts();

// ── Telegram-бот ─────────────────────────────────────────────────────────────
// Управление ботами из Telegram вынесено в отдельный процесс — tg_bridge.py (Python).
// ── Авто-бал и авто-хил REST ─────────────────────────────────────────────────
app.post('/api/bots/:id/autoBal', (req, res) => {
  const inst = manager.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'not found' });
  const { active, interval } = req.body;
  if (active) inst.startAutoBal(interval);
  else inst.stopAutoBal();
  res.json({ ok: true });
});

app.post('/api/bots/:id/autoHeal', (req, res) => {
  const inst = manager.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'not found' });
  const { active } = req.body;
  if (active) inst.startAutoHeal();
  else inst.stopAutoHeal();
  res.json({ ok: true });
});

app.post('/api/bots/:id/autoPayday', (req, res) => {
  const inst = manager.get(req.params.id);
  if (!inst) return res.status(404).json({ error: 'not found' });
  const { active, intervalHours } = req.body;
  if (active) inst.startAutoPayday(intervalHours);
  else inst.stopAutoPayday();
  res.json({ ok: true });
});

// Он общается с этим сервером через уже существующий REST API (см. /api/bots и т.д.),
// поэтому здесь, в server.js, никакого отдельного TG-бота поднимать не нужно.
// Запускать: python Tgbridge.py  (см. .env: TG_TOKEN, TG_ALLOWED_IDS, TG_PROXY, NODE_API_URL)

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`UltBot Manager запущен: http://localhost:${PORT}`));