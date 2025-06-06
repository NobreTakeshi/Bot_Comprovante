# Use uma imagem base oficial do Node.js
FROM node:18-slim

# Instala as dependências necessárias para o Puppeteer/Chromium
RUN apt-get update && apt-get install -y \
    gconf-service \
    libasound2 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    ca-certificates \
    fonts-liberation \
    libappindicator1 \
    libnss3 \
    lsb-release \
    xdg-utils \
    wget \
    --no-install-recommends

# Define o diretório de trabalho dentro do contêiner
WORKDIR /app

# Copia os arquivos de gerenciamento de pacotes
COPY package.json ./
COPY package-lock.json ./

# Instala as dependências do projeto, incluindo puppeteer
RUN npm install --omit=dev && npm install puppeteer

# Copia o resto do código do seu bot para o diretório de trabalho
COPY . .

# Define o comando para iniciar o bot quando o contêiner rodar
CMD ["node", "index.js"]
