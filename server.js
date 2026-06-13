const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const { Pool } = require('pg');

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
  DATABASE_URL: process.env.DATABASE_URL || '',
};

const TARIFFS = {
  basic: { name: 'Базовый курс', price: '1990.00', description: 'Базовый курс по футбольной технике — 7 видеоуроков' },
  advanced: { name: 'Продвинутый курс', price: '2990.00', description: 'Продвинутый курс — 11 видеоуроков' },
  vip: { name: 'VIP курс', price: '3990.00', description: 'VIP курс — 18 видеоуроков + личная тренировка' }
};

// ═══════════════════════════════════════
// POSTGRESQL (NEON)
// ═══════════════════════════════════════
let pool = null;

async function connectDB() {
  if (!CONFIG.DATABASE_URL) {
    console.log('⚠️ DATABASE_URL не задан');
    return;
  }
  try {
    pool = new Pool({
      connectionString: CONFIG.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    // Создаём таблицу если не существует
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        name TEXT,
        plan TEXT,
        plan_name TEXT,
        password TEXT,
        created_at TEXT,
        payment_id TEXT
      )
    `);
    console.log('✅ PostgreSQL (Neon) подключена!');
  } catch (err) {
    console.error('❌ Ошибка БД:', err.message);
  }
}

async function getUser(email) {
  if (!pool) return null;
  try {
    const res = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (res.rows.length === 0) return null;
    const u = res.rows[0];
    return { email: u.email, name: u.name, plan: u.plan, planName: u.plan_name, password: u.password };
  } catch (err) {
    console.error('Ошибка getUser:', err.message);
    return null;
  }
}

async function saveUser(data) {
  if (!pool) return;
  try {
    await pool.query(`
      INSERT INTO users (email, name, plan, plan_name, password, created_at, payment_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (email) DO UPDATE SET
        name = $2, plan = $3, plan_name = $4, password = $5, created_at = $6, payment_id = $7
    `, [data.email, data.name, data.plan, data.planName, data.password, data.createdAt, data.paymentId || null]);
    console.log(`💾 Сохранён: ${data.email}`);
  } catch (err) {
    console.error('Ошибка saveUser:', err.message);
  }
}

async function updatePassword(email, newPassword) {
  if (!pool) return false;
  try {
    await pool.query('UPDATE users SET password = $1 WHERE email = $2', [newPassword, email]);
    return true;
  } catch (err) {
    console.error('Ошибка updatePassword:', err.message);
    return false;
  }
}

// ═══════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'CoachSkill сервер работает!', db: pool ? 'connected' : 'disconnected' });
});

// ═══════════════════════════════════════
// СОЗДАНИЕ ПЛАТЕЖА
// ═══════════════════════════════════════
app.post('/api/create-payment', async (req, res) => {
  try {
    const { tariff, name, email } = req.body;
    if (!tariff || !email) return res.status(400).json({ error: 'Укажите тариф и email' });
    const tariffData = TARIFFS[tariff];
    if (!tariffData) return res.status(400).json({ error: 'Неверный тариф' });

    const idempotenceKey = uuidv4();
    const credentials = Buffer.from(`${CONFIG.SHOP_ID}:${CONFIG.SECRET_KEY}`).toString('base64');
    const isEmail = email.includes('@');
    const customerData = isEmail ? { email } : { phone: email.replace(/\D/g, '').replace(/^8/, '7') };

    const response = await fetch('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json', 'Idempotence-Key': idempotenceKey },
      body: JSON.stringify({
        amount: { value: tariffData.price, currency: 'RUB' },
        confirmation: { type: 'redirect', return_url: `${CONFIG.SERVER_URL}/payment/success?email=${encodeURIComponent(email)}&tariff=${tariff}&name=${encodeURIComponent(name || '')}` },
        description: tariffData.description,
        metadata: { tariff, email, name: name || 'Студент' },
        receipt: { customer: customerData, items: [{ description: tariffData.description, quantity: '1.00', amount: { value: tariffData.price, currency: 'RUB' }, vat_code: 1, payment_mode: 'full_payment', payment_subject: 'service' }] }
      })
    });

    const payment = await response.json();
    if (payment.confirmation?.confirmation_url) {
      res.json({ success: true, paymentId: payment.id, confirmationUrl: payment.confirmation.confirmation_url });
    } else {
      console.error('ЮKassa:', JSON.stringify(payment));
      res.status(500).json({ error: 'Ошибка создания платежа', details: payment });
    }
  } catch (error) {
    console.error('Ошибка:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════
// WEBHOOK
// ═══════════════════════════════════════
app.post('/webhook/yookassa', async (req, res) => {
  try {
    const event = req.body;
    console.log('Webhook:', event.event);
    if (event.event === 'payment.succeeded') {
      const { tariff, email, name } = event.object.metadata;
      const password = generatePassword();
      await saveUser({ email, name: name || 'Студент', plan: tariff, planName: TARIFFS[tariff]?.name || tariff, password, createdAt: new Date().toISOString(), paymentId: event.object.id });
      console.log(`✅ Новый ученик: ${email}, пароль: ${password}`);
      if (CONFIG.EMAIL_USER) await sendAccessEmail(email, name, password, tariff);
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Ошибка webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════
// СТРАНИЦА УСПЕХА
// ═══════════════════════════════════════
app.get('/payment/success', (req, res) => {
  const { email, tariff } = req.query;
  const tariffName = TARIFFS[tariff]?.name || 'курс';
  res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Оплата успешна!</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700;900&display=swap" rel="stylesheet">
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#111;color:#fff;font-family:'Montserrat',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}.card{background:#1a1a1a;border:1px solid rgba(26,144,224,0.3);border-radius:24px;padding:48px 40px;max-width:480px;width:100%;text-align:center}.icon{font-size:64px;margin-bottom:24px}h1{font-size:28px;font-weight:900;margin-bottom:12px}p{color:#888;font-size:15px;line-height:1.6;margin-bottom:8px}.email{color:#1a90e0;font-weight:700}.btn{display:block;background:#1a90e0;color:#fff;font-size:15px;font-weight:800;padding:18px;border-radius:10px;text-decoration:none;margin-top:28px}.note{background:rgba(26,144,224,0.1);border:1px solid rgba(26,144,224,0.2);border-radius:12px;padding:16px;margin-top:24px;font-size:13px;color:#aaa;text-align:left;line-height:1.6}</style></head>
  <body><div class="card"><div class="icon">🎉</div><h1>Оплата прошла!</h1><p>Ты приобрёл <strong>${tariffName}</strong></p><p>Данные для входа отправлены на <span class="email">${email || 'твой email'}</span></p><div class="note">📧 Проверь почту — там логин и пароль.<br>Если не пришло за 5 минут — проверь папку «Спам».</div><a href="${CONFIG.PLATFORM_URL}" class="btn">Войти в личный кабинет →</a></div></body></html>`);
});

// ═══════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await getUser(email);
  if (user && user.password === password) {
    console.log(`🔑 Вход: ${email}`);
    res.json({ success: true, user: { email: user.email, name: user.name, plan: user.plan, planName: user.planName } });
  } else {
    res.status(401).json({ success: false, error: 'Неверный email или пароль' });
  }
});

// ═══════════════════════════════════════
// СМЕНА ПАРОЛЯ
// ═══════════════════════════════════════
app.post('/api/change-password', async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  const user = await getUser(email);
  if (!user) return res.status(404).json({ success: false, error: 'Пользователь не найден' });
  if (user.password !== currentPassword) return res.status(401).json({ success: false, error: 'Неверный текущий пароль' });
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ success: false, error: 'Пароль слишком короткий' });
  await updatePassword(email, newPassword);
  res.json({ success: true });
});

// ═══════════════════════════════════════
// ДОБАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯ ВРУЧНУЮ
// ═══════════════════════════════════════
app.post('/api/add-user', async (req, res) => {
  const { secret, email, name, tariff, password } = req.body;
  if (secret !== 'coachskill2024admin') return res.status(403).json({ error: 'Нет доступа' });
  const pwd = password || generatePassword();
  await saveUser({ email, name: name || 'Студент', plan: tariff || 'basic', planName: TARIFFS[tariff]?.name || 'Базовый курс', password: pwd, createdAt: new Date().toISOString() });
  console.log(`👤 Добавлен вручную: ${email}, пароль: ${pwd}`);
  res.json({ success: true, email, password: pwd });
});

// ═══════════════════════════════════════
// СПИСОК ПОЛЬЗОВАТЕЛЕЙ
// ═══════════════════════════════════════
app.get('/api/users/:secret', async (req, res) => {
  if (req.params.secret !== 'coachskill2024admin') return res.status(403).json({ error: 'Нет доступа' });
  if (!pool) return res.json({ count: 0, users: [] });
  const result = await pool.query('SELECT email, name, plan, plan_name, created_at FROM users');
  res.json({ count: result.rows.length, users: result.rows });
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
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: CONFIG.EMAIL_USER, pass: CONFIG.EMAIL_PASS } });
    const tariffName = TARIFFS[tariff]?.name || tariff;
    const telegramLinks = { basic: 'https://t.me/+6Rceqr0RF6U5Zjhi', advanced: 'https://t.me/+PldxnonFL8tiNzZi', vip: 'https://t.me/+PldxnonFL8tiNzZi' };
    await transporter.sendMail({
      from: `"CoachSkill" <${CONFIG.EMAIL_USER}>`,
      to: email,
      subject: '🎉 Доступ к курсу активирован — CoachSkill',
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#111;color:#fff;padding:40px;border-radius:16px;">
        <h1 style="color:#1a90e0;">Добро пожаловать, ${name || 'студент'}!</h1>
        <p style="color:#aaa;margin-bottom:20px;">Ты приобрёл ${tariffName}</p>
        <div style="background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:24px;margin:24px 0;">
          <p style="color:#666;font-size:12px;margin-bottom:12px;">ДАННЫЕ ДЛЯ ВХОДА</p>
          <p style="margin-bottom:8px;"><strong>Сайт:</strong> <a href="${CONFIG.PLATFORM_URL}" style="color:#1a90e0;">${CONFIG.PLATFORM_URL}</a></p>
          <p style="margin-bottom:8px;"><strong>Логин:</strong> ${email}</p>
          <p><strong>Пароль:</strong> <span style="color:#1a90e0;font-size:24px;font-weight:bold;letter-spacing:2px;">${password}</span></p>
        </div>
        <a href="${CONFIG.PLATFORM_URL}" style="display:block;background:#1a90e0;color:#fff;text-align:center;padding:16px;border-radius:10px;text-decoration:none;font-weight:bold;margin-bottom:20px;">🎓 Войти в личный кабинет →</a>
        <div style="background:#1a1a1a;border:1px solid rgba(26,144,224,0.3);border-radius:12px;padding:20px;margin-bottom:24px;">
          <p style="color:#aaa;font-size:14px;margin-bottom:12px;">📱 <strong style="color:#fff;">Вступи в закрытый чат учеников:</strong></p>
          <a href="${telegramLinks[tariff] || telegramLinks.basic}" style="display:block;background:rgba(26,144,224,0.15);color:#1a90e0;text-align:center;padding:14px;border-radius:8px;text-decoration:none;font-weight:bold;">Telegram чат → Нажми здесь</a>
        </div>
        <p style="color:#555;font-size:13px;">Вопросы? <a href="https://t.me/Nadirbekov_coach_skill" style="color:#1a90e0;">@Nadirbekov_coach_skill</a></p>
      </div>`
    });
    console.log(`📧 Письмо отправлено: ${email}`);
  } catch (err) {
    console.error('Ошибка email:', err.message);
  }
}

// ═══════════════════════════════════════
// ЗАПУСК
// ═══════════════════════════════════════
const PORT = process.env.PORT || 3000;
connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
    console.log(`🏪 Shop ID: ${CONFIG.SHOP_ID}`);
    console.log(`🗄️ БД: ${pool ? 'подключена' : 'не подключена'}`);
  });
});
