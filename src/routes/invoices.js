const crypto = require('node:crypto')
const express = require('express')
const prisma = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

function parseDate(value, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : date
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function serializeInvoice(invoice) {
  return {
    ...invoice,
    invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
    dueDate: invoice.dueDate?.toISOString().slice(0, 10) || null,
    subtotal: Number(invoice.subtotal),
    taxTotal: Number(invoice.taxTotal),
    grandTotal: Number(invoice.grandTotal),
    items: invoice.items.map((item) => ({
      ...item,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      gstRate: Number(item.gstRate),
      taxableAmount: Number(item.taxableAmount),
      taxAmount: Number(item.taxAmount),
      lineTotal: Number(item.lineTotal),
    })),
  }
}

const invoiceInclude = { customer: true, items: { orderBy: { productName: 'asc' } } }

router.get('/', async (request, response, next) => {
  try {
    const invoices = await prisma.invoice.findMany({
      where: { userId: request.userId },
      include: { customer: true, items: { select: { weight: true } }, _count: { select: { items: true } } },
      orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    })
    return response.json({ invoices: invoices.map((invoice) => {
      const weightedItems = invoice.items.filter((item) => item.weight !== null)
      const totalWeight = weightedItems.length ? weightedItems.reduce((sum, item) => sum + Number(item.weight), 0) : null
      const { items, ...fields } = invoice
      return {
        ...fields,
        totalWeight,
        invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
        dueDate: invoice.dueDate?.toISOString().slice(0, 10) || null,
        subtotal: Number(invoice.subtotal),
        taxTotal: Number(invoice.taxTotal),
        grandTotal: Number(invoice.grandTotal),
      }
    }) })
  } catch (error) {
    return next(error)
  }
})

router.get('/:id', async (request, response, next) => {
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { id: request.params.id, userId: request.userId },
      include: invoiceInclude,
    })
    if (!invoice) return response.status(404).json({ message: 'Invoice not found.' })
    return response.json({ invoice: serializeInvoice(invoice) })
  } catch (error) {
    return next(error)
  }
})

router.patch('/:id/workflow-status', async (request, response, next) => {
  const workflowStatus = request.body.workflowStatus
  if (!['COMPLETED', 'CANCELLED'].includes(workflowStatus)) {
    return response.status(400).json({ message: 'Choose Completed or Cancelled.' })
  }
  try {
    const invoice = await prisma.invoice.findFirst({ where: { id: request.params.id, userId: request.userId } })
    if (!invoice) return response.status(404).json({ message: 'Invoice not found.' })
    if (invoice.workflowStatus !== 'ISSUED') {
      return response.status(409).json({ message: 'Completed and cancelled invoices cannot be changed.' })
    }
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { workflowStatus },
      include: invoiceInclude,
    })
    return response.json({ invoice: serializeInvoice(updated) })
  } catch (error) {
    return next(error)
  }
})

router.patch('/:id/payment-status', async (request, response, next) => {
  if (request.body.status !== 'PAID') {
    return response.status(400).json({ message: 'Choose Paid to record the full invoice amount as received.' })
  }
  try {
    const invoice = await prisma.invoice.findFirst({ where: { id: request.params.id, userId: request.userId } })
    if (!invoice) return response.status(404).json({ message: 'Invoice not found.' })
    if (invoice.workflowStatus === 'CANCELLED' || invoice.status === 'VOID') {
      return response.status(409).json({ message: 'A cancelled invoice cannot be marked paid.' })
    }
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID' },
      include: invoiceInclude,
    })
    return response.json({ invoice: serializeInvoice(updated) })
  } catch (error) {
    return next(error)
  }
})

router.put('/:id/quantities', async (request, response, next) => {
  const lines = request.body.items
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) {
    return response.status(400).json({ message: 'Invoice items are invalid.' })
  }
  try {
    const existing = await prisma.invoice.findFirst({ where: { id: request.params.id, userId: request.userId }, include: invoiceInclude })
    if (!existing) return response.status(404).json({ message: 'Invoice not found.' })
    if (existing.workflowStatus !== 'ISSUED') {
      return response.status(409).json({ message: 'Only issued invoices can be edited. Completed and cancelled invoices are locked.' })
    }
    if (lines.length !== existing.items.length || lines.some((line) => !existing.items.some((item) => item.id === line.id))) {
      return response.status(400).json({ message: 'This editor can only update quantities and weights on the existing items.' })
    }
    const updates = lines.map((line) => {
      const quantity = Number(line.quantity)
      const weight = line.weight === undefined || line.weight === null || line.weight === '' ? null : Number(line.weight)
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999999 || (weight !== null && (!Number.isFinite(weight) || weight < 0 || weight > 999999999.999))) return null
      const item = existing.items.find((candidate) => candidate.id === line.id)
      const taxableAmount = roundMoney(Number(item.unitPrice) * quantity)
      const taxAmount = roundMoney(taxableAmount * Number(item.gstRate) / 100)
      return { id: item.id, quantity, weight, taxableAmount, taxAmount, lineTotal: roundMoney(taxableAmount + taxAmount) }
    })
    if (updates.some((item) => !item)) return response.status(400).json({ message: 'Enter a valid quantity and optional weight for every item.' })

    const subtotal = roundMoney(updates.reduce((sum, item) => sum + item.taxableAmount, 0))
    const taxTotal = roundMoney(updates.reduce((sum, item) => sum + item.taxAmount, 0))
    const grandTotal = roundMoney(subtotal + taxTotal)
    const updated = await prisma.$transaction(async (transaction) => {
      for (const item of updates) {
        await transaction.invoiceItem.update({ where: { id: item.id }, data: { quantity: item.quantity, weight: item.weight, taxableAmount: item.taxableAmount, taxAmount: item.taxAmount, lineTotal: item.lineTotal } })
      }
      return transaction.invoice.update({ where: { id: existing.id }, data: { subtotal, taxTotal, grandTotal }, include: invoiceInclude })
    })
    return response.json({ invoice: serializeInvoice(updated) })
  } catch (error) {
    return next(error)
  }
})

router.put('/:id', async (request, response, next) => {
  let existing
  try {
    existing = await prisma.invoice.findFirst({ where: { id: request.params.id, userId: request.userId }, include: invoiceInclude })
  } catch (error) {
    return next(error)
  }
  if (!existing) return response.status(404).json({ message: 'Invoice not found.' })
  if (existing.workflowStatus !== 'ISSUED') return response.status(409).json({ message: 'Only issued invoices can be edited.' })

  const customerId = typeof request.body.customerId === 'string' ? request.body.customerId : ''
  const bankAccountId = typeof request.body.bankAccountId === 'string' ? request.body.bankAccountId : ''
  const vehicleNumber = typeof request.body.vehicleNumber === 'string' ? request.body.vehicleNumber.trim().toUpperCase() : ''
  const invoiceNumber = typeof request.body.invoiceNumber === 'string' ? request.body.invoiceNumber.trim() : ''
  const invoiceDate = parseDate(request.body.invoiceDate)
  const dueDate = parseDate(request.body.dueDate, true)
  const billingAddress = typeof request.body.billingAddress === 'string' ? request.body.billingAddress.trim() : ''
  const shippingAddress = typeof request.body.shippingAddress === 'string' ? request.body.shippingAddress.trim() : ''
  const notes = typeof request.body.notes === 'string' ? request.body.notes.trim() : ''
  const lines = request.body.items

  if (!customerId) return response.status(400).json({ message: 'Choose a customer for this invoice.' })
  if (!invoiceNumber || invoiceNumber.length > 40) return response.status(400).json({ message: 'Enter a valid invoice number.' })
  if (vehicleNumber.length > 40) return response.status(400).json({ message: 'Vehicle number must be 40 characters or fewer.' })
  if (!invoiceDate || dueDate === undefined || (dueDate && dueDate < invoiceDate)) return response.status(400).json({ message: 'Enter valid invoice and due dates.' })
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) return response.status(400).json({ message: 'Add between 1 and 100 invoice items.' })
  if (notes.length > 1000 || billingAddress.length > 1000 || shippingAddress.length > 1000) return response.status(400).json({ message: 'Invoice notes or addresses are too long.' })

  try {
    const [customer, bankAccount] = await Promise.all([
      prisma.customer.findFirst({ where: { id: customerId, userId: request.userId } }),
      bankAccountId ? prisma.bankAccount.findFirst({ where: { id: bankAccountId, userId: request.userId } }) : null,
    ])
    if (!customer) return response.status(400).json({ message: 'The selected customer was not found.' })
    if (bankAccountId && !bankAccount) return response.status(400).json({ message: 'The selected bank account was not found.' })

    const parsedLines = lines.map((line) => ({
      existingItemId: typeof line.existingItemId === 'string' ? line.existingItemId : '',
      productId: typeof line.productId === 'string' ? line.productId : '',
      quantity: Number(line.quantity),
      weight: line.weight === undefined || line.weight === null || line.weight === '' ? null : Number(line.weight),
    }))
    if (parsedLines.some((line) => !line.productId || !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 999999 || (line.weight !== null && (!Number.isFinite(line.weight) || line.weight < 0 || line.weight > 999999999.999)))) {
      return response.status(400).json({ message: 'Each item needs a product, valid quantity, and valid optional weight.' })
    }
    const oldItems = new Map(existing.items.map((item) => [item.id, item]))
    if (parsedLines.some((line) => line.existingItemId && (!oldItems.has(line.existingItemId) || oldItems.get(line.existingItemId).productId !== line.productId))) {
      return response.status(400).json({ message: 'One or more existing invoice items are invalid.' })
    }
    const products = await prisma.product.findMany({ where: { userId: request.userId, id: { in: [...new Set(parsedLines.map((line) => line.productId))] } }, include: { gstRate: true } })
    const productsById = new Map(products.map((product) => [product.id, product]))
    if (parsedLines.some((line) => !productsById.has(line.productId))) return response.status(400).json({ message: 'One or more selected products are unavailable.' })

    let subtotal = 0
    let taxTotal = 0
    const itemData = parsedLines.map(({ existingItemId, productId, quantity, weight }) => {
      const product = productsById.get(productId)
      const previous = existingItemId ? oldItems.get(existingItemId) : null
      const unitPrice = Number(previous?.unitPrice ?? product.salePrice)
      const gstRate = Number(previous?.gstRate ?? product.gstRate?.percentage ?? product.gst)
      const taxableAmount = roundMoney(unitPrice * quantity)
      const taxAmount = roundMoney(taxableAmount * gstRate / 100)
      subtotal = roundMoney(subtotal + taxableAmount)
      taxTotal = roundMoney(taxTotal + taxAmount)
      return { productId, productName: product.name, sku: product.sku, hsnCode: product.hsnCode, unit: product.unit, quantity, weight, unitPrice, gstRate, taxableAmount, taxAmount, lineTotal: roundMoney(taxableAmount + taxAmount) }
    })
    const grandTotal = roundMoney(subtotal + taxTotal)

    const updated = await prisma.$transaction(async (transaction) => {
      const stillEditable = await transaction.invoice.findFirst({ where: { id: existing.id, userId: request.userId }, select: { workflowStatus: true } })
      if (!stillEditable || stillEditable.workflowStatus !== 'ISSUED') {
        const lockedError = new Error('Only issued invoices can be edited.')
        lockedError.code = 'INVOICE_LOCKED'
        throw lockedError
      }
      const duplicate = await transaction.invoice.findFirst({ where: { userId: request.userId, invoiceNumber, id: { not: existing.id }, workflowStatus: { not: 'CANCELLED' } }, select: { id: true } })
      if (duplicate) {
        const duplicateError = new Error('This invoice number is already in use. Enter a different number.')
        duplicateError.code = 'DUPLICATE_INVOICE_NUMBER'
        throw duplicateError
      }
      return transaction.invoice.update({
        where: { id: existing.id },
        data: {
          customerId, invoiceNumber, bankAccountId: bankAccount?.id || null,
          bankName: bankAccount?.bankName || '', accountName: bankAccount?.accountName || '',
          accountNumber: bankAccount?.accountNumber || '', ifscCode: bankAccount?.ifscCode || '', branch: bankAccount?.branch || '',
          vehicleNumber, invoiceDate, dueDate, subtotal, taxTotal, grandTotal, billingAddress, shippingAddress, notes,
          items: { deleteMany: {}, create: itemData },
        },
        include: invoiceInclude,
      })
    })
    return response.json({ invoice: serializeInvoice(updated) })
  } catch (error) {
    if (error.code === 'INVOICE_LOCKED') return response.status(409).json({ message: error.message })
    if (error.code === 'DUPLICATE_INVOICE_NUMBER' || error.code === 'P2002') return response.status(409).json({ message: 'This invoice number is already in use. Enter a different number.' })
    return next(error)
  }
})

router.post('/', async (request, response, next) => {
  const customerId = typeof request.body.customerId === 'string' ? request.body.customerId : ''
  const bankAccountId = typeof request.body.bankAccountId === 'string' ? request.body.bankAccountId : ''
  const vehicleNumber = typeof request.body.vehicleNumber === 'string' ? request.body.vehicleNumber.trim().toUpperCase() : ''
  const requestedInvoiceNumber = typeof request.body.invoiceNumber === 'string' ? request.body.invoiceNumber.trim() : ''
  const invoiceDate = parseDate(request.body.invoiceDate)
  const dueDate = parseDate(request.body.dueDate, true)
  const billingAddress = typeof request.body.billingAddress === 'string' ? request.body.billingAddress.trim() : ''
  const shippingAddress = typeof request.body.shippingAddress === 'string' ? request.body.shippingAddress.trim() : ''
  const notes = typeof request.body.notes === 'string' ? request.body.notes.trim() : ''
  const lines = request.body.items

  if (!customerId) return response.status(400).json({ message: 'Choose a customer for this invoice.' })
  if (vehicleNumber.length > 40) return response.status(400).json({ message: 'Vehicle number must be 40 characters or fewer.' })
  if (requestedInvoiceNumber.length > 40) return response.status(400).json({ message: 'Invoice number must be 40 characters or fewer.' })
  if (!invoiceDate) return response.status(400).json({ message: 'Enter a valid invoice date.' })
  if (dueDate === undefined) return response.status(400).json({ message: 'Enter a valid due date.' })
  if (dueDate && dueDate < invoiceDate) return response.status(400).json({ message: 'The due date cannot be earlier than the invoice date.' })
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) return response.status(400).json({ message: 'Add between 1 and 100 invoice items.' })
  if (notes.length > 1000) return response.status(400).json({ message: 'Invoice notes are too long.' })
  if (billingAddress.length > 1000 || shippingAddress.length > 1000) return response.status(400).json({ message: 'Billing or shipping address is too long.' })

  try {
    const customer = await prisma.customer.findFirst({ where: { id: customerId, userId: request.userId } })
    if (!customer) return response.status(400).json({ message: 'The selected customer was not found.' })

    const bankAccount = bankAccountId ? await prisma.bankAccount.findFirst({ where: { id: bankAccountId, userId: request.userId } }) : null
    if (bankAccountId && !bankAccount) return response.status(400).json({ message: 'The selected bank account was not found.' })

    const parsedLines = lines.map((line) => ({
      productId: typeof line.productId === 'string' ? line.productId : '',
      quantity: Number(line.quantity),
      weight: line.weight === undefined || line.weight === null || line.weight === '' ? null : Number(line.weight),
    }))
    if (parsedLines.some((line) => !line.productId || !Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 999999 || (line.weight !== null && (!Number.isFinite(line.weight) || line.weight < 0 || line.weight > 999999999.999)))) {
      return response.status(400).json({ message: 'Each item needs a product, valid quantity, and a valid optional weight.' })
    }

    const products = await prisma.product.findMany({
      where: { userId: request.userId, id: { in: [...new Set(parsedLines.map((line) => line.productId))] } },
      include: { gstRate: true },
    })
    const productsById = new Map(products.map((product) => [product.id, product]))
    if (parsedLines.some((line) => !productsById.has(line.productId))) {
      return response.status(400).json({ message: 'One or more selected products are unavailable.' })
    }

    let subtotal = 0
    let taxTotal = 0
    const itemData = parsedLines.map(({ productId, quantity, weight }) => {
      const product = productsById.get(productId)
      const unitPrice = Number(product.salePrice)
      const gstRate = Number(product.gstRate?.percentage ?? product.gst)
      const taxableAmount = roundMoney(unitPrice * quantity)
      const taxAmount = roundMoney(taxableAmount * gstRate / 100)
      const lineTotal = roundMoney(taxableAmount + taxAmount)
      subtotal = roundMoney(subtotal + taxableAmount)
      taxTotal = roundMoney(taxTotal + taxAmount)
      return {
        productId: product.id,
        productName: product.name,
        sku: product.sku,
        hsnCode: product.hsnCode,
        unit: product.unit,
        quantity,
        weight,
        unitPrice,
        gstRate,
        taxableAmount,
        taxAmount,
        lineTotal,
      }
    })

    const grandTotal = roundMoney(subtotal + taxTotal)
    if (grandTotal > 9999999999.99) return response.status(400).json({ message: 'Invoice total is above the supported limit.' })

    let invoice
    try {
      invoice = await prisma.$transaction(async (transaction) => {
        let invoiceNumber = requestedInvoiceNumber
        if (invoiceNumber) {
          const duplicate = await transaction.invoice.findFirst({ where: { userId: request.userId, invoiceNumber, workflowStatus: { not: 'CANCELLED' } }, select: { id: true } })
          if (duplicate) {
            const duplicateError = new Error('This invoice number is already in use. Enter a different number.')
            duplicateError.code = 'DUPLICATE_INVOICE_NUMBER'
            throw duplicateError
          }
        } else {
          const user = await transaction.user.update({
            where: { id: request.userId },
            data: { nextInvoiceNumber: { increment: 1 } },
            select: { nextInvoiceNumber: true },
          })
          invoiceNumber = String(user.nextInvoiceNumber - 1).padStart(3, '0')
        }

        return transaction.invoice.create({
          data: {
            userId: request.userId,
            customerId,
            bankAccountId: bankAccount?.id || null,
            bankName: bankAccount?.bankName || '',
            accountName: bankAccount?.accountName || '',
            accountNumber: bankAccount?.accountNumber || '',
            ifscCode: bankAccount?.ifscCode || '',
            branch: bankAccount?.branch || '',
            invoiceNumber,
            vehicleNumber,
            invoiceDate,
            dueDate,
            subtotal,
            taxTotal,
            grandTotal,
            billingAddress,
            shippingAddress,
            notes,
            items: { create: itemData },
          },
          include: invoiceInclude,
        })
      })
    } catch (error) {
      if (error.code === 'DUPLICATE_INVOICE_NUMBER' || error.code === 'P2002') {
        return response.status(409).json({ message: 'This invoice number is already in use. Enter a different number.' })
      }
      throw error
    }    return response.status(201).json({ invoice: serializeInvoice(invoice) })
  } catch (error) {
    return next(error)
  }
})

module.exports = router
