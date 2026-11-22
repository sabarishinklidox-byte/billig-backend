const express = require('express')
const prisma = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

function parseBank(body) {
  const bankName = typeof body.bankName === 'string' ? body.bankName.trim() : ''
  const accountName = typeof body.accountName === 'string' ? body.accountName.trim() : ''
  const accountNumber = typeof body.accountNumber === 'string' ? body.accountNumber.trim().replace(/\s/g, '') : ''
  const ifscCode = typeof body.ifscCode === 'string' ? body.ifscCode.trim().toUpperCase() : ''
  const branch = typeof body.branch === 'string' ? body.branch.trim() : ''
  const upiId = typeof body.upiId === 'string' ? body.upiId.trim() : ''
  const isDefault = body.isDefault === true

  if (!bankName || !accountName || !accountNumber || !ifscCode) return { error: 'Bank, account holder, account number, and IFSC code are required.' }
  if (bankName.length > 120 || accountName.length > 160 || accountNumber.length > 34 || branch.length > 120 || upiId.length > 120) return { error: 'One or more bank details are too long.' }
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) return { error: 'Enter a valid 11-character IFSC code.' }
  if (upiId && !/^[\w.-]{2,256}@[\w.-]{2,64}$/.test(upiId)) return { error: 'Enter a valid UPI ID or leave it blank.' }
  return { data: { bankName, accountName, accountNumber, ifscCode, branch, upiId, isDefault } }
}

router.get('/', async (request, response, next) => {
  try {
    const accounts = await prisma.bankAccount.findMany({ where: { userId: request.userId }, orderBy: [{ isDefault: 'desc' }, { bankName: 'asc' }] })
    return response.json({ accounts })
  } catch (error) { return next(error) }
})

router.post('/', async (request, response, next) => {
  const parsed = parseBank(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })
  try {
    const account = await prisma.$transaction(async (tx) => {
      const existing = await tx.bankAccount.count({ where: { userId: request.userId } })
      const data = { ...parsed.data, isDefault: parsed.data.isDefault || existing === 0 }
      if (data.isDefault) await tx.bankAccount.updateMany({ where: { userId: request.userId }, data: { isDefault: false } })
      return tx.bankAccount.create({ data: { ...data, userId: request.userId } })
    })
    return response.status(201).json({ account })
  } catch (error) { return next(error) }
})

router.put('/:id', async (request, response, next) => {
  const parsed = parseBank(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })
  try {
    const account = await prisma.$transaction(async (tx) => {
      const existing = await tx.bankAccount.findFirst({ where: { id: request.params.id, userId: request.userId } })
      if (!existing) return null
      if (parsed.data.isDefault) await tx.bankAccount.updateMany({ where: { userId: request.userId }, data: { isDefault: false } })
      return tx.bankAccount.update({ where: { id: existing.id }, data: { ...parsed.data, isDefault: parsed.data.isDefault || existing.isDefault } })
    })
    if (!account) return response.status(404).json({ message: 'Bank account not found.' })
    return response.json({ account })
  } catch (error) { return next(error) }
})

router.delete('/:id', async (request, response, next) => {
  try {
    const result = await prisma.bankAccount.deleteMany({ where: { id: request.params.id, userId: request.userId } })
    if (!result.count) return response.status(404).json({ message: 'Bank account not found.' })
    return response.status(204).end()
  } catch (error) { return next(error) }
})

module.exports = router
