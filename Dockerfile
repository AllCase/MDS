FROM node:18

# Установка необходимых утилит
RUN apt-get update && apt-get install -y iputils-ping curl

# Создаем рабочую директорию
WORKDIR /app

# Копируем и устанавливаем зависимости backend
COPY backend/package*.json ./
RUN npm install

# Копируем код backend
COPY backend/ ./

# Копируем фронтенд
COPY frontend/ ./frontend/

# Скачиваем SSL сертификат для БД
RUN mkdir -p /app/certs && \
    curl -o /app/certs/root.crt "https://st.timeweb.com/cloud-static/ca.crt" && \
    chmod 0600 /app/certs/root.crt

# Открываем порт
EXPOSE 3000

# Запускаем сервер
CMD ["node", "server.js"]