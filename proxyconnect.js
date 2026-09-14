import { SocksClient } from 'socks';
import net from 'net';

function friendlyProxyError(err, proxy) {
  const base = `${proxy.type || 'socks5'}://${proxy.host}:${proxy.port}`;
  if (err.message?.includes('NotAllowed')) {
    return `Прокси ${base} отклонил именно это подключение (SOCKS5 "NotAllowed"). Рукопожатие и авторизация прошли успешно — прокси сознательно запрещает подключаться к этому хосту/порту по своим правилам. Обычно это значит: провайдер прокси блокирует нестандартные порты (например, 25565 у Minecraft), либо у него включена привязка к IP и твой текущий IP не в списке разрешённых. Нужно уточнить у провайдера прокси или попробовать другой прокси/тариф.`;
  }
  if (err.code === 'ECONNRESET') {
    return `Прокси ${base} разорвал соединение во время рукопожатия (ECONNRESET). Обычно это значит: прокси мёртв/перегружен, IP не разрешён (нужна IP-авторизация вместо логин/пароля), либо неверный тип прокси (socks5/socks4/http перепутаны).`;
  }
  if (err.code === 'ETIMEDOUT' || err.message?.includes('timed out') || err.message?.includes('Timeout')) {
    return `Прокси ${base} не ответил за отведённое время. Прокси недоступен или сеть его блокирует.`;
  }
  if (err.code === 'ECONNREFUSED') {
    return `Прокси ${base} отказал в соединении (порт закрыт/неверный порт).`;
  }
  if (err.message?.includes('authentication') || err.message?.includes('auth')) {
    return `Прокси ${base} отклонил авторизацию — проверь логин/пароль.`;
  }
  return `Прокси ${base}: ${err.message}`;
}

async function connectSocks(proxy, targetHost, targetPort, attempt = 1) {
  const socksType = proxy.type === 'socks4' ? 4 : 5;
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: parseInt(proxy.port) || 1080,
        type: socksType,
        ...(proxy.username ? { userId: proxy.username } : {}),
        ...(proxy.password ? { password: proxy.password } : {}),
      },
      command: 'connect',
      destination: { host: targetHost, port: parseInt(targetPort) },
      timeout: 15000,
    });
    return socket;
  } catch (err) {
    // ECONNRESET/таймаут часто разовый глюк прокси — пробуем ещё раз перед тем как сдаться
    if (attempt < 2 && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT')) {
      await new Promise(r => setTimeout(r, 1500));
      return connectSocks(proxy, targetHost, targetPort, attempt + 1);
    }
    throw new Error(friendlyProxyError(err, proxy));
  }
}

export async function createProxyStream(proxy, targetHost, targetPort) {
  if (!proxy || !proxy.host) return null;

  const type = proxy.type || 'socks5';

  if (type === 'socks5' || type === 'socks4') {
    return connectSocks(proxy, targetHost, targetPort);
  }

  if (type === 'http') {
    return new Promise((resolve, reject) => {
      const auth = proxy.username
        ? 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64')
        : null;

      const req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`;
      const socket = net.connect(parseInt(proxy.port) || 8080, proxy.host, () => {
        socket.write(req);
      });
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(friendlyProxyError({ code: 'ETIMEDOUT' }, proxy)));
      }, 15000);
      socket.once('data', (data) => {
        clearTimeout(timeout);
        if (data.toString().includes('200')) resolve(socket);
        else reject(new Error('HTTP-прокси отклонил CONNECT: ' + data.toString().split('\r\n')[0]));
      });
      socket.once('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(friendlyProxyError(err, proxy)));
      });
    });
  }

  throw new Error('Неизвестный тип прокси: ' + type);
}

/** Полный тест: реальное SOCKS/HTTP-рукопожатие через прокси до внешнего хоста (не просто TCP до самого прокси) */
export async function testProxyTunnel(proxy, testHost = 'connectivitycheck.gstatic.com', testPort = 80) {
  try {
    const socket = await createProxyStream(proxy, testHost, testPort);
    socket.destroy();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}