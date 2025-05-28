# Use the official Rust image as the base
FROM rust:1.77-bullseye

# Install system dependencies for Tauri
RUN apt-get update && \
    apt-get install -y libwebkit2gtk-4.0-dev libgtk-3-dev libayatana-appindicator3-dev \
    librsvg2-dev curl build-essential && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js (LTS) and npm
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm@latest

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json first for caching
COPY package.json package-lock.json ./

# Install frontend dependencies
RUN npm install

# Copy the rest of the app
COPY . .

# Install Tauri CLI globally
RUN npm install -g @tauri-apps/cli

# Expose the Tauri dev port
EXPOSE 1420

# Default command: run Tauri dev
CMD ["npx", "tauri", "dev"] 