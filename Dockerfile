FROM node:20-alpine

WORKDIR /app

# 1. Копируем зависимости из КОРНЯ
COPY package.json package-lock.json* ./

# 2. Устанавливаем зависимости
RUN npm ci --omit=dev

# 3. Копируем весь проект
COPY . .

# 4. Render сам пробрасывает PORT
EXPOSE 3000

# 5. Запуск через npm start
CMD ["npm", "start"]
