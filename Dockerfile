# Use Node.js 18 Alpine image for smaller size
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy application files
COPY . .

# Expose the port (default 3002 or PORT from env)
EXPOSE 3002

# Start the application
CMD ["npm", "start"]
