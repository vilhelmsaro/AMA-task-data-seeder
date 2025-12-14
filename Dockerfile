FROM node:20-alpine

# Enable corepack and prepare Yarn 4.12.0
RUN corepack enable && corepack prepare yarn@4.12.0 --activate

WORKDIR /app

# Copy package files and Yarn config
COPY package.json yarn.lock .yarnrc.yml ./

# Install all dependencies (including dev dependencies for development)
RUN yarn install --immutable

# Copy source code
COPY . .

# Create data and logs directories
RUN mkdir -p /app/data /app/logs

# Expose port
EXPOSE 3000

# Start the application in development mode with watch
CMD ["yarn", "start:dev"]

