require('dotenv').config()

const cors = require('cors')
const express = require('express')
const helmet = require('helmet')
const authRoutes = require('./routes/auth')
const productRoutes = require('./routes/products')
const gstRateRoutes = require('./routes/gstRates')
const customerRoutes = require('./routes/customers')
const bankRoutes = require('./routes/banks')
const invoiceRoutes = require('./routes/invoices')
const dashboardRoutes = require('./routes/dashboard')
const reportRoutes = require('./routes/reports')
const expenseRoutes = require('./routes/expenses')
const attendanceRoutes = require('./routes/attendance')

const app = express()
const port = Number(process.env.PORT) || 3000

app.use(helmet())
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }))
app.use(express.json())
app.use('/api/auth', authRoutes)
app.use('/api/products', productRoutes)
app.use('/api/gst-rates', gstRateRoutes)
app.use('/api/customers', customerRoutes)
app.use('/api/banks', bankRoutes)
app.use('/api/invoices', invoiceRoutes)
app.use('/api/dashboard', dashboardRoutes)
app.use('/api/reports', reportRoutes)
app.use('/api/expenses', expenseRoutes)
app.use('/api/attendance', attendanceRoutes)

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok' })
})

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(500).json({ message: 'Something went wrong. Please try again.' })
})

app.listen(port, () => {
  console.log(`My Bill Book API listening on http://localhost:${port}`)
})
