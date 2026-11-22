const express = require('express')
const prisma = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

function parseRate(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  const percentage = Number(body.percentage)
  if (!name) return { error: 'Tax name is required.' }
  if (name.length > 80 || description.length > 240) return { error: 'Tax name or description is too long.' }
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    return { error: 'GST percentage must be between 0 and 100.' }
  }
  return { data: { name, description: description || null, percentage, isActive: body.isActive !== false } }
}

function serializeRate(rate) {
  return { ...rate, percentage: Number(rate.percentage), productCount: rate._count?.products ?? undefined }
}

router.get('/', async (request, response, next) => {
  try {
    const rates = await prisma.gstRate.findMany({
      where: { userId: request.userId },
      include: { _count: { select: { products: true } } },
      orderBy: [{ percentage: 'asc' }, { name: 'asc' }],
    })
    return response.json({ rates: rates.map(serializeRate) })
  } catch (error) {
    return next(error)
  }
})

router.post('/', async (request, response, next) => {
  const parsed = parseRate(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })
  try {
    const rate = await prisma.gstRate.create({ data: { ...parsed.data, userId: request.userId } })
    return response.status(201).json({ rate: serializeRate({ ...rate, _count: { products: 0 } }) })
  } catch (error) {
    if (error.code === 'P2002') return response.status(409).json({ message: 'That name or percentage already exists in your GST master.' })
    return next(error)
  }
})

router.put('/:id', async (request, response, next) => {
  const parsed = parseRate(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })
  try {
    const result = await prisma.gstRate.updateMany({
      where: { id: request.params.id, userId: request.userId },
      data: parsed.data,
    })
    if (!result.count) return response.status(404).json({ message: 'GST rate not found.' })
    const rate = await prisma.gstRate.findFirst({
      where: { id: request.params.id, userId: request.userId },
      include: { _count: { select: { products: true } } },
    })
    return response.json({ rate: serializeRate(rate) })
  } catch (error) {
    if (error.code === 'P2002') return response.status(409).json({ message: 'That name or percentage already exists in your GST master.' })
    return next(error)
  }
})

router.delete('/:id', async (request, response, next) => {
  try {
    const rate = await prisma.gstRate.findFirst({
      where: { id: request.params.id, userId: request.userId },
      include: { _count: { select: { products: true } } },
    })
    if (!rate) return response.status(404).json({ message: 'GST rate not found.' })
    if (rate._count.products) return response.status(409).json({ message: 'This GST rate is assigned to products. Deactivate it instead.' })
    await prisma.gstRate.delete({ where: { id: rate.id } })
    return response.status(204).end()
  } catch (error) {
    return next(error)
  }
})

module.exports = router
