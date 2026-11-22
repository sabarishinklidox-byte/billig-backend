require('dotenv').config()

const { PrismaClient } = require('../src/generated/client_v13')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function main() {
  const name = process.env.SEED_USER_NAME
  const email = process.env.SEED_USER_EMAIL?.trim().toLowerCase()
  const password = process.env.SEED_USER_PASSWORD

  if (!name || !email || !password) {
    throw new Error('Set SEED_USER_NAME, SEED_USER_EMAIL, and SEED_USER_PASSWORD in backen/.env before seeding.')
  }
  if (password.length < 12) {
    throw new Error('SEED_USER_PASSWORD must be at least 12 characters long.')
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const user = await prisma.user.upsert({
    where: { email },
    update: { name, passwordHash },
    create: { name, email, passwordHash },
    select: { id: true, name: true, email: true, createdAt: true },
  })

  console.log(`Seeded demo user: ${user.email}`)
}

main()
  .catch((error) => {
    console.error('Database seed failed:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
