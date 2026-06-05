const express = require('express');
const { YooCheckout } = require('yookassa');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const app = express();

// ═══════════════════════════════════════
// КОНФИГУРАЦИЯ
// ═══════════════════════════════════════
const CONFIG = {
  SHOP_ID: process.env.SHOP_ID || '1375640',
  SECRET_KEY: process.env.SECRET_KEY || 'live_bB3mWsOvqEXb444vfspJeLPI67G-6zSGlNVT9WEgWgQ',
  // URL твоей платформы на Netlify
  PLATFORM_URL: process.env.PLATFORM_URL || 'https://elaborate-kangaroo-eb193a.netlify.app',
  // URL этого сервера (заполнишь после деплоя на Railway)
  SERVER_URL: process.env.SERVER_URL || 'https://coachskill-backend.up.railway.app',
  // Email настройки (для отправки доступов ученикам)
  EMAIL_USER: process.env.EMAIL_USER || '',
  EMAIL_PASS: process.env.EMAIL_PASS || '',
};

// ЮKassa клиент
const checkout = new YooCheckout({
  shopId: CONFIG.SHOP_ID,
  secretKey: CONFIG.SECRET_KEY,
});

// ═══════════════════════════════════════
// ТАРИФЫ
// ═══════════════════════════════════════
const TARIFFS = {
  basic: {
    name: 'Базовый курс',
    price: '1990.00',
    plan: 'basic',
    description: 'Базовый курс по футбольной технике — 7 видеоуроков, доступ 6 месяцев'
  },
  advanced: {
    name: 'Продвинутый курс',
    price: '2990.00',
    plan: 'advanced',
    description: 'Продвинутый курс по футбольной технике — 9 видеоуроков, бессрочный доступ'
  },
  vip: {
    name: 'VIP курс',
    price: '3990.00',
    plan: 'vip',
    description: 'VIP курс — 16 видеоуроков + личная тренировка, бессрочный доступ'
  }
};

// Временная база пользователей (в продакшене нужна реальная БД)
const users = {};

app.use(cors());
app.use(express.json());

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

    const payment = await checkout.createPayment({
      amount: {
        value: tariffData.price,
        currency: 'RUB'
      },
      confirmation: {
        type: 'redirect',
        return_url: `${CONFIG.SERVER_URL}/payment/success?email=${encodeURIComponent(email)}&tariff=${tariff}`
      },
      description: tariffData.description,
      metadata: {
        tariff,
        email,
        name: name || 'Студент'
      },
      receipt: {
        customer: {
          email: email
        },
        items: [
          {
            description: tariffData.description,
            quantity: '1',
            amount: {
              value: tariffData.price,
              currency: 'RUB'
            },
            vat_code: '1',
            payment_mode: 'full_payment',
            payment_subject: 'service'
          }
        ]
      }
    }, idempotenceKey);

    res.json({
      success: true,
      paymentId: payment.id,
      confirmationUrl: payment.confirmation.confirmation_url
    });

  } catch (error) {
    console.error('Ошибка создания платежа:', error);
    res.status(500).json({ error: 'Ошибка создания платежа', details: error.message });
  }
});

// ═══════════════════════════════════════
// WEBHOOK ОТ ЮKASSA (автоматически после оплаты)
// ═══════════════════════════════════════
app.post('/webhook/yookassa', async (req, res) => {
  try {
    const event = req.body;
    console.log('Webhook получен:', event.event, event.object?.id);

    if (event.event === 'payment.succeeded') {
      const payment = event.object;
      const { tariff, email, name } = payment.metadata;

      // Генерируем пароль для ученика
      const password = generatePassword();

      // Сохраняем пользователя
      users[email] = {
        email,
        name: name || 'Студент',
        plan: tariff,
        planName: TARIFFS[tariff]?.name || tariff,
        password,
        createdAt: new Date().toISOString(),
        paymentId: payment.id
      };

      console.log(`✅ Новый ученик: ${email}, тариф: ${tariff}`);

      // Отправляем письмо с доступом
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

  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Оплата прошла успешно!</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          background: #111;
          color: #fff;
          font-family: 'Montserrat', sans-serif;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }
        .card {
          background: #1a1a1a;
          border: 1px solid rgba(26,144,224,0.3);
          border-radius: 24px;
          padding: 48px 40px;
          max-width: 480px;
          width: 100%;
          text-align: center;
        }
        .icon { font-size: 64px; margin-bottom: 24px; }
        h1 { font-size: 28px; font-weight: 900; margin-bottom: 12px; }
        p { color: #888; font-size: 15px; line-height: 1.6; margin-bottom: 8px; }
        .email { color: #1a90e0; font-weight: 700; }
        .btn {
          display: inline-block;
          background: #1a90e0;
          color: #fff;
          font-size: 15px;
          font-weight: 800;
          padding: 16px 40px;
          border-radius: 10px;
          text-decoration: none;
          margin-top: 28px;
        }
        .note {
          background: rgba(26,144,224,0.1);
          border: 1px solid rgba(26,144,224,0.2);
          border-radius: 12px;
          padding: 16px;
          margin-top: 24px;
          font-size: 13px;
          color: #aaa;
          text-align: left;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">🎉</div>
        <h1>Оплата прошла!</h1>
        <p>Ты приобрёл <strong>${tariffName}</strong></p>
        <p>Данные для входа отправлены на <span class="email">${email || 'твой email'}</span></p>
        <div class="note">
          📧 Проверь почту — там логин и пароль для входа в личный кабинет.<br>
          Если письмо не пришло в течение 5 минут — проверь папку «Спам».
        </div>
        <a href="${CONFIG.PLATFORM_URL}" class="btn">Войти в личный кабинет →</a>
      </div>
    </body>
    </html>
  `);
});

// ═══════════════════════════════════════
// API ПРОВЕРКИ ПОЛЬЗОВАТЕЛЯ (для платформы)
// ═══════════════════════════════════════
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;

  const user = users[email];
  if (user && user.password === password) {
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
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let password = '';
  for (let i = 0; i < 8; i++) {
    password += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return password;
}

async function sendAccessEmail(email, name, password, tariff) {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: CONFIG.EMAIL_USER,
        pass: CONFIG.EMAIL_PASS
      }
    });

    const tariffName = TARIFFS[tariff]?.name || tariff;

    await transporter.sendMail({
      from: `"CoachSkill" <${CONFIG.EMAIL_USER}>`,
      to: email,
      subject: '🎉 Доступ к курсу активирован — CoachSkill',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; background: #111; color: #fff; padding: 40px; border-radius: 16px;">
          <h1 style="color: #1a90e0; margin-bottom: 8px;">Добро пожаловать!</h1>
          <p style="color: #aaa;">Ты приобрёл ${tariffName}</p>
          
          <div style="background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 24px; margin: 24px 0;">
            <p style="color: #666; font-size: 12px; margin-bottom: 4px;">ДАННЫЕ ДЛЯ ВХОДА</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Пароль:</strong> <span style="color: #1a90e0; font-size: 20px; font-weight: bold;">${password}</span></p>
          </div>
          
          <a href="${CONFIG.PLATFORM_URL}" style="display: block; background: #1a90e0; color: #fff; text-align: center; padding: 16px; border-radius: 10px; text-decoration: none; font-weight: bold; margin-bottom: 24px;">
            Войти в личный кабинет →
          </a>
          
          <p style="color: #555; font-size: 13px;">Если есть вопросы — пиши в Telegram: @Nadirbekov_coach_skill</p>
        </div>
      `
    });

    console.log(`📧 Письмо отправлено на ${email}`);
  } catch (error) {
    console.error('Ошибка отправки письма:', error);
  }
}

// ═══════════════════════════════════════
// ЗАПУСК СЕРВЕРА
// ═══════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📦 Shop ID: ${CONFIG.SHOP_ID}`);
  console.log(`🌐 Platform URL: ${CONFIG.PLATFORM_URL}`);
});
