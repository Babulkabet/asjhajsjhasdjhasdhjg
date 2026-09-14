import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

// Значения по умолчанию — всё, что раньше было "зашито" прямо в коде
// (сервер, команды авто-бала/авто-хила, пороги слежения за координатами,
// шаблоны авто-логина), теперь живёт здесь и редактируется во вкладке
// "Настройки" на сайте без правки файлов проекта.
const DEFAULTS = {
  // ── Сервер по умолчанию (подставляется в новую плашку бота и в панель "Управление") ──
  defaultHost: 'mc.sunw.pro',
  defaultPort: 25565,
  defaultVersion: '1.20.1',

  // ── Авто-бал + инвест ──
  autoBalCommand: '/bal',
  autoBalInvestCommand: '/clan invest {amount}',
  autoBalIntervalSec: 60,

  // ── Авто-хил ──
  autoHealCommand: '/heal',
  autoHealIntervalSec: 120,

  // ── Авто-payday (get daily reward + отправить часть кому-то) ──
  autoPaydayCommand: '/payday take',
  autoPaydayPayCommand: '/rubpay {target} {amount}',
  autoPaydayTarget: 'xloverlove',
  autoPaydayAmount: 500,
  autoPaydayIntervalHours: 4,

  // ── Слежение за запомненными координатами ──
  posWatchThreshold: 15,   // блоков — если бота увело дальше, считаем что его "сдёрнуло"
  posWatchRetrySec: 30,    // если через столько секунд не вернулся — повторяем макрос

  // ── Пул прокси ──
  proxyLimit: 3, // максимум ботов на один прокси из пула

  // ── Автоскупщик ──
  autoShopSlots: '12,13',     // слоты через запятую (круг кликов)
  autoShopButton: 0,          // 0=ЛКМ, 1=ПКМ
  autoShopDelay: 500,         // мс между кликами
  autoShopCycleDelay: 1000,   // мс между циклами

  // ── Авто-логин/регистрация по умолчанию (можно переопределить у каждого бота отдельно) ──
  authRegisterCommand: '/register {password} {password}',
  authLoginCommand: '/login {password}',
  authRegisterPattern: 'не зарегистрирован|незарегистрирован|зарегистрируйтесь|регистрация|используйте.*register|not registered|please register',
  authLoginPattern: 'войдите|авторизу|авторизаци|используйте.*login|please login|already registered|уже зарегистрирован',
};

let current = { ...DEFAULTS };

export function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      current = { ...DEFAULTS, ...saved };
    }
  } catch (e) {
    console.error('Ошибка загрузки settings.json:', e.message);
  }
  return current;
}

export function getSettings() {
  return current;
}

export function saveSettings(patch) {
  current = { ...current, ...patch };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2));
  return current;
}

export function resetSettings() {
  current = { ...DEFAULTS };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(current, null, 2));
  return current;
}

export const SETTINGS_DEFAULTS = DEFAULTS;

loadSettings();