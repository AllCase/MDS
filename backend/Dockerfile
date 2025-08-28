FROM node:18

# Установка сетевых утилит для диагностики
RUN apt-get update && apt-get install -y iputils-ping curl

# Рабочая директория
WORKDIR /usr/src/app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем исходный код бэкенда
COPY . .

# Диагностика (оставьте только для отладки, в продакшене можно убрать)
RUN echo "=== Проверка структуры файлов ===" && \
    pwd && \
    ls -la

# Открываем порт
EXPOSE 3000

# Запускаем сервер
CMD ["node", "server.js"]