const express = require('express')
const crypto = require('node:crypto')
const prisma = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

router.get('/hsn-lookup', async (request, response) => {
  const query = typeof request.query.q === 'string' ? request.query.q.trim() : ''
  if (query.length < 3 || query.length > 120) {
    return response.status(400).json({ message: 'Enter a product name between 3 and 120 characters.' })
  }

  try {
    const upstream = await fetch(`https://hsn.krakelabsindia.com/api/lookup?q=${encodeURIComponent(query)}&limit=5`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!upstream.ok) return response.status(502).json({ message: 'The HSN lookup service is temporarily unavailable.' })
    const payload = await upstream.json()
    return response.json({ matches: Array.isArray(payload.matches) ? payload.matches : [] })
  } catch {
    return response.status(502).json({ message: 'The HSN lookup service is temporarily unavailable.' })
  }
})

function serializeProduct(product) {
  const { gstRate, ...fields } = product
  return {
    ...fields,
    salePrice: Number(product.salePrice),
    purchasePrice: Number(product.purchasePrice),
    gst: Number(gstRate?.percentage ?? product.gst),
    gstRate: gstRate ? { ...gstRate, percentage: Number(gstRate.percentage) } : null,
  }
}

function parseProduct(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const sku = typeof body.sku === 'string' && body.sku.trim() ? body.sku.trim().toUpperCase() : `ITEM-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
  const hsnCode = typeof body.hsnCode === 'string' ? body.hsnCode.trim() : ''
  const category = typeof body.category === 'string' && body.category.trim() ? body.category.trim() : 'Uncategorized'
  const unit = typeof body.unit === 'string' && body.unit.trim() ? body.unit.trim() : 'pcs'
  const salePrice = Number(body.salePrice)
  const purchasePrice = Number(body.purchasePrice)
  const stock = Number(body.stock)
  const gstRateId = typeof body.gstRateId === 'string' ? body.gstRateId : ''

  if (!name) return { error: 'Product name is required.' }
  if (hsnCode && !/^\d{2,8}$/.test(hsnCode)) return { error: 'HSN code must contain 2 to 8 digits.' }
  if (name.length > 160 || sku.length > 64 || category.length > 100 || unit.length > 24) {
    return { error: 'One or more product fields are too long.' }
  }
  if (!Number.isFinite(salePrice) || salePrice < 0 || !Number.isFinite(purchasePrice) || purchasePrice < 0) {
    return { error: 'Prices must be valid non-negative numbers.' }
  }
  if (!Number.isInteger(stock) || stock < 0) return { error: 'Stock must be a non-negative whole number.' }
  if (!gstRateId) return { error: 'Choose a GST rate from your GST master.' }

  return { data: { name, sku, hsnCode: hsnCode || null, category, unit, salePrice, purchasePrice, stock, gstRateId } }
}

async function getProductData(data, userId) {
  const gstRate = await prisma.gstRate.findFirst({
    where: { id: data.gstRateId, userId, isActive: true },
  })
  if (!gstRate) return null
  return { ...data, gst: Number(gstRate.percentage), gstRateId: gstRate.id }
}

router.get('/', async (request, response, next) => {
  try {
    const search = typeof request.query.q === 'string' ? request.query.q.trim() : ''
    const stockFilter = request.query.stock
    const where = {
      userId: request.userId,
      ...(search ? { OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { sku: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
      ] } : {}),
      ...(stockFilter === 'low' ? { stock: { gt: 0, lte: 10 } } : {}),
      ...(stockFilter === 'out' ? { stock: 0 } : {}),
      ...(stockFilter === 'in' ? { stock: { gt: 10 } } : {}),
    }
    const products = await prisma.product.findMany({ where, include: { gstRate: true }, orderBy: { name: 'asc' } })
    return response.json({ products: products.map(serializeProduct) })
  } catch (error) {
    return next(error)
  }
})

router.post('/', async (request, response, next) => {
  const parsed = parseProduct(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })

  try {
    const productData = await getProductData(parsed.data, request.userId)
    if (!productData) return response.status(400).json({ message: 'Choose an active GST rate from your GST master.' })
    const product = await prisma.product.create({ data: { ...productData, userId: request.userId }, include: { gstRate: true } })
    return response.status(201).json({ product: serializeProduct(product) })
  } catch (error) {
    if (error.code === 'P2002') return response.status(409).json({ message: 'That SKU is already used in your product catalog.' })
    return next(error)
  }
})

router.put('/:id', async (request, response, next) => {
  const parsed = parseProduct(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })

  try {
    const productData = await getProductData(parsed.data, request.userId)
    if (!productData) return response.status(400).json({ message: 'Choose an active GST rate from your GST master.' })
    const result = await prisma.product.updateMany({
      where: { id: request.params.id, userId: request.userId },
      data: productData,
    })
    if (!result.count) return response.status(404).json({ message: 'Product not found.' })
    const product = await prisma.product.findFirst({ where: { id: request.params.id, userId: request.userId }, include: { gstRate: true } })
    return response.json({ product: serializeProduct(product) })
  } catch (error) {
    if (error.code === 'P2002') return response.status(409).json({ message: 'That SKU is already used in your product catalog.' })
    return next(error)
  }
})

router.delete('/:id', async (request, response, next) => {
  try {
    const result = await prisma.product.deleteMany({ where: { id: request.params.id, userId: request.userId } })
    if (!result.count) return response.status(404).json({ message: 'Product not found.' })
    return response.status(204).end()
  } catch (error) {
    return next(error)
  }
})

module.exports = router
