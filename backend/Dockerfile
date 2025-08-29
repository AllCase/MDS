FROM node:18

RUN apt-get update && apt-get install -y iputils-ping curl

WORKDIR /usr/src/app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Скачиваем SSL сертификат для БД
RUN mkdir -p /app && \
    curl -o /app/root.crt "https://st.timeweb.com/cloud-static/ca.crt" && \
    chmod 0600 /app/root.crt

# Копируем backend код
COPY . .

# Копируем фронтенд из корневой директории
COPY ../frontend ./frontend

EXPOSE 3000

CMD ["node", "server.js"]