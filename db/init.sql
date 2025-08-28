CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true
);

-- Индексы для быстрого поиска
CREATE INDEX idx_users_username ON users (username);

CREATE INDEX idx_users_email ON users (email);

CREATE TABLE events (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    event_date DATE NOT NULL,
    event_time TIME NOT NULL,
    sport_type VARCHAR(50) NOT NULL CHECK (
        sport_type IN (
            'running',
            'cycling',
            'football',
            'basketball',
            'tennis',
            'volleyball',
            'swimming',
            'yoga'
        )
    ),
    event_type VARCHAR(50) NOT NULL CHECK (
        event_type IN (
            'training',
            'competition',
            'tournament',
            'friendly',
            'marathon',
            'workshop'
        )
    ),
    max_participants INTEGER,
    price NUMERIC(10, 2) DEFAULT 0.00,
    location TEXT NOT NULL,
    age_restriction INTEGER DEFAULT 0,
    organizer_id INTEGER NOT NULL REFERENCES users (id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active' CHECK (
        status IN (
            'active',
            'draft',
            'cancelled',
            'completed'
        )
    )
);

ALTER DATABASE myapp_db SET timezone TO 'Europe/Moscow';

ALTER TABLE users
ADD COLUMN phone VARCHAR(20),
ADD COLUMN birth_date DATE,
ADD COLUMN city VARCHAR(100),
ADD COLUMN bio TEXT;