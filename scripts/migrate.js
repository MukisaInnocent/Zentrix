const fs = require("node:fs/promises");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Pool } = require("pg");

async function migrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set before running migrations.");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined
  });

  try {
    const schema = await fs.readFile(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
    await pool.query(schema);
    console.log("Database schema is up to date.");
  } finally {
    await pool.end();
  }
}

migrate().catch(error => {
  console.error("Database migration failed:", error.message);
  process.exitCode = 1;
});
