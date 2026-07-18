// api/telegram.js
// Serverless-функция для Vercel. Telegram будет присылать сюда сообщения (webhook).
// Бот принимает фото товара с подписью "Название | Цена | Категория"
// и сам добавляет товар в index.html через GitHub API.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO; // например niviv01/sport-style-landing
  const ALLOWED_IDS = (process.env.ALLOWED_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const body = req.body;
  const message = body && body.message;
  if (!message) {
    return res.status(200).send('ok');
  }

  const chatId = message.chat.id;
  const userId = String(message.from.id);

  const tgApi = (method, params) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

  // Проверка доступа
  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId)) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: '⛔ У вас нет доступа к загрузке товаров.',
    });
    return res.status(200).send('ok');
  }

  // Команда /start или /id — подсказка
  if (message.text === '/start' || message.text === '/id') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `Привет! Пришлите фото товара с подписью в формате:\n\n` +
        `Название | Цена | Категория\n\n` +
        `Например:\nКостюм спортивный синий | 1200 | мужские\n\n` +
        `Ваш Telegram ID: ${userId}`,
    });
    return res.status(200).send('ok');
  }

  if (!message.photo) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        'Пришлите ФОТО товара (не файлом, а как обычное фото) с подписью:\n' +
        'Название | Цена | Категория',
    });
    return res.status(200).send('ok');
  }

  const caption = message.caption || '';
  const parts = caption.split('|').map((s) => s.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: '⚠️ Не хватает данных. Формат подписи:\nНазвание | Цена | Категория',
    });
    return res.status(200).send('ok');
  }
  const [name, price, category = ''] = parts;

  try {
    await tgApi('sendMessage', { chat_id: chatId, text: '⏳ Загружаю товар, подождите...' });

    // 1. Берём фото в максимальном качестве (последнее в массиве)
    const photo = message.photo[message.photo.length - 1];
    const fileInfoRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${photo.file_id}`
    );
    const fileInfo = await fileInfoRes.json();
    const filePath = fileInfo.result.file_path;

    const fileRes = await fetch(
      `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`
    );
    const arrayBuffer = await fileRes.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString('base64');

    // 2. Забираем текущий index.html из GitHub
    const ghFileRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/index.html`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );
    if (!ghFileRes.ok) {
      throw new Error(`GitHub не отдал файл (${ghFileRes.status})`);
    }
    const ghFile = await ghFileRes.json();
    const sha = ghFile.sha;
    const content = Buffer.from(ghFile.content, 'base64').toString('utf-8');

    // 3. Формируем новый объект товара (тот же формат, что уже используется в PRODUCTS_DATA)
    const id = `product-${Date.now()}`;
    const newProduct = {
      id,
      img: base64Image,
      alt: name,
      titleRu: name,
      titleUa: name,
      metaRu: category,
      metaUa: category,
      price: `${price} ₴`,
    };
    const newProductJson = JSON.stringify(newProduct);

    // 4. Вставляем товар в начало массива PRODUCTS_DATA
    const marker = 'const PRODUCTS_DATA = [';
    const markerIndex = content.indexOf(marker);
    if (markerIndex === -1) {
      throw new Error('Не нашёл PRODUCTS_DATA в index.html');
    }
    const insertPos = markerIndex + marker.length;
    const updatedContent =
      content.slice(0, insertPos) + newProductJson + ', ' + content.slice(insertPos);

    // 5. Коммитим обновлённый файл обратно в GitHub
    const updatedBase64 = Buffer.from(updatedContent, 'utf-8').toString('base64');
    const commitRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/index.html`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
        body: JSON.stringify({
          message: `Добавлен товар: ${name}`,
          content: updatedBase64,
          sha,
        }),
      }
    );

    if (!commitRes.ok) {
      const errText = await commitRes.text();
      throw new Error(`GitHub отклонил коммит: ${errText}`);
    }

    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `✅ Товар "${name}" добавлен! Сайт обновится через 30-60 секунд.`,
    });
  } catch (err) {
    console.error(err);
    await tgApi('sendMessage', {
      chat_id: chatId,
      text: `❌ Ошибка при добавлении товара: ${err.message}`,
    });
  }

  return res.status(200).send('ok');
}
