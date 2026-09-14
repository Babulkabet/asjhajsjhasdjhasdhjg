"""
Tgbridge.py — Telegram-управление UltBot Manager (Python).

Установка:
    pip install pyTelegramBotAPI requests[socks]

Запуск (отдельно от node, в второй консоли):
    python Tgbridge.py
"""
import os
import threading
import time
import requests
import telebot
from telebot import types

# ── Конфиг из .env ────────────────────────────────────────────────────────────
def load_dotenv(path='.env'):
    if not os.path.exists(path):
        return
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            os.environ.setdefault(k.strip(), v.strip())

load_dotenv()

TG_TOKEN       = os.environ.get('TG_TOKEN', '')
TG_ALLOWED_IDS = {int(x) for x in os.environ.get('TG_ALLOWED_IDS', '').split(',') if x.strip().isdigit()}
NODE_API_URL   = os.environ.get('NODE_API_URL', 'http://localhost:3000').rstrip('/')
TG_PROXY       = os.environ.get('TG_PROXY', '')

if not TG_TOKEN:
    raise SystemExit('TG_TOKEN не задан (.env или переменная окружения)')

# ── Прокси только для Telegram ────────────────────────────────────────────────
if TG_PROXY:
    try:
        import socks  # noqa: F401 — сам модуль не используем напрямую, просто проверяем что PySocks стоит
    except ImportError:
        raise SystemExit(
            'Для работы через SOCKS5-прокси (TG_PROXY задан в .env) нужен пакет PySocks.\n'
            'Поставь его и запусти скрипт заново:\n\n'
            '    pip install pysocks\n'
        )
    parts    = (TG_PROXY.split(':') + [None, None, None, None])[:4]
    host, port, user, pw = parts
    auth     = f'{user}:{pw}@' if user else ''
    proxy_url = f'socks5h://{auth}{host}:{port}'
    telebot.apihelper.proxy = {'https': proxy_url, 'http': proxy_url}
    print(f'[TG] Прокси: {host}:{port}{" (с авторизацией)" if user else ""}')
else:
    print('[TG] Без прокси')

bot = telebot.TeleBot(TG_TOKEN, parse_mode='HTML')

# ── Хелперы REST API (к Node, без прокси, localhost) ─────────────────────────
def api_get(path):
    r = requests.get(f'{NODE_API_URL}{path}', timeout=10)
    r.raise_for_status()
    return r.json()

def api_post(path, json=None):
    r = requests.post(f'{NODE_API_URL}{path}', json=json or {}, timeout=10)
    r.raise_for_status()
    return r.json()

def status_emoji(s):
    return {'online': '🟢', 'connecting': '🟡', 'error': '🔴'}.get(s, '⚫')

def dim_label(dim):
    return {
        'minecraft:overworld': '🌍 Верхний мир',
        'minecraft:the_nether': '🔥 Незер',
        'minecraft:the_end': '🌑 Край',
        'overworld': '🌍 Верхний мир',
        'nether': '🔥 Незер',
        'end': '🌑 Край',
    }.get(dim or '', f'📍 {dim}' if dim else '—')

# ── Доступ ────────────────────────────────────────────────────────────────────
def allowed(chat_id):
    return not TG_ALLOWED_IDS or chat_id in TG_ALLOWED_IDS

def deny(message):
    bot.reply_to(message, f'⛔ Доступ запрещён. Ваш ID: <code>{message.chat.id}</code>')

# ── Пошаговый диалог ──────────────────────────────────────────────────────────
_pending = {}  # chat_id -> {'action': ..., ...}

# ── Команды ───────────────────────────────────────────────────────────────────
@bot.message_handler(commands=['start', 'menu'])
def cmd_start(message):
    if not allowed(message.chat.id): return deny(message)
    try:
        bots  = api_get('/api/bots')
        lines = '\n'.join(f"{status_emoji(b['status'])} <b>{b['account']['username']}</b>" for b in bots) or '<i>Ботов нет</i>'
    except Exception as e:
        lines = f'⚠️ Ошибка получения ботов: {e}'
    kb = types.InlineKeyboardMarkup()
    kb.row(
        types.InlineKeyboardButton('📋 Список ботов',    callback_data='list'),
        types.InlineKeyboardButton('🔗 Подключить всех', callback_data='connect_all'),
    )
    kb.row(
        types.InlineKeyboardButton('⏏️ Отключить всех', callback_data='disconnect_all'),
        types.InlineKeyboardButton('💬 Чат всем',        callback_data='chat_all'),
    )
    kb.row(types.InlineKeyboardButton('📊 Статус всех', callback_data='status_all'))
    bot.send_message(message.chat.id, f'🤖 <b>UltBot Manager</b>\n\n{lines}\n\nВыберите действие:', reply_markup=kb)

@bot.message_handler(commands=['cancel'])
def cmd_cancel(message):
    _pending.pop(message.chat.id, None)
    bot.reply_to(message, '❌ Отменено.')

@bot.message_handler(commands=['help'])
def cmd_help(message):
    if not allowed(message.chat.id): return deny(message)
    bot.reply_to(message, '📖 <b>Команды:</b>\n/menu — главное меню\n/help — справка\n/cancel — отмена ввода')

# ── Ввод текста (чат / сервер) ────────────────────────────────────────────────
@bot.message_handler(func=lambda m: m.chat.id in _pending)
def handle_pending(message):
    if not allowed(message.chat.id): return deny(message)
    pending = _pending.pop(message.chat.id)
    text = message.text.strip()

    if pending['action'] == 'connect':
        parts   = text.split(':')
        host    = parts[0]
        port    = parts[1] if len(parts) > 1 else '25565'
        version = parts[2] if len(parts) > 2 else ''
        try:
            api_post(f"/api/bots/{pending['bot_id']}/connect", {'host': host, 'port': port, 'version': version})
            bot.reply_to(message, f'🔗 Подключаю к <code>{host}:{port}</code>...')
        except Exception as e:
            bot.reply_to(message, f'⚠️ Ошибка: {e}')

    elif pending['action'] == 'chat':
        try:
            api_post(f"/api/bots/{pending['bot_id']}/chat", {'text': text})
            bot.reply_to(message, f'✅ Отправлено: <code>{text}</code>')
        except Exception as e:
            bot.reply_to(message, f'⚠️ Ошибка: {e}')

    elif pending['action'] == 'chat_all':
        try:
            res = api_post('/api/bots/all/chat', {'text': text})
            bot.reply_to(message, f"✅ Отправлено {res.get('sent', 0)} ботам: <code>{text}</code>")
        except Exception as e:
            bot.reply_to(message, f'⚠️ Ошибка: {e}')

# ── Callback-кнопки ───────────────────────────────────────────────────────────
@bot.callback_query_handler(func=lambda c: c.data == 'list')
def cb_list(c):
    if not allowed(c.message.chat.id): return
    try:
        bots = api_get('/api/bots')
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}'); return
    if not bots:
        bot.answer_callback_query(c.id, 'Ботов нет'); return
    kb = types.InlineKeyboardMarkup()
    for b in bots:
        kb.row(types.InlineKeyboardButton(
            f"{status_emoji(b['status'])} {b['account']['username']}",
            callback_data=f"bot:{b['id']}"
        ))
    kb.row(types.InlineKeyboardButton('◀️ Главное меню', callback_data='main'))
    bot.edit_message_text('📋 Выберите бота:', c.message.chat.id, c.message.message_id, reply_markup=kb)
    bot.answer_callback_query(c.id)

@bot.callback_query_handler(func=lambda c: c.data == 'main')
def cb_main(c):
    bot.answer_callback_query(c.id)
    cmd_start(c.message)

@bot.callback_query_handler(func=lambda c: c.data == 'status_all')
def cb_status_all(c):
    if not allowed(c.message.chat.id): return
    try:
        bots = api_get('/api/bots')
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}'); return
    lines = []
    for b in bots:
        hud = b.get('hud') or {}
        dim = dim_label(b.get('dimension'))
        lines.append(
            f"{status_emoji(b['status'])} <b>{b['account']['username']}</b>\n"
            f"   ❤️ {hud.get('health','—')}  🍖 {hud.get('food','—')}  "
            f"📍 {hud.get('x','—')} {hud.get('y','—')} {hud.get('z','—')}\n"
            f"   {dim}"
        )
    text = '📊 <b>Статус всех ботов:</b>\n\n' + ('\n\n'.join(lines) or '<i>Ботов нет</i>')
    kb = types.InlineKeyboardMarkup()
    kb.row(
        types.InlineKeyboardButton('🔁 Обновить',     callback_data='status_all'),
        types.InlineKeyboardButton('◀️ Главное меню', callback_data='main'),
    )
    bot.edit_message_text(text, c.message.chat.id, c.message.message_id, reply_markup=kb)
    bot.answer_callback_query(c.id)

@bot.callback_query_handler(func=lambda c: c.data.startswith('bot:'))
def cb_bot_menu(c):
    if not allowed(c.message.chat.id): return
    bot_id = c.data.split(':', 1)[1]
    try:
        bots = {b['id']: b for b in api_get('/api/bots')}
        b    = bots.get(bot_id)
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}'); return
    if not b:
        bot.answer_callback_query(c.id, 'Бот не найден'); return
    hud  = b.get('hud') or {}
    dim  = dim_label(b.get('dimension'))
    text = (
        f"{status_emoji(b['status'])} <b>{b['account']['username']}</b>\n"
        f"Статус: <code>{b['status']}</code>\n"
        f"Сервер: <code>{b['server']['host']}:{b['server']['port']}</code>\n"
        f"❤️ {hud.get('health','—')}  🍖 {hud.get('food','—')}  "
        f"📍 {hud.get('x','—')} {hud.get('y','—')} {hud.get('z','—')}\n"
        f"Мир: {dim}"
    ) if b.get('server') else (
        f"{status_emoji(b['status'])} <b>{b['account']['username']}</b>\n"
        f"Статус: <code>{b['status']}</code>\n"
        f"Мир: {dim}"
    )
    kb = types.InlineKeyboardMarkup()
    if b['status'] == 'online':
        kb.row(
            types.InlineKeyboardButton('⏏️ Отключить',     callback_data=f'disc:{bot_id}'),
            types.InlineKeyboardButton('🔄 Переподключить', callback_data=f'reconn:{bot_id}'),
        )
        kb.row(
            types.InlineKeyboardButton('💬 Чат',          callback_data=f'chat:{bot_id}'),
            types.InlineKeyboardButton('📦 Инвентарь',    callback_data=f'inv:{bot_id}'),
        )
        kb.row(
            types.InlineKeyboardButton('📋 Логи',         callback_data=f'log:{bot_id}'),
            types.InlineKeyboardButton('🔔 Слежка',       callback_data=f'logsub:{bot_id}'),
        )
        kb.row(
            types.InlineKeyboardButton('⬆️ Прыжок',      callback_data=f'jump:{bot_id}'),
            types.InlineKeyboardButton('⚔️ Атака',       callback_data=f'attack:{bot_id}'),
            types.InlineKeyboardButton('🎯 Использовать', callback_data=f'use:{bot_id}'),
        )
        ab = b.get('autoBal', {})
        ah = b.get('autoHeal', {})
        kb.row(
            types.InlineKeyboardButton(
                '🔴 Стоп бал' if ab.get('active') else '💰 Авто-бал+инвест',
                callback_data=f'autobal:{bot_id}'
            ),
            types.InlineKeyboardButton(
                '🔴 Стоп хил' if ah.get('active') else '💊 Авто-хил',
                callback_data=f'autoheal:{bot_id}'
            ),
        )
    else:
        kb.row(
            types.InlineKeyboardButton('🔗 Подключить',    callback_data=f'conn:{bot_id}'),
            types.InlineKeyboardButton('🔄 Переподключить', callback_data=f'reconn:{bot_id}'),
        )
    kb.row(
        types.InlineKeyboardButton('◀️ Назад',   callback_data='list'),
        types.InlineKeyboardButton('🔁 Обновить', callback_data=f'bot:{bot_id}'),
    )
    bot.edit_message_text(text, c.message.chat.id, c.message.message_id, reply_markup=kb)
    bot.answer_callback_query(c.id)

@bot.callback_query_handler(func=lambda c: c.data == 'connect_all')
def cb_connect_all(c):
    if not allowed(c.message.chat.id): return
    try:
        bots   = api_get('/api/bots')
        server = next((b['server'] for b in bots if b.get('server')), None)
        if not server:
            bot.send_message(c.message.chat.id, '⚠️ Подключи хотя бы одного бота вручную первым.')
            bot.answer_callback_query(c.id); return
        api_post('/api/bots/all/connect', server)
        bot.answer_callback_query(c.id, f"Подключаю всех к {server['host']}:{server['port']}...")
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}')

@bot.callback_query_handler(func=lambda c: c.data == 'disconnect_all')
def cb_disconnect_all(c):
    if not allowed(c.message.chat.id): return
    try:
        api_post('/api/bots/all/disconnect')
        bot.answer_callback_query(c.id, 'Все боты отключены')
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}')

@bot.callback_query_handler(func=lambda c: c.data.startswith('conn:'))
def cb_connect_one(c):
    if not allowed(c.message.chat.id): return
    bot_id = c.data.split(':', 1)[1]
    _pending[c.message.chat.id] = {'action': 'connect', 'bot_id': bot_id}
    bot.send_message(c.message.chat.id, '🔗 Введи сервер: <code>host:port:version</code>\n/cancel — отмена')
    bot.answer_callback_query(c.id)

@bot.callback_query_handler(func=lambda c: c.data.startswith('disc:'))
def cb_disconnect_one(c):
    if not allowed(c.message.chat.id): return
    try:
        api_post(f"/api/bots/{c.data.split(':',1)[1]}/disconnect")
        bot.answer_callback_query(c.id, 'Отключен')
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}')

@bot.callback_query_handler(func=lambda c: c.data.startswith('reconn:'))
def cb_reconnect(c):
    if not allowed(c.message.chat.id): return
    bot_id = c.data.split(':', 1)[1]
    try:
        bots   = {b['id']: b for b in api_get('/api/bots')}
        b      = bots.get(bot_id)
        server = b.get('server') if b else None
        if not server:
            _pending[c.message.chat.id] = {'action': 'connect', 'bot_id': bot_id}
            bot.send_message(c.message.chat.id, '🔄 Введи сервер: <code>host:port:version</code>\n/cancel — отмена')
            bot.answer_callback_query(c.id); return
        api_post(f'/api/bots/{bot_id}/disconnect')
        time.sleep(1)
        api_post(f'/api/bots/{bot_id}/connect', server)
        bot.answer_callback_query(c.id, '🔄 Переподключаю...')
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}')

@bot.callback_query_handler(func=lambda c: c.data.startswith('chat:') or c.data == 'chat_all')
def cb_chat_prompt(c):
    if not allowed(c.message.chat.id): return
    if c.data == 'chat_all':
        _pending[c.message.chat.id] = {'action': 'chat_all'}
    else:
        _pending[c.message.chat.id] = {'action': 'chat', 'bot_id': c.data.split(':', 1)[1]}
    bot.send_message(c.message.chat.id, '💬 Введи сообщение:\n/cancel — отмена')
    bot.answer_callback_query(c.id)

@bot.callback_query_handler(func=lambda c: c.data.startswith('autobal:'))
def cb_autobal(c):
    if not allowed(c.message.chat.id): return
    bot_id = c.data.split(':', 1)[1]
    try:
        bots = {b['id']: b for b in api_get('/api/bots')}
        b    = bots.get(bot_id, {})
        ab   = b.get('autoBal', {})
        active = not ab.get('active', False)
        api_post(f'/api/bots/{bot_id}/autoBal', {'active': active, 'interval': 60})
        bot.answer_callback_query(c.id, '💰 Авто-бал запущен' if active else '⏹ Авто-бал остановлен')
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}')

@bot.callback_query_handler(func=lambda c: c.data.startswith('autoheal:'))
def cb_autoheal(c):
    if not allowed(c.message.chat.id): return
    bot_id = c.data.split(':', 1)[1]
    try:
        bots = {b['id']: b for b in api_get('/api/bots')}
        b    = bots.get(bot_id, {})
        ah   = b.get('autoHeal', {})
        active = not ah.get('active', False)
        api_post(f'/api/bots/{bot_id}/autoHeal', {'active': active})
        bot.answer_callback_query(c.id, '💊 Авто-хил запущен' if active else '⏹ Авто-хил остановлен')
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}')

@bot.callback_query_handler(func=lambda c: c.data.startswith('jump:'))
def cb_jump(c):
    if not allowed(c.message.chat.id): return
    try:
        api_post(f"/api/bots/{c.data.split(':',1)[1]}/jump")
        bot.answer_callback_query(c.id, '⬆️ Прыжок!')
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}')

@bot.callback_query_handler(func=lambda c: c.data.startswith('attack:'))
def cb_attack(c):
    if not allowed(c.message.chat.id): return
    try:
        api_post(f"/api/bots/{c.data.split(':',1)[1]}/attack")
        bot.answer_callback_query(c.id, '⚔️ Атака!')
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}')

@bot.callback_query_handler(func=lambda c: c.data.startswith('use:'))
def cb_use(c):
    if not allowed(c.message.chat.id): return
    try:
        api_post(f"/api/bots/{c.data.split(':',1)[1]}/use")
        bot.answer_callback_query(c.id, '🎯 Использовано')
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}')

@bot.callback_query_handler(func=lambda c: c.data.startswith('inv:'))
def cb_inv(c):
    if not allowed(c.message.chat.id): return
    bot_id = c.data.split(':', 1)[1]
    try:
        items = api_get(f'/api/bots/{bot_id}/inventory')
        if not items:
            bot.send_message(c.message.chat.id, '📦 Инвентарь пуст.')
        else:
            lines = '\n'.join(f"  [{i['slot']}] <b>{i.get('displayName', i['name'])}</b> ×{i['count']}" for i in items[:30])
            bot.send_message(c.message.chat.id, f'📦 <b>Инвентарь:</b>\n{lines}')
        bot.answer_callback_query(c.id)
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}')

@bot.callback_query_handler(func=lambda c: c.data.startswith('log:'))
def cb_log(c):
    if not allowed(c.message.chat.id): return
    bot_id = c.data.split(':', 1)[1]
    try:
        bots = {b['id']: b for b in api_get('/api/bots')}
        b    = bots.get(bot_id)
        log  = (b or {}).get('chatLog', [])[-15:]
        if not log:
            bot.send_message(c.message.chat.id, '📋 Лог пуст.')
        else:
            lines = '\n'.join(f"<code>{l['msg'][:120]}</code>" for l in log)
            bot.send_message(c.message.chat.id, f"📋 <b>Лог {b['account']['username']}:</b>\n{lines}")
        bot.answer_callback_query(c.id)
    except Exception as e:
        bot.answer_callback_query(c.id, f'Ошибка: {e}')

# ── Слежка за логом (подписки) ────────────────────────────────────────────────
_log_subs = {}  # chat_id -> set of bot_id

@bot.callback_query_handler(func=lambda c: c.data.startswith('logsub:'))
def cb_logsub(c):
    if not allowed(c.message.chat.id): return
    bot_id  = c.data.split(':', 1)[1]
    chat_id = c.message.chat.id
    subs    = _log_subs.setdefault(chat_id, set())
    if bot_id in subs:
        subs.discard(bot_id)
        bot.answer_callback_query(c.id, '🔕 Отписались от логов')
        bot.send_message(chat_id, f'🔕 Слежка за логом отключена.')
    else:
        subs.add(bot_id)
        bot.answer_callback_query(c.id, '🔔 Слежка включена')
        bot.send_message(chat_id, f'🔔 Слежка за логом включена. Обновления раз в 5 сек.')

# ── Фоновый поллер: смена мира + логи ────────────────────────────────────────
_world_cache = {}   # bot_id -> last known dimension
_log_offsets = {}   # bot_id -> last seen log index

def _notify_all(text):
    """Отправить уведомление всем разрешённым пользователям."""
    if TG_ALLOWED_IDS:
        for chat_id in TG_ALLOWED_IDS:
            try:
                bot.send_message(chat_id, text)
            except Exception:
                pass

def background_poller():
    print('[TG] Фоновый поллер запущен (смена мира + логи)')
    while True:
        try:
            bots = api_get('/api/bots')
            for b in bots:
                bid = b['id']
                dim = b.get('dimension')

                # ── Смена мира ────────────────────────────────────────────────
                prev_dim = _world_cache.get(bid)
                if prev_dim is not None and dim != prev_dim and dim is not None:
                    name = b['account']['username']
                    label = dim_label(dim)
                    _notify_all(f'{label} <b>{name}</b> сменил мир\nИзмерение: <code>{dim}</code>')
                if dim is not None:
                    _world_cache[bid] = dim
                elif bid not in _world_cache:
                    _world_cache[bid] = dim

                # ── Новые логи для подписчиков ────────────────────────────────
                log = b.get('chatLog', [])
                offset = _log_offsets.get(bid, len(log))
                new_entries = log[offset:]
                if new_entries:
                    _log_offsets[bid] = len(log)
                    for chat_id, subs in list(_log_subs.items()):
                        if bid in subs and new_entries:
                            lines = '\n'.join(f"<code>{e['msg'][:120]}</code>" for e in new_entries[-10:])
                            try:
                                bot.send_message(chat_id, f"📋 <b>{b['account']['username']}:</b>\n{lines}")
                            except Exception:
                                pass
                else:
                    _log_offsets.setdefault(bid, len(log))

        except Exception as e:
            print(f'[TG] Поллер ошибка: {e}')

        time.sleep(5)

if __name__ == '__main__':
    t = threading.Thread(target=background_poller, daemon=True)
    t.start()
    print('[TG] Python Telegram-мост запущен...')
    bot.infinity_polling(timeout=10, long_polling_timeout=10)
