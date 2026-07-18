// api/telegram.js
// Serverless-функция для Vercel. Telegram присылает сюда сообщения (webhook).
// Бот принимает фото товара и текст "Название | Цена | Категория" —
// они могут прийти вместе (подписью к фото) или двумя отдельными сообщениями.
// Пока не хватает второй части — данные временно хранятся в GitHub
// в служебной папке .bot-pending/ и удаляются после публикации товара.

const GH_API = 'https://api.github.com';

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };
}

async function getGithubFile(repo, token, path) {
  const res = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
    headers: ghHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} failed: ${res.status}`);
  const data = await res.json();
  return {
    sha: data.sha,
    content: Buffer.from(data.content, 'base64').toString('utf-8'),
  };
}

async function putGithubFile(repo, token, path, contentStr, sha, message) {
  const res = await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: ghHeaders(token),
    body: JSON.stringify({
      message,
      content: Buffer.from(contentStr, 'utf-8').toString('base64'),
      sha: sha || undefined,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub PUT ${path} failed: ${errText}`);
  }
  return res.json();
}

async function deleteGithubFile(repo, token, path, sha, message) {
  await fetch(`${GH_API}/repos/${repo}/contents/${path}`, {
    method: 'DELETE',
    headers: ghHeaders(token),
    body: JSON.stringify({ message, sha }),
  });
}

function parseCaption(text) {
  const parts = (text || '').split('|').map((s) => s.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  const [name, price, category = ''] = parts;
  return { name, price, category };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('Bot is running');
  }

  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const GITHUB_REPO = process.env.GITHUB_REPO;
  const ALLOWED_IDS = (process.env.ALLOWED_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const body = req.body;
  const message = body && body.message;
  if (!message) return res.status(200).send('ok');

  const chatId = message.chat.id;
  const userId = String(message.from.id);

  const tgApi = (method, params) =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });

  if (ALLOWED_IDS.length > 0 && !ALLOWED_IDS.includes(userId)) {
    await tgApi('sendMessage', { chat_id: chatId, text: '⛔ У вас нет доступа к загрузке товаров.' });
    return res.status(200).send('ok');
  }

  if (message.text === '/start' || message.text === '/id') {
    await tgApi('sendMessage', {
      chat_id: chatId,
      text:
        `Привет! Пришлите фото товара с подписью в формате:\n\n` +
        `Название | Цена | Категория\n\n` +
        `Фото и текст можно прислать вместе (подписью к фото) или ` +
        `по отдельности — двумя сообщениями, в любом порядке.\n\n` +
        `Ваш Telegram ID: ${userId}`,
    });
    return res.status(200).send('ok');
  }

  const pendingPath = `.bot-pending/${userId}.json`;

  try {
    // ===== Пришло фото =====
    if (message.photo) {
      const caption = message.caption ? parseCaption(message.caption) : null;

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

      if (caption) {
        await publishProduct(tgApi, chatId, { ...caption, img: base64Image }, GITHUB_REPO, GITHUB_TOKEN, pendingPath);
        return res.status(200).send('ok');
      }

      const pending = await getGithubFile(GITHUB_REPO, GITHUB_TOKEN, pendingPath);
      if (pending) {
        const data = JSON.parse(pending.content);
        if (data.type === 'text') {
          await publishProduct(
            tgApi,
            chatId,
            { name: data.name, price: data.price, category: data.category, img: base64Image },
            GITHUB_REPO,
            GITHUB_TOKEN,
            pendingPath,
            pending.sha
          );
          return res.status(200).send('ok');
        }
      }

      await putGithubFile(
        GITHUB_REPO,
        GITHUB_TOKEN,
        pendingPath,
        JSON.stringify({ type: 'photo', img: base64Image, ts: Date.now() }),
        pending ? pending.sha : null,
        'bot: сохранено фото, ожидание текста'
      );
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '📸 Фото получено! Теперь пришлите текст в формате:\nНазвание | Цена | Категория',
      });
      return res.status(200).send('ok');
    }

    // ===== Пришёл текст (не команда) =====
    if (message.text) {
      const parsed = parseCaption(message.text);
      if (!parsed) {
        await tgApi('sendMessage', {
          chat_id: chatId,
          text: 'Пришлите фото товара и/или текст в формате:\nНазвание | Цена | Категория',
        });
        return res.status(200).send('ok');
      }

      const pending = await getGithubFile(GITHUB_REPO, GITHUB_TOKEN, pendingPath);
      if (pending) {
        const data = JSON.parse(pending.content);
        if (data.type === 'photo') {
          await publishProduct(
            tgApi,
            chatId,
            { ...parsed, img: data.img },
            GITHUB_REPO,
            GITHUB_TOKEN,
            pendingPath,
            pending.sha
          );
          return res.status(200).send('ok');
        }
      }

      await putGithubFile(
        GITHUB_REPO,
        GITHUB_TOKEN,
        pendingPath,
        JSON.stringify({ type: 'text', ...parsed, ts: Date.now() }),
        pending ? pending.sha : null,
        'bot: сохранён текст, ожидание фото'
      );
      await tgApi('sendMessage', {
        chat_id: chatId,
        text: '📝 Текст получен! Теперь пришлите фото товара.',
      });
      return res.status(200).send('ok');
    }

    await tgApi('sendMessage', {
      chat_id: chatId,
      text: 'Пришлите фото товара и/или текст в формате:\nНазвание | Цена | Категория',
    });
    return res.status(200).send('ok');
  } catch (err) {
    console.error(err);
    await tgApi('sendMessage', { chat_id: chatId, text: `❌ Ошибка: ${err.message}` });
    return res.status(200).send('ok');
  }
}

async function publishProduct(tgApi, chatId, item, repo, token, pendingPath, pendingSha) {
  await tgApi('sendMessage', { chat_id: chatId, text: '⏳ Добавляю товар, подождите...' });

  const { name, price, category, img } = item;

  const ghFile = await getGithubFile(repo, token, 'index.html');
  if (!ghFile) throw new Error('index.html не найден в репозитории');

  const id = `product-${Date.now()}`;
  const newProduct = {
    id,
    img,
    alt: name,
    titleRu: name,
    titleUa: name,
    metaRu: category,
    metaUa: category,
    price: `${price} ₴`,
  };
  const newProductJson = JSON.stringify(newProduct);

  const marker = 'const PRODUCTS_DATA = [';
  const markerIndex = ghFile.content.indexOf(marker);
  if (markerIndex === -1) throw new Error('Не нашёл PRODUCTS_DATA в index.html');

  const insertPos = markerIndex + marker.length;
  const updatedContent =
    ghFile.content.slice(0, insertPos) + newProductJson + ', ' + ghFile.content.slice(insertPos);

  await putGithubFile(repo, token, 'index.html', updatedContent, ghFile.sha, `Добавлен товар: ${name}`);

  if (pendingSha) {
    await deleteGithubFile(repo, token, pendingPath, pendingSha, 'bot: очистка после публикации');
  }

  await tgApi('sendMessage', {
    chat_id: chatId,
    text: `✅ Товар "${name}" добавлен! Сайт обновится через 30-60 секунд.`,
  });
}
