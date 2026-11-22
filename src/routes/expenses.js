const express = require('express')
const prisma = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

function parseExpense(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const category = typeof body.category === 'string' ? body.category.trim() : ''
  const paymentMode = typeof body.paymentMode === 'string' ? body.paymentMode.trim() : ''
  const notes = typeof body.notes === 'string' ? body.notes.trim() : ''
  const amount = Number(body.amount)
  const date = typeof body.expenseDate === 'string' ? body.expenseDate : ''
  if (!title || !category || !paymentMode || !date || !Number.isFinite(amount) || amount <= 0) return { error: 'Enter a title, category, valid date, payment method, and amount greater than zero.' }
  if (title.length > 160 || category.length > 80 || paymentMode.length > 40 || notes.length > 1000) return { error: 'One or more expense details are too long.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { error: 'Enter a valid expense date.' }
  return { data: { title, category, paymentMode, notes, amount: amount.toFixed(2), expenseDate: new Date(`${date}T00:00:00Z`) } }
}

router.get('/', async (request, response, next) => {
  try {
    const expenses = await prisma.expense.findMany({ where: { userId: request.userId }, orderBy: [{ expenseDate: 'desc' }, { createdAt: 'desc' }] })
    return response.json({ expenses })
  } catch (error) { return next(error) }
})

router.post('/', async (request, response, next) => {
  const parsed = parseExpense(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })
  try {
    const expense = await prisma.expense.create({ data: { ...parsed.data, userId: request.userId } })
    return response.status(201).json({ expense })
  } catch (error) { return next(error) }
})

router.put('/:id', async (request, response, next) => {
  const parsed = parseExpense(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })
  try {
    const result = await prisma.expense.updateMany({ where: { id: request.params.id, userId: request.userId }, data: parsed.data })
    if (!result.count) return response.status(404).json({ message: 'Expense not found.' })
    const expense = await prisma.expense.findFirst({ where: { id: request.params.id, userId: request.userId } })
    return response.json({ expense })
  } catch (error) { return next(error) }
})

router.delete('/:id', async (request, response, next) => {
  try {
    const result = await prisma.expense.deleteMany({ where: { id: request.params.id, userId: request.userId } })
    if (!result.count) return response.status(404).json({ message: 'Expense not found.' })
    return response.status(204).end()
  } catch (error) { return next(error) }
})

module.exports = router
