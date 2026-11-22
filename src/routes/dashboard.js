const express = require('express')
const prisma = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

function startOfMonth(date, offset = 0) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1))
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function amount(value) {
  return Number(value || 0)
}

router.get('/', async (request, response, next) => {
  try {
    const now = new Date()
    const currentMonth = startOfMonth(now)
    const nextMonth = startOfMonth(now, 1)
    const previousMonth = startOfMonth(now, -1)
    const chartStart = startOfMonth(now, -6)
    const baseWhere = { userId: request.userId, status: { not: 'VOID' }, workflowStatus: { not: 'CANCELLED' } }

    const [allTime, received, outstanding, currentSales, previousSales, currentCount, monthlyInvoices, recentInvoices, statusCounts, weightTotals] = await Promise.all([
      prisma.invoice.aggregate({ where: baseWhere, _sum: { grandTotal: true }, _count: { _all: true } }),
      prisma.invoice.aggregate({ where: { ...baseWhere, status: 'PAID' }, _sum: { grandTotal: true } }),
      prisma.invoice.aggregate({ where: { ...baseWhere, status: { in: ['ISSUED', 'PARTIAL', 'OVERDUE'] } }, _sum: { grandTotal: true } }),
      prisma.invoice.aggregate({ where: { ...baseWhere, invoiceDate: { gte: currentMonth, lt: nextMonth } }, _sum: { grandTotal: true } }),
      prisma.invoice.aggregate({ where: { ...baseWhere, invoiceDate: { gte: previousMonth, lt: currentMonth } }, _sum: { grandTotal: true } }),
      prisma.invoice.count({ where: { ...baseWhere, invoiceDate: { gte: currentMonth, lt: nextMonth } } }),
      prisma.invoice.findMany({ where: { ...baseWhere, invoiceDate: { gte: chartStart, lt: nextMonth } }, select: { invoiceDate: true, grandTotal: true } }),
      prisma.invoice.findMany({ where: { userId: request.userId }, include: { customer: { select: { name: true } }, items: { select: { weight: true } } }, orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }], take: 5 }),
      prisma.invoice.groupBy({ by: ['status'], where: { userId: request.userId, workflowStatus: { not: 'CANCELLED' } }, _count: { _all: true } }),
      prisma.invoiceItem.aggregate({ where: { invoice: { userId: request.userId, status: { not: 'VOID' }, workflowStatus: { not: 'CANCELLED' } } }, _sum: { weight: true } }),
    ])

    const monthlyTotals = new Map()
    for (const invoice of monthlyInvoices) {
      const key = monthKey(invoice.invoiceDate)
      monthlyTotals.set(key, (monthlyTotals.get(key) || 0) + Number(invoice.grandTotal))
    }
    const monthlySales = Array.from({ length: 7 }, (_, index) => {
      const month = startOfMonth(now, index - 6)
      return {
        key: monthKey(month),
        label: new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' }).format(month),
        amount: Math.round((monthlyTotals.get(monthKey(month)) || 0) * 100) / 100,
      }
    })

    const statusCount = Object.fromEntries(statusCounts.map((item) => [item.status, item._count._all]))
    const thisMonthSales = amount(currentSales._sum.grandTotal)
    const lastMonthSales = amount(previousSales._sum.grandTotal)
    const salesChangePercent = lastMonthSales > 0
      ? Math.round(((thisMonthSales - lastMonthSales) / lastMonthSales) * 1000) / 10
      : thisMonthSales > 0 ? 100 : 0

    return response.json({
      summary: {
        totalSales: amount(allTime._sum.grandTotal),
        amountReceived: amount(received._sum.grandTotal),
        toCollect: amount(outstanding._sum.grandTotal),
        totalInvoices: allTime._count._all,
        totalWeight: weightTotals._sum.weight === null ? null : Number(weightTotals._sum.weight),
        createdThisMonth: currentCount,
        salesChangePercent,
        paidCount: statusCount.PAID || 0,
        pendingCount: (statusCount.ISSUED || 0) + (statusCount.PARTIAL || 0),
        overdueCount: statusCount.OVERDUE || 0,
      },
      monthlySales,
      recentInvoices: recentInvoices.map((invoice) => ({
        id: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        customer: invoice.customer.name,
        invoiceDate: invoice.invoiceDate.toISOString().slice(0, 10),
        grandTotal: Number(invoice.grandTotal),
        totalWeight: invoice.items.some((item) => item.weight !== null)
          ? invoice.items.reduce((sum, item) => sum + Number(item.weight || 0), 0)
          : null,
        status: invoice.status,
        workflowStatus: invoice.workflowStatus,
      })),
    })
  } catch (error) {
    return next(error)
  }
})

module.exports = router
