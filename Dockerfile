# Use uma imagem base oficial do Node.js
FROM node:18-slim

# Instala as dependências de sistema necessárias para o Chromium
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    gconf-service \
    libappindicator1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libgconf-2-4 \
    libgdk-pixbuf2.0-0 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
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
    lsb-release \
    wget \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Define o diretório de trabalho dentro do ambiente
WORKDIR /app

# Copia os arquivos de dependência
COPY package.json ./
COPY package-lock.json ./

# Instala as dependências do Node.js e o Puppeteer
RUN npm ci && npm install whatsapp-web.js@1.23.0 qrcode-terminal puppeteer

# Copia o resto do código do seu bot
COPY . .

# --- PASSO DE DEPURAÇÃO ADICIONADO ---
# Lista os arquivos dentro de /app para vermos o que foi copiado.
RUN ls -la /app

# Define o comando para iniciar o bot
CMD ["node", "index.js"]
