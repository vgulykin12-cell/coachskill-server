const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();

// ═══════════════════════════════════════
// КОНФИГУРАЦИЯ
// ═══════════════════════════════════════
const CONFIG = {
  SHOP_ID: process.env.SHOP_ID || '1375640',
  SECRET_KEY: process.env.SECRET_KEY || 'live_bB3mWsOvqEXb444vfspJeLPI67G-6zSGlNVT9WEgWgQ',
  PLATFORM_URL: process.env.PLATFORM_URL || 'https://coachskillcourse.netlify.app',
  SERVER_URL: process.env.SERVER_URL || 'https://coachskill-server.onrender.com',
  EMAIL_USER: process.env.EMAIL_USER || '',
  EMAIL_PASS: process.env.EMAIL_PASS || '',
};

// ═══════════════════════════════════════
// ТАРИФЫ
// ═══════════════════════════════════════
const TARIFFS = {
  basic: {
    name: 'Базовый курс',
    price: '1990.00',
    description: 'Базовый курс по футбольной технике — 7 видеоуроков'
  },
  advanced: {
    name: 'Продвинутый курс',
    price: '2990.00',
    description: 'Продвинутый курс — 11 видеоуроков, бессрочный доступ'
  },
  vip: {
    name: 'VIP курс',
    price: '3990.00',
    description: 'VIP курс — 18 видеоуроков + личная тренировка'
  }
};

// ═══════════════════════════════════════
// БАЗА ДАННЫХ (файл users.json)
// ═══════════════════════════════════════
const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Ошибка загрузки users.json:', err);
  }
  return {};
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
    console.log(`💾 Сохранено пользователей: ${Object.keys(users).length}`);
  } catch (err) {
    console.error('Ошибка сохранения users.json:', err);
  }
}

// Загружаем пользователей при старте
let users = loadUsers();
console.log(`📂 Загружено пользователей из файла: ${Object.keys(users).length}`);

// ═══════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', cors());
app.use(express.json());

// Проверка что сервер работает
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'CoachSkill сервер работает!',
    users_count: Object.keys(users).length
  });
});

// ═══════════════════════════════════════
// СОЗДАНИЕ ПЛАТЕЖА
// ═══════════════════════════════════════
app.post('/api/create-payment', async (req, res) => {
  try {
    const { tariff, name, email } = req.body;

    if (!tariff || !email) {
      return res.status(400).json({ error: 'Укажите тариф и email' });
    }

    const tariffData = TARIFFS[tariff];
    if (!tariffData) {
      return res.status(400).json({ error: 'Неверный тариф' });
    }

    const idempotenceKey = uuidv4();
    const credentials = Buffer.from(`${CONFIG.SHOP_ID}:${CONFIG.SECRET_KEY}`).toString('base64');

    const isEmail = email.includes('@');
    const receiptEmail = isEmail ? email : CONFIG.EMAIL_USER;
    const customerData = isEmail
      ? { email: receiptEmail }
      : { phone: email.replace(/\D/g, '').replace(/^8/, '7') };

    const paymentData = {
      amount: { value: tariffData.price, currency: 'RUB' },
      confirmation: {
        type: 'redirect',
        return_url: `${CONFIG.SERVER_URL}/payment/success?email=${encodeURIComponent(email)}&tariff=${tariff}&name=${encodeURIComponent(name || '')}`
      },
      description: tariffData.description,
      metadata: { tariff, email, name: name || 'Студент' },
      receipt: {
        customer: customerData,
        items: [{
          description: tariffData.description,
          quantity: '1.00',
          amount: { value: tariffData.price, currency: 'RUB' },
          vat_code: 1,
          payment_mode: 'full_payment',
          payment_subject: 'service'
        }]
      }
    };

    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json',
        'Idempotence-Key': idempotenceKey
      },
      body: JSON.stringify(paymentData)
    });

    const payment = await response.json();

    if (payment.confirmation && payment.confirmation.confirmation_url) {
      res.json({
        success: true,
        paymentId: payment.id,
        confirmationUrl: payment.confirmation.confirmation_url
      });
    } else {
      console.error('ЮKassa ответ:', JSON.stringify(payment));
      res.status(500).json({ error: 'Ошибка создания платежа', details: payment });
    }

  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════
// WEBHOOK от ЮKassa
// ═══════════════════════════════════════
app.post('/webhook/yookassa', async (req, res) => {
  try {
    const event = req.body;
    console.log('Webhook:', event.event, event.object?.id);

    if (event.event === 'payment.succeeded') {
      const payment = event.object;
      const { tariff, email, name } = payment.metadata;

      const password = generatePassword();

      // Сохраняем в объект и файл
      users[email] = {
        email,
        name: name || 'Студент',
        plan: tariff,
        planName: TARIFFS[tariff]?.name || tariff,
        password,
        createdAt: new Date().toISOString(),
        paymentId: payment.id
      };
      saveUsers(users); // 💾 Сохраняем в файл

      console.log(`✅ Новый ученик: ${email}, тариф: ${tariff}, пароль: ${password}`);

      if (CONFIG.EMAIL_USER) {
        await sendAccessEmail(email, name, password, tariff);
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Ошибка webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════
// СТРАНИЦА УСПЕШНОЙ ОПЛАТЫ
// ═══════════════════════════════════════
app.get('/payment/success', (req, res) => {
  const { email, tariff } = req.query;
  const tariffName = TARIFFS[tariff]?.name || 'курс';

  res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Оплата успешна!</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700;900&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#111; color:#fff; font-family:'Montserrat',sans-serif; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
    .card { background:#1a1a1a; border:1px solid rgba(26,144,224,0.3); border-radius:24px; padding:48px 40px; max-width:480px; width:100%; text-align:center; }
    .icon { font-size:64px; margin-bottom:24px; }
    h1 { font-size:28px; font-weight:900; margin-bottom:12px; }
    p { color:#888; font-size:15px; line-height:1.6; margin-bottom:8px; }
    .email { color:#1a90e0; font-weight:700; }
    .btn { display:block; background:#1a90e0; color:#fff; font-size:15px; font-weight:800; padding:18px 40px; border-radius:10px; text-decoration:none; margin-top:28px; }
    .note { background:rgba(26,144,224,0.1); border:1px solid rgba(26,144,224,0.2); border-radius:12px; padding:16px; margin-top:24px; font-size:13px; color:#aaa; text-align:left; line-height:1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🎉</div>
    <h1>Оплата прошла!</h1>
    <p>Ты приобрёл <strong>${tariffName}</strong></p>
    <p>Данные для входа отправлены на <span class="email">${email || 'твой email'}</span></p>
    <div class="note">📧 Проверь почту — там логин и пароль для входа.<br>Если не пришло за 5 минут — проверь папку «Спам».</div>
    <a href="${CONFIG.PLATFORM_URL}" class="btn">Войти в личный кабинет →</a>
  </div>
</body>
</html>`);
});

// ═══════════════════════════════════════
// LOGIN API
// ═══════════════════════════════════════
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  // Перезагружаем пользователей из файла (на случай если были добавлены)
  users = loadUsers();

  const user = users[email];
  if (user && user.password === password) {
    console.log(`🔑 Вход: ${email}`);
    res.json({
      success: true,
      user: {
        email: user.email,
        name: user.name,
        plan: user.plan,
        planName: user.planName
      }
    });
  } else {
    res.status(401).json({ success: false, error: 'Неверный email или пароль' });
  }
});

// ═══════════════════════════════════════
// РУЧНОЕ ДОБАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯ (для случаев когда webhook не сработал)
// ═══════════════════════════════════════
app.post('/api/add-user', (req, res) => {
  const { secret, email, name, tariff, password } = req.body;

  // Простая защита
  if (secret !== 'coachskill2024admin') {
    return res.status(403).json({ error: 'Нет доступа' });
  }

  const pwd = password || generatePassword();
  users[email] = {
    email,
    name: name || 'Студент',
    plan: tariff || 'basic',
    planName: TARIFFS[tariff]?.name || 'Базовый курс',
    password: pwd,
    createdAt: new Date().toISOString(),
    addedManually: true
  };
  saveUsers(users);

  console.log(`👤 Добавлен вручную: ${email}, пароль: ${pwd}`);
  res.json({ success: true, email, password: pwd });
});

// ═══════════════════════════════════════
// СПИСОК ПОЛЬЗОВАТЕЛЕЙ (для Арсланбека)
// ═══════════════════════════════════════
app.get('/api/users/:secret', (req, res) => {
  if (req.params.secret !== 'coachskill2024admin') {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  users = loadUsers();
  const list = Object.values(users).map(u => ({
    email: u.email,
    name: u.name,
    plan: u.planName,
    createdAt: u.createdAt
  }));
  res.json({ count: list.length, users: list });
});

// ═══════════════════════════════════════
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({length: 8}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function sendAccessEmail(email, name, password, tariff) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: CONFIG.EMAIL_USER, pass: CONFIG.EMAIL_PASS }
    });

    const tariffName = TARIFFS[tariff]?.name || tariff;

    const telegramLinks = {
      basic: 'https://t.me/+6Rceqr0RF6U5Zjhi',
      advanced: 'https://t.me/+PldxnonFL8tiNzZi',
      vip: 'https://t.me/+PldxnonFL8tiNzZi'
    };
    const telegramLink = telegramLinks[tariff] || telegramLinks.basic;

    await transporter.sendMail({
      from: `"CoachSkill" <${CONFIG.EMAIL_USER}>`,
      to: email,
      subject: '🎉 Доступ к курсу активирован — CoachSkill',
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#111;color:#fff;padding:40px;border-radius:16px;">
          <h1 style="color:#1a90e0;">Добро пожаловать, ${name || 'студент'}!</h1>
          <p style="color:#aaa;margin-bottom:20px;">Ты приобрёл ${tariffName}</p>

          <div style="background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:24px;margin:24px 0;">
            <p style="color:#666;font-size:12px;margin-bottom:12px;letter-spacing:1px;">ДАННЫЕ ДЛЯ ВХОДА</p>
            <p style="margin-bottom:8px;"><strong>Сайт:</strong> <a href="${CONFIG.PLATFORM_URL}" style="color:#1a90e0;">${CONFIG.PLATFORM_URL}</a></p>
            <p style="margin-bottom:8px;"><strong>Логин:</strong> ${email}</p>
            <p><strong>Пароль:</strong> <span style="color:#1a90e0;font-size:24px;font-weight:bold;letter-spacing:2px;">${password}</span></p>
          </div>

          <a href="${CONFIG.PLATFORM_URL}" style="display:block;background:#1a90e0;color:#fff;text-align:center;padding:16px;border-radius:10px;text-decoration:none;font-weight:bold;margin-bottom:20px;">
            🎓 Войти в личный кабинет →
          </a>

          <div style="background:#1a1a1a;border:1px solid rgba(26,144,224,0.3);border-radius:12px;padding:20px;margin-bottom:24px;">
            <p style="color:#aaa;font-size:14px;margin-bottom:12px;">📱 <strong style="color:#fff;">Вступи в закрытый чат учеников:</strong></p>
            <a href="${telegramLink}" style="display:block;background:rgba(26,144,224,0.15);color:#1a90e0;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:bold;">
              Telegram чат → Нажми здесь
            </a>
          </div>

          <p style="color:#555;font-size:13px;">Вопросы? Пиши тренеру: <a href="https://t.me/Nadirbekov_coach_skill" style="color:#1a90e0;">@Nadirbekov_coach_skill</a></p>
        </div>`
    });

    console.log(`📧 Письмо отправлено: ${email}`);
  } catch (err) {
    console.error('Ошибка email:', err.message);
  }
}

// ═══════════════════════════════════════
// ЗАПУСК СЕРВЕРА
// ═══════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🏪 Shop ID: ${CONFIG.SHOP_ID}`);
  console.log(`👥 Пользователей в базе: ${Object.keys(users).length}`);
});
