FROM node:14
ADD package.json /app/package.json
WORKDIR /app
RUN npm install
ADD . /app
CMD node index.js
