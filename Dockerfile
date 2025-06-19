# Use an official Node.js runtime as a parent image
FROM node:18-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to the working directory
# This caches the npm install step if dependencies don't change
COPY package*.json ./

# Install any needed packages
RUN npm install

# Bundle app source
COPY . .

# Make your port available to the world outside this container
EXPOSE 8080

# Define the command to run your app
CMD [ "npm", "start" ]