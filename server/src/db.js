const knex = require('knex');
const config = require('./config');

let db;
if (config.db.client === 'mysql2') {
  db = knex({
    client: 'mysql2',
    connection: {
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
    },
    pool: { min: 2, max: 10 },
  });
} else {
  db = knex({
    client: 'better-sqlite3',
    connection: { filename: config.db.file },
    useNullAsDefault: true,
  });
}

module.exports = db;
