FROM node:18

RUN apt-get update && apt-get install -y iputils-ping curl

WORKDIR /usr/src/app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install

# Копируем исходный код
COPY . .

# Копируем SSL сертификат
COPY root.crt /app/root.crt

# Открываем порт
EXPOSE 3000

# Запускаем сервер
CMD ["node", "server.js"]