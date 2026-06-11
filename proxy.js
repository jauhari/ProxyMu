const { start } = require('./src/server');

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
