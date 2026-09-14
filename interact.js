import { Vec3 } from 'vec3';
import prismarineItemLoader from 'prismarine-item';

/**
 * Свои реализации "клика" вместо bot.activateBlock()/bot.activateEntity()/
 * bot.activateItem() из mineflayer.
 *
 * Почему: bot.activateBlock() и bot.activateEntity() внутри mineflayer перед
 * отправкой пакета сами вызывают bot.lookAt(...) и принудительно доворачивают
 * камеру на центр блока/сущности — это и вызывало дёрганье головы у бота.
 * Сами пакеты протокола (block_place / use_entity / use_item) при этом
 * абсолютно стандартные и версия-зависимые ветки я скопировал 1-в-1 из
 * исходников mineflayer (lib/plugins/inventory.js) — просто без вызова
 * lookAt. Работает точно так же надёжно, но не трогает взгляд бота вообще.
 */

let sequenceCounter = 0;

/**
 * bot.blockAtCursor() у mineflayer ищет блок через физический raycast по
 * коллизии — блоки с boundingBox:"empty" (кусты ягод, цветы, трава, саженцы
 * и т.д.) коллизии не имеют, луч проходит насквозь, и такие блоки НИКОГДА не
 * находятся, сколько на них ни смотри. Свой поиск: просто идём по линии
 * взгляда маленькими шагами и берём первый непустой блок, без оглядки на
 * коллизию — так находится вообще всё, на что реально смотрит игрок.
 */
export function findBlockAtCursor(bot, maxDistance = 4.5, step = 0.1) {
  if (!bot?.entity) return null;
  const eyePos = bot.entity.position.offset(0, bot.entity.height, 0);
  const { yaw, pitch } = bot.entity;
  const dir = new Vec3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  ).normalize();

  for (let d = 0; d <= maxDistance; d += step) {
    const point = eyePos.plus(dir.scaled(d));
    const block = bot.blockAt(point);
    if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') {
      return block;
    }
  }
  return null;
}

function vectorToDirection(v) {
  if (v.y < 0) return 0;
  if (v.y > 0) return 1;
  if (v.z < 0) return 2;
  if (v.z > 0) return 3;
  if (v.x < 0) return 4;
  if (v.x > 0) return 5;
  return 1; // на всякий случай, если вектор нулевой — считаем "вверх"
}

function toNotchianYaw(yaw) {
  return (180 / Math.PI) * (Math.PI - yaw);
}
function toNotchianPitch(pitch) {
  return (180 / Math.PI) * -pitch;
}

/** ПКМ по блоку — без доворота камеры. direction/cursorPos необязательны. */
export function customActivateBlock(bot, block, direction, cursorPos) {
  if (!bot?._client || !block) return;
  const Item = prismarineItemLoader(bot.registry);

  direction = direction ?? new Vec3(0, 1, 0);
  const directionNum = vectorToDirection(direction);
  cursorPos = cursorPos ?? new Vec3(0.5, 0.5, 0.5);

  if (bot.supportFeature('blockPlaceHasHeldItem')) {
    bot._client.write('block_place', {
      location: block.position,
      direction: directionNum,
      heldItem: Item.toNotch(bot.heldItem),
      cursorX: cursorPos.scaled(16).x,
      cursorY: cursorPos.scaled(16).y,
      cursorZ: cursorPos.scaled(16).z,
    });
  } else if (bot.supportFeature('blockPlaceHasHandAndIntCursor')) {
    bot._client.write('block_place', {
      location: block.position,
      direction: directionNum,
      hand: 0,
      cursorX: cursorPos.scaled(16).x,
      cursorY: cursorPos.scaled(16).y,
      cursorZ: cursorPos.scaled(16).z,
    });
  } else if (bot.supportFeature('blockPlaceHasHandAndFloatCursor')) {
    bot._client.write('block_place', {
      location: block.position,
      direction: directionNum,
      hand: 0,
      cursorX: cursorPos.x,
      cursorY: cursorPos.y,
      cursorZ: cursorPos.z,
    });
  } else if (bot.supportFeature('blockPlaceHasInsideBlock')) {
    bot._client.write('block_place', {
      location: block.position,
      direction: directionNum,
      hand: 0,
      cursorX: cursorPos.x,
      cursorY: cursorPos.y,
      cursorZ: cursorPos.z,
      insideBlock: false,
      sequence: 0,
      worldBorderHit: false,
    });
  }

  customSwingArm(bot);
}

/** ПКМ по сущности (кормление животных, торговля и т.д.) — без доворота камеры. */
export function customActivateEntity(bot, entity) {
  if (!bot?._client || !entity) return;
  bot._client.write('use_entity', {
    target: entity.id,
    mouse: 0,
    sneaking: false,
    hand: 0,
  });
  customSwingArm(bot);
}

/** Использовать предмет в руке (еда, лук, зелье и т.д.) — камеру не трогает вообще. */
export function customActivateItem(bot, offHand = false) {
  if (!bot?._client) return;
  const Item = prismarineItemLoader(bot.registry);
  bot.usingHeldItem = true;
  sequenceCounter++;

  if (bot.supportFeature('useItemWithBlockPlace')) {
    bot._client.write('block_place', {
      location: new Vec3(-1, 255, -1),
      direction: -1,
      heldItem: Item.toNotch(bot.heldItem),
      cursorX: -1,
      cursorY: -1,
      cursorZ: -1,
    });
  } else if (bot.supportFeature('useItemWithOwnPacket')) {
    bot._client.write('use_item', {
      hand: offHand ? 1 : 0,
      sequence: sequenceCounter,
      rotation: {
        x: toNotchianYaw(bot.entity.yaw),
        y: toNotchianPitch(bot.entity.pitch),
      },
    });
  }
}

/** Отпустить использование предмета (перестать держать лук натянутым, есть и т.д.) */
export function customDeactivateItem(bot) {
  if (!bot?._client) return;
  const body = { status: 5, location: new Vec3(0, 0, 0), face: 5 };
  if (bot.supportFeature('useItemWithOwnPacket')) {
    body.face = 0;
    body.sequence = 0;
  }
  bot._client.write('block_dig', body);
  bot.usingHeldItem = false;
}

/**
 * ЛКМ зажата — как обычный майн-клиент:
 *  1. Ищем блок в прицеле через наш raycast
 *  2. Отправляем block_dig status=0 (start) на этот блок
 *  3. Если блока нет — шлём use_entity attack на сущность в прицеле
 *  4. В любом случае шлём arm_animation (анимация удара рукой)
 * Вызывается каждый тик кликера — сервер сам считает урон/разрушение.
 */
export function customLeftClick(bot, maxDistance = 4.5) {
  if (!bot?._client || !bot.entity) return;

  // Находим сущность через entityAtCursor — встроенный метод mineflayer
  // который уже делает raycast по хитбоксам всех сущностей
  const entity = bot.entityAtCursor ? bot.entityAtCursor(maxDistance) : null;
  if (entity) {
    bot._client.write('use_entity', {
      target: entity.id,
      mouse: 1,        // 1 = attack
      sneaking: false,
    });
    bot._client.write('arm_animation', { hand: 0 });
    return;
  }

  // Нет сущности — просто свинг
  bot._client.write('arm_animation', { hand: 0 });
}

export function customSwingArm(bot, arm = 'right', showHand = true) {
  if (!bot?._client) return;
  const hand = arm === 'right' ? 0 : 1;
  const packet = {};
  if (showHand) packet.hand = hand;
  bot._client.write('arm_animation', packet);
}
