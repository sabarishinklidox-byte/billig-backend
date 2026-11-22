const express = require('express')
const bcrypt = require('bcryptjs')
const prisma = require('../db')
const { createAccessToken, requireAuth } = require('../middleware/auth')

const router = express.Router()

router.post('/login', async (request, response, next) => {
  try {
    const email = typeof request.body.email === 'string' ? request.body.email.trim().toLowerCase() : ''
    const password = typeof request.body.password === 'string' ? request.body.password : ''
    if (!email || !password) return response.status(400).json({ message: 'Email and password are required.' })

    const user = await prisma.user.findUnique({ where: { email } })
    const validPassword = user ? await bcrypt.compare(password, user.passwordHash) : false
    if (!validPassword) return response.status(401).json({ message: 'The email or password is incorrect.' })

    return response.json({
      token: createAccessToken(user.id),
      user: { id: user.id, name: user.name, email: user.email, companyName: user.companyName || user.name, address: user.address, gstin: user.gstin, phone: user.phone, companyEmail: user.companyEmail || user.email, nextInvoiceNumber: user.nextInvoiceNumber },
    })
  } catch (error) {
    return next(error)
  }
})

router.get('/me', requireAuth, async (request, response, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: request.userId },
      select: { id: true, name: true, email: true, companyName: true, address: true, gstin: true, phone: true, companyEmail: true, nextInvoiceNumber: true },
    })
    if (!user) return response.status(401).json({ message: 'Please sign in again.' })
    return response.json({ user: { ...user, companyName: user.companyName || user.name, companyEmail: user.companyEmail || user.email } })
  } catch (error) {
    return next(error)
  }
})

router.put('/company', requireAuth, async (request, response, next) => {
  const companyName = typeof request.body.companyName === 'string' ? request.body.companyName.trim() : ''
  const address = typeof request.body.address === 'string' ? request.body.address.trim() : ''
  const gstin = typeof request.body.gstin === 'string' ? request.body.gstin.trim().toUpperCase() : ''
  const phone = typeof request.body.phone === 'string' ? request.body.phone.trim() : ''
  const companyEmail = typeof request.body.companyEmail === 'string' ? request.body.companyEmail.trim().toLowerCase() : ''
  const nextInvoiceNumber = Number(request.body.nextInvoiceNumber ?? 1)

  if (!companyName) return response.status(400).json({ message: 'Company name is required.' })
  if (companyName.length > 160 || address.length > 1000 || phone.length > 24 || companyEmail.length > 254) return response.status(400).json({ message: 'One or more company details are too long.' })
  if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) return response.status(400).json({ message: 'Enter a valid 15-character GSTIN.' })
  if (companyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(companyEmail)) return response.status(400).json({ message: 'Enter a valid company email address.' })
  if (!Number.isSafeInteger(nextInvoiceNumber) || nextInvoiceNumber < 1 || nextInvoiceNumber > 999999999) return response.status(400).json({ message: 'Next invoice number must be a whole number between 1 and 999,999,999.' })

  try {
    const user = await prisma.user.update({
      where: { id: request.userId },
      data: { companyName, address, gstin, phone, companyEmail, nextInvoiceNumber },
      select: { id: true, name: true, email: true, companyName: true, address: true, gstin: true, phone: true, companyEmail: true, nextInvoiceNumber: true },
    })
    return response.json({ user: { ...user, companyName: user.companyName || user.name, companyEmail: user.companyEmail || user.email } })
  } catch (error) { return next(error) }
})

module.exports = router
