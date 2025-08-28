const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// Создаем приложение Express
const app = express();

app.get('/api/test', (req, res) => {
  res.send('Тестовый роут работает!');
});

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5500',
    'http://localhost:3000',
    'http://localhost',
    'https://allcase-mds-c073.twc1.net',
    'http://allcase-mds-c073.twc1.net'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.options('*', cors());
app.use(express.json());

// Логгирование всех запросов
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// Конфигурация SSL для PostgreSQL
const sslConfig = process.env.DB_SSL === 'true' ? {
  rejectUnauthorized: false  // Временно отключаем строгую проверку
} : false;

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: sslConfig
});

// Более надежная проверка подключения к БД
const checkDatabaseConnection = async () => {
  try {
    const client = await pool.connect();
    console.log('Успешное подключение к облачной БД');
    client.release();
    return true;
  } catch (error) {
    console.error('Ошибка подключения к БД:', error.message);

    // Проверяем, связана ли ошибка с SSL
    if (error.message.includes('SSL')) {
      console.error('Проблема с SSL подключением. Убедитесь, что:');
      console.error('1. SSL сертификат правильно загружен');
      console.error('2. Настройки SSL в коде корректны');
      console.error('3. БД разрешает SSL подключения');
    }

    return false;
  }
};

// Запускаем проверку подключения
checkDatabaseConnection().then(isConnected => {
  if (!isConnected) {
    console.log('Приложение запустится без подключения к БД');
  }
});

// Диагностика временных зон
console.log(`Текущее время сервера (UTC): ${new Date()}`);
console.log(`Текущее время MSK: ${new Date(Date.now() + 3 * 60 * 60 * 1000)}`);
pool.query("SELECT CURRENT_TIMESTAMP AT TIME ZONE 'Europe/Moscow' AS msk_time", (err, res) => {
  if (err) console.error('Ошибка запроса времени БД:', err);
  else console.log('Время БД (MSK):', res.rows[0].msk_time);
});

// Проверка временной зоны в PostgreSQL
pool.query('SELECT current_setting(\'TIMEZONE\') as tz', (err, res) => {
  if (err) {
    console.error('Ошибка проверки временной зоны PostgreSQL:', err);
  } else {
    console.log(`Временная зона PostgreSQL: ${res.rows[0].tz}`);
  }
});

// Проверка временной зоны в PostgreSQL
pool.query('SELECT current_setting(\'TIMEZONE\') as tz', (err, res) => {
  if (err) {
    console.error('Ошибка проверки временной зоны PostgreSQL:', err);
  } else {
    console.log(`Временная зона PostgreSQL: ${res.rows[0].tz}`);
  }
});

// Константы для JWT
const JWT_SECRET = process.env.JWT_SECRET || 'your_very_strong_secret_here';

// ==================================================================
// Middleware для аутентификации
// ==================================================================
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Неверный токен' });
    }

    req.user = user;
    next();
  });
}

// Добавьте этот endpoint в server.js
app.get('/', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Server is running',
    timestamp: new Date()
  });
});

// ==================================================================
// Health check endpoint
// ==================================================================
// Добавьте этот endpoint в ваш server.js
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date(),
    database: 'connected' // Добавьте проверку подключения к БД, если нужно
  });
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
      `SELECT * FROM users 
       WHERE email = $1 OR username = $1`,
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
    // Исправление: используем правильное название поля bio вместо about_me
    const user = await pool.query(
      `SELECT 
        id, username, email, full_name, created_at,
        phone, birth_date, city, bio AS about_me 
       FROM users WHERE id = $1`,
      [req.user.userId] // Важно: убедитесь, что здесь правильный ID
    );

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

    // Обновление данных (исправленный запрос)
    const result = await pool.query(
      `UPDATE users SET
        username = $1,
        email = $2,
        phone = $3,
        birth_date = $4,
        city = $5,
        bio = $6
      WHERE id = $7
      RETURNING 
        id, username, email, full_name, created_at,
        phone, birth_date, city, bio AS about_me`,
      [
        username,
        email,
        phone || null,
        birth_date || null,
        city || null,
        bio || null,
        userId
      ]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка обновления профиля:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Создание нового события (исправленная версия)
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
      organizer_id
    } = req.body;

    console.log(`Время события от клиента: ${event_time}`);

    // Функция конвертации времени
    const convertTimeToMsk = (timeStr) => {
      const [hours, minutes] = timeStr.split(':').map(Number);
      const date = new Date();
      date.setHours(hours);
      date.setMinutes(minutes);

      const mskOffset = 3 * 60 * 60 * 1000; // MSK UTC+3
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

    // Проверка существования организатора
    const organizerCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1',
      [organizer_id]
    );

    if (organizerCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Организатор не найден' });
    }

    // Вставляем событие в базу
    const result = await pool.query(
      `INSERT INTO events (
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
        organizer_id,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
      RETURNING id`,
      [
        title,
        description,
        event_date,
        event_time,
        sport_type,
        event_type,
        max_participants || null,
        price || 0,
        location,
        age_restriction || 0,
        organizer_id
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
    const { sport_type, date_from, date_to } = req.query;
    let query = `
      SELECT 
        id, title, description,
        event_date,
        event_time,
        sport_type, event_type,
        max_participants, price,
        location, age_restriction,
        organizer_id, status,
        TO_CHAR(
          created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow', 
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS created_at
      FROM events 
      WHERE status = $1`;
    const params = ['active'];

    if (sport_type) {
      query += ' AND sport_type = $2';
      params.push(sport_type);
    }

    if (date_from && date_to) {
      query += ` AND event_date BETWEEN $${params.length + 1} AND $${params.length + 2}`;
      params.push(date_from, date_to);
    }

    query += ' ORDER BY event_date, event_time LIMIT 50';

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
// Получение деталей события
// ==================================================================
app.get('/api/events/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT e.*, u.full_name AS organizer_name 
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
// Обновление события
// ==================================================================
app.put('/api/events/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const updateFields = req.body;

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
      return res.status(403).json({ error: 'Недостаточно прав для редактирования' });
    }

    // Формируем запрос на обновление
    const setClause = Object.keys(updateFields)
      .map((key, i) => `${key} = $${i + 2}`)
      .join(', ');

    const values = Object.values(updateFields);
    values.unshift(id);

    const query = `UPDATE events SET ${setClause} WHERE id = $1 RETURNING *`;

    const result = await pool.query(query, values);
    res.json(result.rows[0]);

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
    // Проверяем существование события
    const event = await pool.query(
      'SELECT id, max_participants FROM events WHERE id = $1',
      [id]
    );

    if (event.rows.length === 0) {
      return res.status(404).json({ error: 'Событие не найдено' });
    }

    // Проверяем количество участников
    const participants = await pool.query(
      'SELECT COUNT(*) FROM event_participants WHERE event_id = $1',
      [id]
    );

    const currentCount = parseInt(participants.rows[0].count);
    const maxCount = event.rows[0].max_participants;

    if (maxCount && currentCount >= maxCount) {
      return res.status(400).json({ error: 'Достигнуто максимальное количество участников' });
    }

    // Добавляем участника
    await pool.query(
      `INSERT INTO event_participants (event_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (event_id, user_id) DO NOTHING`,
      [id, userId]
    );

    res.json({ success: true, message: 'Вы успешно зарегистрировались на событие' });

  } catch (error) {
    console.error('Ошибка регистрации на событие:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ==================================================================
// Обработка 404 ошибок (добавьте этот middleware)
// ==================================================================
app.use((req, res) => {
  console.log(`⚠️ Маршрут не найден: ${req.method} ${req.url}`);
  res.status(404).json({ error: 'Ресурс не найден' });
});

// ==================================================================
// Запуск сервера
// ==================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});