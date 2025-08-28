FROM node:18
RUN apt-get update && apt-get install -y iputils-ping curl
WORKDIR /usr/src/app
COPY backend/package*.json ./
RUN npm install
COPY backend/ ./
COPY frontend/ ./frontend/
EXPOSE 3000
# Добавьте в конец Dockerfile, перед CMD
RUN echo "=== Проверка структуры файлов ===" && \
    pwd && \
    ls -la && \
    echo "=== Содержимое папки frontend ===" && \
    ls -la frontend/ && \
    echo "=== Поиск index.html ===" && \
    find . -name "index.html" -type f

CMD ["node", "server.js"]