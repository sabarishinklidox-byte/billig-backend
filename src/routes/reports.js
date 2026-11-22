const express = require('express')
const prisma = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

function parseDate(value) {
  if (!value) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? undefined : date
}

router.get('/sales', async (request, response, next) => {
  const from = parseDate(request.query.from)
  const to = parseDate(request.query.to)
  if (from === undefined || to === undefined) return response.status(400).json({ message: 'Enter valid report dates.' })
  if (from && to && from > to) return response.status(400).json({ message: 'The start date must be before the end date.' })

  try {
    const where = {
      userId: request.userId,
      status: { not: 'VOID' },
      workflowStatus: { not: 'CANCELLED' },
      ...(request.query.customerId ? { customerId: request.query.customerId } : {}),
      ...(from || to ? { invoiceDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
    }
    const [invoices, customers] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: { customer: { select: { name: true } }, items: { select: { weight: true } } },
        orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.customer.findMany({ where: { userId: request.userId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    ])

    const rows = invoices.map((invoice) => ({
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
      dueDate: invoice.dueDate ? invoice.dueDate.toISOString().slice(0, 10) : null,
      customerId: invoice.customerId,
      customerName: invoice.customer.name,
      status: invoice.status,
      workflowStatus: invoice.workflowStatus,
      subtotal: Number(invoice.subtotal),
      taxTotal: Number(invoice.taxTotal),
      grandTotal: Number(invoice.grandTotal),
      totalWeight: invoice.items.some((item) => item.weight !== null)
        ? invoice.items.reduce((sum, item) => sum + Number(item.weight || 0), 0)
        : null,
    }))
    const summary = rows.reduce((result, invoice) => {
      result.invoiceCount += 1
      result.subtotal += invoice.subtotal
      result.taxTotal += invoice.taxTotal
      result.totalSales += invoice.grandTotal
      if (invoice.status === 'PAID') result.amountReceived += invoice.grandTotal
      if (['ISSUED', 'PARTIAL', 'OVERDUE'].includes(invoice.status)) result.toCollect += invoice.grandTotal
      if (invoice.totalWeight !== null) result.totalWeight += invoice.totalWeight
      return result
    }, { invoiceCount: 0, subtotal: 0, taxTotal: 0, totalSales: 0, amountReceived: 0, toCollect: 0, totalWeight: 0 })

    for (const key of ['subtotal', 'taxTotal', 'totalSales', 'amountReceived', 'toCollect', 'totalWeight']) {
      summary[key] = Math.round((summary[key] + Number.EPSILON) * 100) / 100
    }
    return response.json({ summary, invoices: rows, customers })
  } catch (error) {
    return next(error)
  }
})

module.exports = router
