FROM node:20-alpine

WORKDIR /app

# копируем package.json именно из app
COPY app/package.json app/package-lock.json* ./

RUN npm install --omit=dev

# копируем код приложения
COPY app/ .

EXPOSE 3000

CMD ["node", "index.js"]
