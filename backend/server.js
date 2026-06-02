const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// Создаем приложение Express
const app = express();

// Конфигурация SSL для PostgreSQL
const sslConfig = process.env.DB_SSL === 'true' ? {
  rejectUnauthorized: true,
  ca: fs.readFileSync('/app/certs/root.crt').toString()
} : false;

const pool = new Pool({
  user: process.env.DB_USER || 'gen_user',
  host: process.env.DB_HOST || '5.129.196.67',
  database: process.env.DB_NAME || 'default_db',
  password: process.env.DB_PASSWORD || '+l-1)I2{yeFB@X',
  port: process.env.DB_PORT || 5432,
  ssl: sslConfig
});

// Обновление статуса завершённых событий
async function markCompletedEvents() {
  try {
    const result = await pool.query(
      `UPDATE events SET status = 'completed'
       WHERE status = 'active'
         AND (event_date + event_time::time + interval '3 hours') <= NOW() AT TIME ZONE 'Europe/Moscow'`
    );
    if (result.rowCount > 0) {
      console.log(`${result.rowCount} событий помечены как completed`);
    }
  } catch (error) {
    console.error('Ошибка при обновлении завершённых событий:', error);
  }
}

// Вспомогательная функция для создания уведомлений (без дубликатов)
async function createNotification(userId, eventId, type, message) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, event_id, type, message)
       VALUES ($1, $2, $3, $4)`,
      [userId, eventId, type, message]
    );
  } catch (error) {
    console.error('Ошибка создания уведомления:', error);
  }
}

// Подключаем middleware
app.use(cors({
  origin: [
    'https://allcase-mds-c073.twc1.net',
    'http://localhost:5500',
    'http://localhost:3000',
    'http://localhost'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

// Явная обработка preflight запросов
app.options('*', cors());

// Обработка preflight запросов
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.header('Access-Control-Allow-Origin', 'https://allcase-mds-c073.twc1.net');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.header('Access-Control-Allow-Credentials', 'true');
    return res.status(200).end();
  }
  next();
});

app.use(express.json());

// Логгирование всех запросов
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Константы для JWT
const JWT_SECRET = process.env.JWT_SECRET || 'your_very_strong_secret_here';

// ==================================================================
// Middleware для аутентификации
// ==================================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  console.log('Auth header:', authHeader);
  console.log('Token:', token);

  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error('JWT verification error:', err);
      return res.status(403).json({ error: 'Неверный токен' });
    }

    req.user = user;
    next();
  });
}

// ==================================================================
// API endpoints
// ==================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Test endpoint
app.get('/api/test', (req, res) => {
  res.send('Тестовый роут работает!');
});

// ==================================================================
// Проверка доступности имени пользователя
// ==================================================================
app.get('/api/check-username', async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ error: 'Имя пользователя не указано' });
  }

  try {
    const result = await pool.query(
      'SELECT 1 FROM users WHERE username = $1 LIMIT 1',
      [username]
    );

    res.json({ available: result.rows.length === 0 });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Регистрация пользователя
// ==================================================================
app.post('/api/register', async (req, res) => {
  const { username, email, password, full_name } = req.body;

  // Валидация
  if (!username || !email || !password || !full_name) {
    return res.status(400).json({ error: 'Все обязательные поля должны быть заполнены' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен содержать минимум 6 символов' });
  }

  // Валидация имени пользователя
  if (username.length > 20) {
    return res.status(400).json({ error: 'Имя пользователя не должно превышать 20 символов' });
  }
  if (/\s/.test(username)) {
    return res.status(400).json({ error: 'Имя пользователя не должно содержать пробелов' });
  }
  if (!/^[A-Za-z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Имя пользователя может содержать только латинские буквы, цифры и знак подчёркивания' });
  }

  try {
    // Проверка существующего пользователя
    const userExists = await pool.query(
      'SELECT 1 FROM users WHERE email = $1 OR username = $2 LIMIT 1',
      [email, username]
    );

    if (userExists.rows.length > 0) {
      const emailExists = await pool.query(
        'SELECT 1 FROM users WHERE email = $1 LIMIT 1',
        [email]
      );

      return res.status(400).json({
        error: emailExists.rows.length > 0
          ? 'Пользователь с таким email уже существует'
          : 'Это имя пользователя уже занято'
      });
    }

    // Хеширование пароля
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Сохранение пользователя
    const newUser = await pool.query(
      `INSERT INTO users (username, email, password_hash, full_name) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, username, email, full_name`,
      [username, email, passwordHash, full_name]
    );

    res.status(201).json({
      success: true,
      user: newUser.rows[0]
    });

  } catch (error) {
    console.error('Ошибка регистрации:', error);
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

// ==================================================================
// Аутентификация пользователя (вход)
// ==================================================================
app.post('/api/login', async (req, res) => {
  const { login, password } = req.body;

  if (!login || !password) {
    return res.status(400).json({ error: 'Все поля обязательны' });
  }

  try {
    // Ищем пользователя по email или username
    const user = await pool.query(
      `SELECT * FROM users WHERE email = $1`,
      [login]
    );

    if (user.rows.length === 0) {
      return res.status(401).json({ error: 'Неверные учетные данные' });
    }

    // Проверяем пароль
    const isValidPassword = await bcrypt.compare(
      password,
      user.rows[0].password_hash
    );

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Неверные учетные данные' });
    }

    // Генерируем JWT токен
    const token = jwt.sign(
      { userId: user.rows[0].id },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Отправляем успешный ответ
    res.json({
      success: true,
      token,
      user: {
        id: user.rows[0].id,
        username: user.rows[0].username,
        email: user.rows[0].email,
        full_name: user.rows[0].full_name
      }
    });

  } catch (error) {
    console.error('Ошибка входа:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Получение данных пользователя (защищенный роут)
// ==================================================================
app.get('/api/user', authenticateToken, async (req, res) => {
  try {
    console.log('User ID from token:', req.user.userId);

    const user = await pool.query(
      `SELECT 
        id, username, email, full_name, created_at,
        phone, birth_date, city, bio AS about_me 
       FROM users WHERE id = $1`,
      [req.user.userId]
    );

    console.log('User found:', user.rows[0]);

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json(user.rows[0]);
  } catch (error) {
    console.error('Ошибка получения данных:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Получение данных профиля
// ==================================================================
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const user = await pool.query(
      `SELECT 
                id, username, email, full_name, 
                phone, birth_date, city, bio
             FROM users WHERE id = $1`,
      [req.user.userId]
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    res.json(user.rows[0]);
  } catch (error) {
    console.error('Ошибка получения профиля:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Обновление данных профиля
// ==================================================================
app.put('/api/profile', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const { username, email, phone, birth_date, city, bio } = req.body;

  try {
    // Проверка уникальности только если поля изменяются
    if (username) {
      const currentUser = await pool.query(
        'SELECT username FROM users WHERE id = $1',
        [userId]
      );

      // Проверяем только если логин действительно меняется
      if (currentUser.rows[0].username !== username) {
        const userExists = await pool.query(
          'SELECT id FROM users WHERE username = $1 AND id != $2',
          [username, userId]
        );
        if (userExists.rows.length > 0) {
          return res.status(400).json({ error: 'Этот логин уже занят' });
        }
      }
    }

    if (email) {
      const currentUser = await pool.query(
        'SELECT email FROM users WHERE id = $1',
        [userId]
      );

      if (currentUser.rows[0].email !== email) {
        const emailExists = await pool.query(
          'SELECT id FROM users WHERE email = $1 AND id != $2',
          [email, userId]
        );
        if (emailExists.rows.length > 0) {
          return res.status(400).json({ error: 'Этот email уже используется' });
        }
      }
    }

    if (phone) {
      const phoneExists = await pool.query(
        'SELECT id FROM users WHERE phone = $1 AND id != $2',
        [phone, userId]
      );
      if (phoneExists.rows.length > 0) {
        return res.status(400).json({ error: 'Этот номер телефона уже используется другим пользователем' });
      }
    }

    if (birth_date) {
      const birthDateObj = new Date(birth_date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (birthDateObj > today) {
        return res.status(400).json({ error: 'Дата рождения не может быть в будущем' });
      }
      if (birthDateObj < new Date('1900-01-01')) {
        return res.status(400).json({ error: 'Некорректный год рождения (должен быть не ранее 1900)' });
      }
    }

    const result = await pool.query(
      `UPDATE users SET
    email = $1,
    phone = $2,
    birth_date = $3,
    city = $4,
    bio = $5
  WHERE id = $6
  RETURNING id, username, email, full_name, created_at, phone, birth_date, city, bio AS about_me`,
      [email, phone || null, birth_date || null, city || null, bio || null, userId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка обновления профиля:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Создание нового события (с валидацией даты)
// ==================================================================
app.post('/api/events', authenticateToken, async (req, res) => {
  console.log('✅ Запрос на создание события получен');

  try {
    const {
      title,
      description,
      event_date,
      event_time,
      sport_type,
      event_type,
      max_participants,
      price,
      location,
      age_restriction,
      organizer_display_type   // ← забираем здесь (один раз)
    } = req.body;

    console.log(`Время события от клиента: ${event_time}`);

    // ВАЛИДАЦИЯ ДАТЫ И ВРЕМЕНИ НА СЕРВЕРЕ
    const isValidDateTime = (eventDate, eventTime) => {
      const now = new Date();
      const eventDateTime = new Date(`${eventDate}T${eventTime}:00+03:00`);
      const mskOffset = 3 * 60 * 60 * 1000;
      const nowMsk = new Date(now.getTime() + mskOffset);

      return eventDateTime > nowMsk;
    };

    if (!isValidDateTime(event_date, event_time)) {
      return res.status(400).json({
        error: 'Нельзя создавать события в прошедшем времени'
      });
    }

    // Функция конвертации времени
    const convertTimeToMsk = (timeStr) => {
      const [hours, minutes] = timeStr.split(':').map(Number);
      const date = new Date();
      date.setHours(hours);
      date.setMinutes(minutes);

      const mskOffset = 3 * 60 * 60 * 1000;
      const mskTime = new Date(date.getTime() + mskOffset);

      return mskTime.toISOString().substring(11, 19);
    };

    const eventTimeMsk = convertTimeToMsk(event_time);
    console.log(`Конвертированное время события: ${eventTimeMsk}`);

    // Валидация обязательных полей
    const requiredFields = ['title', 'event_date', 'event_time', 'sport_type', 'event_type', 'location'];
    const missingFields = requiredFields.filter(field => !req.body[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: `Не заполнены обязательные поля: ${missingFields.join(', ')}`
      });
    }

    // Получаем данные текущего пользователя
    const userResult = await pool.query(
      'SELECT username, full_name FROM users WHERE id = $1',
      [req.user.userId]
    );
    const user = userResult.rows[0];
    const displayName = organizer_display_type === 'full_name' ? user.full_name : user.username;

    // Вставляем событие в базу
    const result = await pool.query(
      `INSERT INTO events (
        title, description, event_date, event_time, sport_type, event_type,
        max_participants, price, location, age_restriction, organizer_id, status, organizer_display_name
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12)
      RETURNING id`,
      [
        title, description, event_date, event_time, sport_type, event_type,
        max_participants || null, price || 0, location, age_restriction || 0,
        req.user.userId,   // ← организатор текущий пользователь
        displayName
      ]
    );

    console.log(`🆔 Событие создано с ID: ${result.rows[0].id}`);
    res.status(201).json({
      success: true,
      id: result.rows[0].id
    });

  } catch (error) {
    console.error('❌ Ошибка создания события:', error);
    res.status(500).json({ error: 'Ошибка сервера при создании события' });
  }
});

// ==================================================================
// Получение списка событий (ОБНОВЛЕННАЯ ВЕРСИЯ)
// ==================================================================
// 1. Создаем общую функцию обработки
const handleEventsRequest = async (req, res) => {
  console.log(`Обработка запроса событий: ${req.originalUrl}`);
  try {
    const { sport_type, date_from, date_to, search } = req.query;
    await markCompletedEvents();
    let query = `
      SELECT 
        e.id, e.title, e.description,
        e.event_date, e.event_time,
        e.sport_type, e.event_type,
        e.max_participants, e.price,
        e.location, e.age_restriction,
        e.organizer_id, e.status,
        TO_CHAR(e.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
        COALESCE(e.organizer_display_name, u.username) AS organizer_name,
        (SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id) AS participant_count
      FROM events e
      JOIN users u ON e.organizer_id = u.id
      WHERE e.status = $1`;
    const params = ['active'];
    let paramIndex = 2;

    if (sport_type) {
      query += ` AND e.sport_type = $${paramIndex}`;
      params.push(sport_type);
      paramIndex++;
    }

    if (date_from && date_to) {
      query += ` AND e.event_date BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      params.push(date_from, date_to);
      paramIndex += 2;
    }

    if (search && search.trim()) {
      query += ` AND e.title ILIKE $${paramIndex}`;
      params.push(`%${search.trim()}%`);
      paramIndex++;
    }

    query += ' ORDER BY e.event_date, e.event_time LIMIT 50';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения событий:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
};

// 2. Регистрируем оба варианта пути
app.get('/api/events', handleEventsRequest);   // Без слеша
app.get('/api/events/', handleEventsRequest);  // Со слешем

// ==================================================================
// Обновление события
// ==================================================================
app.put('/api/events/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  try {
    // 1. Проверяем, что пользователь — организатор
    const event = await pool.query(
      'SELECT * FROM events WHERE id = $1',
      [id]
    );

    if (event.rows.length === 0) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    if (event.rows[0].organizer_id !== userId) {
      return res.status(403).json({ error: 'Недостаточно прав для редактирования' });
    }

    const oldEvent = event.rows[0];

    // 2. Разрешённые поля для обновления (без organizer_display_type, его обработаем отдельно)
    const allowedFields = [
      'title', 'description', 'event_date', 'event_time',
      'sport_type', 'event_type', 'max_participants', 'price',
      'location', 'age_restriction'
    ];

    const updateFields = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateFields[field] = req.body[field];
      }
    }

    // Обработка display_type (если передан)
    if (req.body.organizer_display_type) {
      const userResult = await pool.query(
        'SELECT username, full_name FROM users WHERE id = $1',
        [userId]
      );
      const user = userResult.rows[0];
      updateFields.organizer_display_name =
        req.body.organizer_display_type === 'full_name' ? user.full_name : user.username;
      // в updateFields не добавляем organizer_display_type, только organizer_display_name
    }

    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({ error: 'Нет полей для обновления' });
    }

    // 3. Формируем и выполняем UPDATE
    const setClause = Object.keys(updateFields)
      .map((key, i) => `${key} = $${i + 2}`)
      .join(', ');

    const values = Object.values(updateFields);
    values.unshift(id);

    const query = `UPDATE events SET ${setClause} WHERE id = $1 RETURNING *`;
    const result = await pool.query(query, values);
    const updatedEvent = result.rows[0];

    // 4. Сравниваем старые и новые значения для уведомлений
    const changes = [];

    // Вспомогательная функция для форматирования даты/времени в читаемый вид
    const formatDateTime = (date, time) => {
      try {
        const d = new Date(date);
        if (isNaN(d.getTime())) return `${date} ${time}`;
        const dateStr = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
        return `${dateStr}, ${time?.substring(0, 5)}`;
      } catch {
        return `${date} ${time}`;
      }
    };

    // Сравнение заголовка
    if (updateFields.title !== undefined && updateFields.title !== oldEvent.title) {
      changes.push({
        type: 'event_updated_title',
        message: `Название изменено: "${oldEvent.title}" → "${updateFields.title}"`
      });
    }

    // Сравнение даты/времени – считаем за одно изменение, если что-то изменилось
    if (
      (updateFields.event_date !== undefined && updateFields.event_date !== oldEvent.event_date.toISOString().split('T')[0]) ||
      (updateFields.event_time !== undefined && updateFields.event_time !== oldEvent.event_time)
    ) {
      const oldDateTime = formatDateTime(oldEvent.event_date, oldEvent.event_time);
      const newDateTime = formatDateTime(
        updateFields.event_date || oldEvent.event_date,
        updateFields.event_time || oldEvent.event_time
      );
      changes.push({
        type: 'event_updated_datetime',
        message: `Дата и время изменены: ${oldDateTime} → ${newDateTime}`
      });
    }

    // Место проведения
    if (updateFields.location !== undefined && updateFields.location !== oldEvent.location) {
      changes.push({
        type: 'event_updated_location',
        message: `Место проведения изменено: "${oldEvent.location}" → "${updateFields.location}"`
      });
    }

    // Цена
    if (updateFields.price !== undefined && parseFloat(updateFields.price) !== parseFloat(oldEvent.price)) {
      const oldPrice = parseFloat(oldEvent.price);
      const newPrice = parseFloat(updateFields.price);
      let msg = '';
      if (oldPrice === 0 && newPrice > 0) {
        msg = `Мероприятие стало платным: стоимость участия ${newPrice.toFixed(2)} ₽`;
      } else if (oldPrice > 0 && newPrice === 0) {
        msg = `Мероприятие теперь бесплатное`;
      } else {
        msg = `Стоимость участия изменена: ${oldPrice.toFixed(2)} ₽ → ${newPrice.toFixed(2)} ₽`;
      }
      changes.push({ type: 'event_updated_price', message: msg });
    }

    // Максимум участников
    // Максимум участников
    if (updateFields.max_participants !== undefined) {
      const oldMax = oldEvent.max_participants ? Number(oldEvent.max_participants) : null;
      let newMax = updateFields.max_participants;
      if (newMax === '' || newMax === null || newMax === undefined) newMax = null;
      else newMax = Number(newMax);

      if (oldMax !== newMax) {
        const oldText = oldMax !== null ? oldMax : 'не ограничено';
        const newText = newMax !== null ? newMax : 'не ограничено';
        changes.push({
          type: 'event_updated_max_participants',
          message: `Максимальное количество участников изменено: ${oldText} → ${newText}`
        });
      }
    }

    // Возрастное ограничение
    if (updateFields.age_restriction !== undefined && updateFields.age_restriction !== oldEvent.age_restriction) {
      changes.push({
        type: 'event_updated_age',
        message: `Возрастное ограничение изменено: ${oldEvent.age_restriction || 0}+ → ${updateFields.age_restriction || 0}+`
      });
    }

    // Описание
    if (updateFields.description !== undefined && updateFields.description !== oldEvent.description) {
      changes.push({
        type: 'event_updated_description',
        message: `Описание мероприятия обновлено`
      });
    }

    // Тип спорта или тип события – одно общее уведомление
    if ((updateFields.sport_type !== undefined && updateFields.sport_type !== oldEvent.sport_type) ||
      (updateFields.event_type !== undefined && updateFields.event_type !== oldEvent.event_type)) {
      changes.push({
        type: 'event_updated_details',
        message: `Изменены детали мероприятия`
      });
    }

    // 5. Отправляем уведомления всем участникам, кроме организатора
    if (changes.length > 0) {
      const participants = await pool.query(
        'SELECT user_id FROM event_participants WHERE event_id = $1',
        [id]
      );

      for (const part of participants.rows) {
        if (part.user_id === userId) continue; // организатору не нужно
        for (const change of changes) {
          await createNotification(
            part.user_id,
            id,
            change.type,
            change.message
          );
        }
      }
    }

    // 6. Возвращаем обновлённое событие
    res.json(updatedEvent);
  } catch (error) {
    console.error('Ошибка обновления события:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Удаление события
// ==================================================================
app.delete('/api/events/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    // Проверяем, что пользователь является организатором
    const event = await pool.query(
      'SELECT organizer_id FROM events WHERE id = $1',
      [id]
    );

    if (event.rows.length === 0) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    if (event.rows[0].organizer_id !== req.user.userId) {
      return res.status(403).json({ error: 'Недостаточно прав для удаления' });
    }

    // Мягкое удаление (изменение статуса)
    await pool.query(
      "UPDATE events SET status = 'cancelled' WHERE id = $1",
      [id]
    );

    res.json({ success: true, message: 'Событие отменено' });

  } catch (error) {
    console.error('Ошибка удаления события:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Участие в событии
// ==================================================================
app.post('/api/events/:id/participate', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  try {
    // Проверяем существование события и его актуальность
    const event = await pool.query(
      `SELECT id, max_participants, event_date, event_time, status 
       FROM events WHERE id = $1`,
      [id]
    );

    if (event.rows.length === 0) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    const ev = event.rows[0];
    if (ev.status !== 'active') {
      return res.status(400).json({ error: 'Событие неактивно' });
    }

    // Проверяем, не началось ли уже событие (учитываем московское время UTC+3)
    // Берём только дату в формате YYYY-MM-DD и добавляем время события с московским смещением
    const eventDateOnly = ev.event_date instanceof Date
      ? ev.event_date.toISOString().split('T')[0]
      : String(ev.event_date).split('T')[0];
    const eventDateTime = new Date(`${eventDateOnly}T${ev.event_time}+03:00`);
    const now = new Date();
    if (eventDateTime <= now) {
      return res.status(400).json({ error: 'Нельзя зарегистрироваться на прошедшее событие' });
    }

    // Проверяем количество участников
    const participants = await pool.query(
      'SELECT COUNT(*) FROM event_participants WHERE event_id = $1',
      [id]
    );
    const currentCount = parseInt(participants.rows[0].count);
    if (ev.max_participants && currentCount >= ev.max_participants) {
      return res.status(400).json({ error: 'Достигнуто максимальное количество участников' });
    }

    // Добавляем участника
    await pool.query(
      `INSERT INTO event_participants (event_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (event_id, user_id) DO NOTHING`,
      [id, userId]
    );

    if (ev.max_participants && currentCount + 1 >= ev.max_participants) {
      const eventInfo = await pool.query('SELECT title, organizer_id FROM events WHERE id = $1', [id]);
      await createNotification(
        eventInfo.rows[0].organizer_id,
        id,
        'participants_limit_reached',
        `Набор участников на событие «${eventInfo.rows[0].title}» закрыт — достигнут лимит (${ev.max_participants}).`
      );
    }

    res.json({ success: true, message: 'Вы успешно зарегистрировались на событие' });
  } catch (error) {
    console.error('Ошибка регистрации на событие:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// ИСПРАВЛЕННЫЕ ENDPOINTS НА ОСНОВЕ ВАШЕЙ БД
// ==================================================================

app.get('/api/events/participating', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    await markCompletedEvents();
    const result = await pool.query(
      `SELECT e.*, COALESCE(e.organizer_display_name, u.username) AS organizer_name,
              (SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id) as participant_count
       FROM events e 
       JOIN event_participants ep ON e.id = ep.event_id 
       JOIN users u ON e.organizer_id = u.id
       WHERE ep.user_id = $1 AND e.status = 'active'
       ORDER BY e.event_date, e.event_time`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/events/organizing', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    await markCompletedEvents();
    const result = await pool.query(
      `SELECT e.*, COALESCE(e.organizer_display_name, u.username) AS organizer_name,
              (SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id) as participant_count
       FROM events e 
       JOIN users u ON e.organizer_id = u.id
       WHERE e.organizer_id = $1 AND e.status = 'active'
       ORDER BY e.event_date, e.event_time`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Получение прошедших мероприятий (ИСПРАВЛЕННАЯ ВЕРСИЯ)
app.get('/api/events/past', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    console.log('🔄 Запрос прошедших мероприятий для пользователя:', userId);
    await markCompletedEvents();
    const result = await pool.query(
      `SELECT 
        e.*, 
        COALESCE(e.organizer_display_name, u.username) AS organizer_name,
        (SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id) as participants_count,
        CASE 
          WHEN e.organizer_id = $1 THEN 'organizer'
          ELSE 'participant'
        END as user_role
       FROM events e
       JOIN users u ON e.organizer_id = u.id
       WHERE (e.organizer_id = $1 OR e.id IN (
         SELECT event_id FROM event_participants WHERE user_id = $1
       ))
       AND (e.event_date < CURRENT_DATE OR e.status IN ('completed', 'cancelled'))
       ORDER BY e.event_date DESC, e.event_time DESC`,
      [userId]
    );

    console.log('✅ Найдено прошедших мероприятий:', result.rows.length);
    res.json(result.rows);
  } catch (error) {
    console.error('❌ Ошибка получения прошедших мероприятий:', error);
    res.status(500).json({
      error: 'Ошибка сервера',
      message: error.message
    });
  }
});


// ==================================================================
// Получение деталей события
// ==================================================================
app.get('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await markCompletedEvents();
    const result = await pool.query(
      `SELECT e.*, COALESCE(e.organizer_display_name, u.username) AS organizer_name,
              (SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id) as participant_count
       FROM events e
       JOIN users u ON e.organizer_id = u.id
       WHERE e.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка получения события:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// ТЕСТОВЫЕ ENDPOINT'Ы ДЛЯ ДИАГНОСТИКИ
// ==================================================================

// Простой тест аутентификации
app.get('/api/test/auth', authenticateToken, async (req, res) => {
  try {
    res.json({
      success: true,
      message: 'Аутентификация работает',
      userId: req.user.userId
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка аутентификации', message: error.message });
  }
});

// Тест самого простого запроса к events
app.get('/api/test/events-simple', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, title FROM events LIMIT 5');
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка простого запроса', message: error.message });
  }
});

// Тест JOIN запроса
app.get('/api/test/events-join', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
            SELECT e.id, e.title, u.full_name 
            FROM events e 
            JOIN users u ON e.organizer_id = u.id 
            LIMIT 5
        `);
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка JOIN запроса', message: error.message });
  }
});

// Тест подзапроса
app.get('/api/test/events-subquery', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(`
            SELECT e.*, 
                   (SELECT COUNT(*) FROM event_participants ep WHERE ep.event_id = e.id) as participants_count
            FROM events e 
            LIMIT 5
        `);
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'Ошибка подзапроса', message: error.message });
  }
});

// Проверка подключения к БД
app.get('/api/debug/db-test', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT 1 as test');
    res.json({ success: true, message: 'База данных доступна', data: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/debug/user-events/:userId', authenticateToken, async (req, res) => {
  try {
    const userId = req.params.userId;

    // События как организатор (с именем организатора)
    const organizingResult = await pool.query(
      `SELECT e.*, COALESCE(e.organizer_display_name, u.username) AS organizer_name 
       FROM events e
       JOIN users u ON e.organizer_id = u.id
       WHERE e.organizer_id = $1`,
      [userId]
    );

    // События как участник (с именем организатора)
    const participatingResult = await pool.query(
      `SELECT e.*, COALESCE(e.organizer_display_name, u.username) AS organizer_name
       FROM events e
       JOIN event_participants ep ON e.id = ep.event_id
       JOIN users u ON e.organizer_id = u.id
       WHERE ep.user_id = $1`,
      [userId]
    );

    res.json({
      organizing: organizingResult.rows,
      participating: participatingResult.rows,
      organizingCount: organizingResult.rows.length,
      participatingCount: participatingResult.rows.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Простой тест структуры БД
app.get('/api/debug/tables', authenticateToken, async (req, res) => {
  try {
    const tablesResult = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
        `);

    res.json({ tables: tablesResult.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Отмена участия в событии
app.delete('/api/events/:id/participate', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;

  try {
    // Проверяем, участвует ли пользователь в событии
    const participation = await pool.query(
      'SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2',
      [id, userId]
    );

    if (participation.rows.length === 0) {
      return res.status(404).json({ error: 'Вы не участвуете в этом событии' });
    }

    // Удаляем участие
    await pool.query(
      'DELETE FROM event_participants WHERE event_id = $1 AND user_id = $2',
      [id, userId]
    );

    const eventInfo = await pool.query('SELECT title, organizer_id FROM events WHERE id = $1', [id]);
    const userInfo = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
    await createNotification(
      eventInfo.rows[0].organizer_id,
      id,
      'participant_left',
      `Пользователь @${userInfo.rows[0].username} отказался от участия в событии "${eventInfo.rows[0].title}".`
    );

    res.json({ success: true, message: 'Участие в событии отменено' });
  } catch (error) {
    console.error('Ошибка отмены участия в событии:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Отмена события с указанием причины (только организатор)
app.post('/api/events/:id/cancel', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  const { cancel_reason } = req.body; // причина из запроса

  try {
    // Проверяем, что пользователь является организатором
    const event = await pool.query(
      'SELECT organizer_id, status, title FROM events WHERE id = $1',
      [id]
    );

    if (event.rows.length === 0) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    if (event.rows[0].organizer_id !== userId) {
      return res.status(403).json({ error: 'Недостаточно прав для отмены' });
    }

    if (event.rows[0].status === 'cancelled') {
      return res.status(400).json({ error: 'Событие уже отменено' });
    }

    // Обновляем статус и сохраняем причину
    await pool.query(
      `UPDATE events SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`,
      [id, cancel_reason || null]
    );

    // Уведомляем всех участников об отмене
    const participants = await pool.query('SELECT user_id FROM event_participants WHERE event_id = $1', [id]);
    const title = event.rows[0].title; // event уже получен ранее
    for (const part of participants.rows) {
      await createNotification(
        part.user_id,
        id,
        'event_cancelled',
        `Событие «${title}» отменено организатором. Причина: ${cancel_reason || 'не указана'}`
      );
    }

    res.json({ success: true, message: 'Событие отменено' });
  } catch (error) {
    console.error('Ошибка отмены события:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Отзывы
// ==================================================================

// Создать отзыв
app.post('/api/reviews', authenticateToken, async (req, res) => {
  const { event_id, reviewee_id, rating, comment } = req.body;
  const reviewerId = req.user.userId;

  if (!event_id || !reviewee_id || !rating) {
    return res.status(400).json({ error: 'Необходимы event_id, reviewee_id и rating' });
  }
  if (rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Рейтинг должен быть от 1 до 5' });
  }
  if (reviewerId === reviewee_id) {
    return res.status(400).json({ error: 'Нельзя оставить отзыв самому себе' });
  }

  try {
    // Проверим, что событие завершено (дата прошла или статус completed/cancelled)
    const event = await pool.query('SELECT * FROM events WHERE id = $1', [event_id]);
    if (event.rows.length === 0) return res.status(404).json({ error: 'Событие не найдено' });

    const ev = event.rows[0];
    // Берём только дату в формате YYYY-MM-DD и добавляем время события с московским смещением
    const eventDateOnly = ev.event_date instanceof Date
      ? ev.event_date.toISOString().split('T')[0]
      : String(ev.event_date).split('T')[0];
    const eventDateTime = new Date(`${eventDateOnly}T${ev.event_time}+03:00`);
    const now = new Date();
    const isPast = eventDateTime <= now;
    const isTerminal = ['completed', 'cancelled'].includes(ev.status);
    if (!isPast && !isTerminal) {
      return res.status(400).json({ error: 'Нельзя оставить отзыв до завершения мероприятия' });
    }

    // Проверим, что reviewer_id и reviewee_id связаны с событием
    const isOrganizer = (ev.organizer_id === reviewerId);
    const isParticipantResp = await pool.query(
      'SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2',
      [event_id, reviewerId]
    );
    const isParticipant = isParticipantResp.rows.length > 0;

    if (!isOrganizer && !isParticipant) {
      return res.status(400).json({ error: 'Вы не являетесь участником или организатором этого события' });
    }

    // Определим допустимость: организатор → участник, участник → организатор
    if (isOrganizer) {
      // Организатор может оценить только участника (не себя)
      const targetIsParticipant = await pool.query(
        'SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2',
        [event_id, reviewee_id]
      );
      if (targetIsParticipant.rows.length === 0) {
        return res.status(400).json({ error: 'Вы можете оставить отзыв только участнику этого мероприятия' });
      }
    } else {
      // Участник может оценить только организатора
      if (ev.organizer_id !== reviewee_id) {
        return res.status(400).json({ error: 'Вы можете оставить отзыв только организатору этого мероприятия' });
      }
    }

    // Вставка
    await pool.query(
      `INSERT INTO reviews (event_id, reviewer_id, reviewee_id, rating, comment)
       VALUES ($1, $2, $3, $4, $5)`,
      [event_id, reviewerId, reviewee_id, rating, comment || null]
    );

    // Опционально: уведомление
    const reviewerInfo = await pool.query('SELECT username FROM users WHERE id = $1', [reviewerId]);
    const eventTitle = ev.title;
    await createNotification(
      reviewee_id,
      event_id,
      'new_review',
      `Вам оставили отзыв на событие "${eventTitle}" (${'⭐'.repeat(rating)})`
    );

    res.status(201).json({ success: true, message: 'Отзыв оставлен' });
  } catch (error) {
    if (error.code === '23505') { // unique violation
      return res.status(400).json({ error: 'Вы уже оставили отзыв этому пользователю за это событие' });
    }
    console.error('Ошибка создания отзыва:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Проверка возможности оставить отзыв
app.get('/api/reviews/check', authenticateToken, async (req, res) => {
  const { event_id, reviewee_id } = req.query;
  const reviewerId = req.user.userId;
  if (!event_id || !reviewee_id) {
    return res.status(400).json({ error: 'Укажите event_id и reviewee_id' });
  }
  try {
    // Уже есть отзыв?
    const existing = await pool.query(
      'SELECT 1 FROM reviews WHERE event_id = $1 AND reviewer_id = $2 AND reviewee_id = $3',
      [event_id, reviewerId, reviewee_id]
    );
    if (existing.rows.length > 0) {
      return res.json({ can_review: false, reason: 'Вы уже оставили отзыв' });
    }

    // Завершено ли событие?
    const event = await pool.query('SELECT * FROM events WHERE id = $1', [event_id]);
    if (event.rows.length === 0) return res.status(404).json({ error: 'Событие не найдено' });
    const ev = event.rows[0];
    // Берём только дату в формате YYYY-MM-DD и добавляем время события с московским смещением
    const eventDateOnly = ev.event_date instanceof Date
      ? ev.event_date.toISOString().split('T')[0]
      : String(ev.event_date).split('T')[0];
    const eventDateTime = new Date(`${eventDateOnly}T${ev.event_time}+03:00`);
    const now = new Date();
    if (eventDateTime > now && ev.status === 'active') {
      return res.json({ can_review: false, reason: 'Мероприятие ещё не завершилось' });
    }

    // Права
    const isOrganizer = (ev.organizer_id === reviewerId);
    const isParticipantResp = await pool.query(
      'SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2',
      [event_id, reviewerId]
    );
    const isParticipant = isParticipantResp.rows.length > 0;

    if (!isOrganizer && !isParticipant) {
      return res.json({ can_review: false, reason: 'Вы не участвовали в этом мероприятии' });
    }

    if (isOrganizer) {
      const target = await pool.query(
        'SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2',
        [event_id, reviewee_id]
      );
      if (target.rows.length === 0) {
        return res.json({ can_review: false, reason: 'Этот пользователь не является участником' });
      }
    } else {
      if (ev.organizer_id !== parseInt(reviewee_id)) {
        return res.json({ can_review: false, reason: 'Вы можете оставить отзыв только организатору' });
      }
    }

    return res.json({ can_review: true });
  } catch (error) {
    console.error('Ошибка проверки отзыва:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить отзывы о пользователе
app.get('/api/users/:userId/reviews', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      `SELECT r.*, u.username AS reviewer_username, e.title AS event_title
       FROM reviews r
       JOIN users u ON r.reviewer_id = u.id
       JOIN events e ON r.event_id = e.id
       WHERE r.reviewee_id = $1
       ORDER BY r.created_at DESC
       LIMIT 50`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения отзывов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Средний рейтинг пользователя
app.get('/api/users/:userId/rating', async (req, res) => {
  const { userId } = req.params;
  try {
    const result = await pool.query(
      'SELECT COALESCE(ROUND(AVG(rating), 1), 0) AS average_rating, COUNT(*) AS total_reviews FROM reviews WHERE reviewee_id = $1',
      [userId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка получения рейтинга:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получить список участников события
app.get('/api/events/:id/participants', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, u.full_name
       FROM event_participants ep
       JOIN users u ON ep.user_id = u.id
       WHERE ep.event_id = $1`,
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения участников:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Обслуживание статических файлов фронтенда
// ==================================================================
app.use(express.static(path.join(__dirname, 'frontend')));

// ==================================================================
// Уведомления
// ==================================================================

// Получить уведомления текущего пользователя (по умолчанию непрочитанные)
app.get('/api/notifications', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { unread_only } = req.query; // если 'true' – только непрочитанные
    let query = `SELECT n.*, e.title AS event_title FROM notifications n JOIN events e ON n.event_id = e.id WHERE n.user_id = $1`;
    const params = [userId];

    if (unread_only === 'true') {
      query += ' AND n.is_read = FALSE';
    }

    query += ' ORDER BY n.created_at DESC LIMIT 50';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения уведомлений:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Отметить уведомление как прочитанное
app.post('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;
    const result = await pool.query(
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2 RETURNING *',
      [id, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Уведомление не найдено' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка отметки уведомления:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Явная обработка корневого маршрута – отдаём welcome.html
// ==================================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'welcome.html'));
});

// ==================================================================
// Для всех остальных GET-запросов (кроме API) отдаём запрошенный файл или index.html
// ==================================================================
app.get('*', (req, res) => {
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  // Пытаемся найти запрошенный файл в папке frontend (например, aut.html, reg.html, welcome.html)
  const filePath = path.join(__dirname, 'frontend', req.path);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    res.sendFile(filePath);
  } else {
    // Всё остальное (включая index.html) отдаём как SPA-роутинг
    res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
  }
});

// ==================================================================
// Обработка 404 ошибок для API
// ==================================================================
app.use('/api/*', (req, res) => {
  console.log(`⚠️ API маршрут не найден: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'API endpoint not found' });
});

// ==================================================================
// Запуск сервера
// ==================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});