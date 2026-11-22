require('dotenv').config()

const { Client } = require('pg')

async function applyCustomIndexes() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  try {
    await client.connect()
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS invoices_user_invoice_live_unique
      ON invoices (user_id, invoice_number)
      WHERE workflow_status <> 'CANCELLED'
    `)
  } finally {
    await client.end()
  }
}

applyCustomIndexes().catch((error) => {
  process.stderr.write(`Could not apply custom invoice indexes: ${error.message}\n`)
  process.exitCode = 1
})
