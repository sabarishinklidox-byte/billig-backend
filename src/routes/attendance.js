const express = require('express')
const prisma = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)
const statuses = ['PRESENT', 'ABSENT', 'LATE', 'LEAVE']

function parseEmployee(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const address = typeof body.address === 'string' ? body.address.trim() : ''
  const bloodGroup = typeof body.bloodGroup === 'string' ? body.bloodGroup.trim().toUpperCase() : ''
  const designation = typeof body.designation === 'string' ? body.designation.trim() : ''
  const joinDate = typeof body.joinDate === 'string' ? body.joinDate : ''
  if (!name || name.length > 160) return { error: 'Enter an employee name (up to 160 characters).' }
  if (phone.length > 24 || address.length > 1000 || designation.length > 120 || email.length > 254) return { error: 'One or more employee details are too long.' }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email address.' }
  if (bloodGroup && !/^(A|B|AB|O)[+-]$/.test(bloodGroup)) return { error: 'Choose a valid blood group.' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(joinDate) || Number.isNaN(Date.parse(`${joinDate}T00:00:00Z`))) return { error: 'Enter a valid joining date.' }
  return { data: { name, phone, email, address, bloodGroup, designation, joinDate: new Date(`${joinDate}T00:00:00Z`) } }
}

router.get('/employees', async (request, response, next) => {
  try {
    const employees = await prisma.employee.findMany({ where: { userId: request.userId }, orderBy: { name: 'asc' } })
    response.json({ employees })
  } catch (error) { next(error) }
})

router.post('/employees', async (request, response, next) => {
  const parsed = parseEmployee(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })
  try {
    const employee = await prisma.employee.create({ data: { ...parsed.data, userId: request.userId } })
    response.status(201).json({ employee })
  } catch (error) {
    if (error.code === 'P2002') return response.status(409).json({ message: 'An employee with this name already exists.' })
    next(error)
  }
})

function parseSalaryDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date
}

function serializeSalary(salary) {
  return {
    ...salary,
    amount: Number(salary.amount),
    fromDate: salary.fromDate.toISOString().slice(0, 10),
    toDate: salary.toDate.toISOString().slice(0, 10),
  }
}

router.get('/employees/:employeeId/salaries', async (request, response, next) => {
  const from = request.query.from ? parseSalaryDate(request.query.from) : null
  const to = request.query.to ? parseSalaryDate(request.query.to) : null
  if ((request.query.from && !from) || (request.query.to && !to)) return response.status(400).json({ message: 'Enter valid salary report dates.' })
  if (from && to && from > to) return response.status(400).json({ message: 'The start date must be before the end date.' })
  try {
    const employee = await prisma.employee.findFirst({ where: { id: request.params.employeeId, userId: request.userId } })
    if (!employee) return response.status(404).json({ message: 'Employee not found.' })
    const salaries = await prisma.employeeSalary.findMany({
      where: {
        employeeId: employee.id,
        userId: request.userId,
        ...(from ? { fromDate: { gte: from } } : {}),
        ...(to ? { toDate: { lte: to } } : {}),
      },
      orderBy: [{ fromDate: 'desc' }, { createdAt: 'desc' }],
    })
    response.json({ salaries: salaries.map(serializeSalary) })
  } catch (error) { next(error) }
})

router.post('/employees/:employeeId/salaries', async (request, response, next) => {
  const fromDate = parseSalaryDate(request.body.fromDate)
  const toDate = parseSalaryDate(request.body.toDate)
  const amount = Number(request.body.amount)
  const notes = typeof request.body.notes === 'string' ? request.body.notes.trim() : ''
  if (!fromDate || !toDate) return response.status(400).json({ message: 'Enter valid from and to dates.' })
  if (fromDate > toDate) return response.status(400).json({ message: 'The start date must be before or the same as the end date.' })
  if (!Number.isFinite(amount) || amount <= 0 || amount > 9999999999.99) return response.status(400).json({ message: 'Enter a salary amount greater than zero.' })
  if (notes.length > 1000) return response.status(400).json({ message: 'Notes must be 1000 characters or fewer.' })
  try {
    const employee = await prisma.employee.findFirst({ where: { id: request.params.employeeId, userId: request.userId } })
    if (!employee) return response.status(404).json({ message: 'Employee not found.' })
    const salary = await prisma.employeeSalary.create({
      data: { userId: request.userId, employeeId: employee.id, fromDate, toDate, amount, notes },
    })
    response.status(201).json({ salary: serializeSalary(salary) })
  } catch (error) { next(error) }
})

function parseRecord(body) {
  const employee = typeof body.employee === 'string' ? body.employee.trim() : ''
  const date = typeof body.date === 'string' ? body.date : ''
  const status = typeof body.status === 'string' ? body.status.toUpperCase() : 'PRESENT'
  const checkIn = typeof body.checkIn === 'string' ? body.checkIn : ''
  const checkOut = typeof body.checkOut === 'string' ? body.checkOut : ''
  const notes = typeof body.notes === 'string' ? body.notes.trim() : ''
  if (!employee || employee.length > 160) return { error: 'Enter an employee name (up to 160 characters).' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return { error: 'Enter a valid attendance date.' }
  if (!statuses.includes(status)) return { error: 'Choose Present, Absent, Late, or Leave.' }
  if (checkIn && !/^([01]\d|2[0-3]):[0-5]\d$/.test(checkIn)) return { error: 'Enter a valid check-in time.' }
  if (checkOut && !/^([01]\d|2[0-3]):[0-5]\d$/.test(checkOut)) return { error: 'Enter a valid check-out time.' }
  if (notes.length > 500) return { error: 'Notes must be 500 characters or fewer.' }
  return { data: { employee, date: new Date(`${date}T00:00:00Z`), status, checkIn, checkOut, notes } }
}

router.get('/', async (request, response, next) => {
  try {
    const records = await prisma.attendance.findMany({ where: { userId: request.userId }, orderBy: [{ date: 'desc' }, { employee: 'asc' }] })
    response.json({ records })
  } catch (error) { next(error) }
})

router.post('/', async (request, response, next) => {
  const parsed = parseRecord(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })
  try {
    const employee = await prisma.employee.findFirst({ where: { userId: request.userId, name: parsed.data.employee } })
    if (!employee) {
      await prisma.employee.create({ data: { userId: request.userId, name: parsed.data.employee, joinDate: parsed.data.date } })
    }
    const record = await prisma.attendance.upsert({ where: { userId_employee_date: { userId: request.userId, employee: parsed.data.employee, date: parsed.data.date } }, create: { ...parsed.data, userId: request.userId }, update: parsed.data })
    response.status(201).json({ record })
  } catch (error) { next(error) }
})

router.delete('/:id', async (request, response, next) => {
  try {
    const result = await prisma.attendance.deleteMany({ where: { id: request.params.id, userId: request.userId } })
    if (!result.count) return response.status(404).json({ message: 'Attendance record not found.' })
    response.status(204).end()
  } catch (error) { next(error) }
})

module.exports = router
