# Use Ubuntu as base image for better package availability
FROM ubuntu:22.04

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js repository and necessary packages
RUN apt-get update && apt-get install -y \
    wget \
    gnupg2 \
    lsb-release \
    curl \
    ca-certificates \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y nodejs \
    && wget https://repo.percona.com/apt/percona-release_latest.generic_all.deb \
    && dpkg -i percona-release_latest.generic_all.deb \
    && percona-release enable-only tools \
    && apt-get update \
    && apt-get install -y percona-xtrabackup-80 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm percona-release_latest.generic_all.deb

# Create app directory
WORKDIR /app

# Install app dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY index.js ./

# Start the backup script
CMD ["node", "index.js"]