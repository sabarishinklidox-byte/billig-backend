const express = require('express')
const prisma = require('../db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

function parseCustomer(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const gstin = typeof body.gstin === 'string' ? body.gstin.trim().toUpperCase() : ''
  const doorNumber = typeof body.doorNumber === 'string' ? body.doorNumber.trim() : ''
  const pan = typeof body.pan === 'string' ? body.pan.trim().toUpperCase() : ''
  const pincode = typeof body.pincode === 'string' ? body.pincode.trim() : ''
  const billingAddress = typeof body.billingAddress === 'string' ? body.billingAddress.trim() : ''
  const notes = typeof body.notes === 'string' ? body.notes.trim() : ''
  const openingBalance = Number(body.openingBalance ?? 0)

  if (!name) return { error: 'Customer name is required.' }
  if (name.length > 160 || phone.length > 24 || email.length > 254 || doorNumber.length > 80 || pan.length > 10 || pincode.length > 10 || billingAddress.length > 1000 || notes.length > 1000) {
    return { error: 'One or more customer fields are too long.' }
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email address.' }
  if (gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) return { error: 'Enter a valid 15-character GSTIN.' }
  if (pan && !/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) return { error: 'Enter a valid 10-character PAN.' }
  if (pincode && !/^[A-Za-z0-9 -]{3,10}$/.test(pincode)) return { error: 'Enter a valid PIN code.' }
  if (!Number.isFinite(openingBalance) || Math.abs(openingBalance) > 9999999999) return { error: 'Opening balance must be a valid amount.' }

  return { data: { name, phone, email, gstin, doorNumber, pan, pincode, billingAddress, openingBalance, notes } }
}

function serializeCustomer(customer) {
  return { ...customer, openingBalance: Number(customer.openingBalance) }
}

function findProfileValue(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 7) return ''
  for (const [key, nested] of Object.entries(value)) {
    if (keys.includes(key.toLowerCase()) && typeof nested === 'string' && nested.trim()) return nested.trim()
  }
  for (const nested of Object.values(value)) {
    const found = findProfileValue(nested, keys, depth + 1)
    if (found) return found
  }
  return ''
}

function formatProfileAddress(value) {
  const addressKeys = ['registeredaddress', 'registered_address', 'principalplaceofbusiness', 'principal_address', 'pradr', 'address', 'addr']
  const addressValue = findProfileValue(value, addressKeys)
  if (addressValue) return addressValue

  const parts = ['buildingname', 'bnm', 'buildingno', 'bno', 'floorno', 'flno', 'street', 'road', 'st', 'locality', 'loc', 'district', 'dst', 'city', 'state', 'stcd', 'pincode', 'pincode', 'pncd', 'postalcode']
  const found = []
  for (const key of parts) {
    const part = findProfileValue(value, [key])
    if (part && !found.includes(part)) found.push(part)
  }
  return found.join(', ')
}

router.get('/gstin/:gstin', async (request, response) => {
  const gstin = String(request.params.gstin || '').trim().toUpperCase()
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(gstin)) {
    return response.status(400).json({ message: 'Enter a valid 15-character GSTIN.' })
  }
  const rapidApiKey = process.env.RAPIDAPI_KEY
  const rapidApiHost = process.env.RAPIDAPI_GST_HOST || 'gst-verification-api-get-profile-returns-data.p.rapidapi.com'
  if (!rapidApiKey) {
    return response.status(503).json({ message: 'GSTIN lookup is not configured. Add RAPIDAPI_KEY to the backend .env file.' })
  }

  try {
    const upstream = await fetch(`https://${rapidApiHost}/v1/gstin/${encodeURIComponent(gstin)}/details`, {
      headers: {
        'x-rapidapi-key': rapidApiKey,
        'x-rapidapi-host': rapidApiHost,
      },
      signal: AbortSignal.timeout(10000),
    })
    const payload = await upstream.json().catch(() => ({}))
    if (!upstream.ok) {
      return response.status(upstream.status === 404 ? 404 : 502).json({ message: 'Could not find GST registration details for this GSTIN.' })
    }
    const legalName = findProfileValue(payload, ['legal_name', 'legalname', 'lgnm', 'legalnameofbusiness', 'businesslegalname', 'taxpayername'])
    const tradeName = findProfileValue(payload, ['trade_name', 'tradename', 'tradenam', 'trade_name_of_business', 'business_name', 'businessname'])
    const address = formatProfileAddress(payload)
    if (!legalName && !tradeName && !address) {
      return response.status(502).json({ message: 'The API returned GST status but no business name or address. Check the selected RapidAPI endpoint and response fields.' })
    }
    return response.json({ details: {
      gstin: findProfileValue(payload, ['gstin', 'gstinnumber']) || gstin,
      legalName,
      tradeName,
      address,
      doorNumber: findProfileValue(payload, ['doorno', 'doornumber', 'buildingno', 'buildingnumber', 'flatno', 'flatnumber', 'houseno', 'house_number', 'bno']),
      phone: findProfileValue(payload, ['mobile', 'mobileno', 'mobile_no', 'phone', 'phonenumber', 'contactnumber']),
      pan: findProfileValue(payload, ['pan', 'pannumber']) || gstin.slice(2, 12),
      pincode: findProfileValue(payload, ['pincode', 'pin_code', 'pncd', 'postalcode']),
      status: findProfileValue(payload, ['status', 'registrationstatus', 'sts']),
    } })
  } catch {
    return response.status(502).json({ message: 'GSTIN lookup is temporarily unavailable. Please try again.' })
  }
})

router.get('/', async (request, response, next) => {
  try {
    const search = typeof request.query.q === 'string' ? request.query.q.trim() : ''
    const customers = await prisma.customer.findMany({
      where: {
        userId: request.userId,
        ...(search ? { OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
          { gstin: { contains: search, mode: 'insensitive' } },
        ] } : {}),
      },
      orderBy: { name: 'asc' },
    })
    return response.json({ customers: customers.map(serializeCustomer) })
  } catch (error) {
    return next(error)
  }
})

router.post('/', async (request, response, next) => {
  const parsed = parseCustomer(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })

  try {
    const customer = await prisma.customer.create({ data: { ...parsed.data, userId: request.userId } })
    return response.status(201).json({ customer: serializeCustomer(customer) })
  } catch (error) {
    return next(error)
  }
})

router.put('/:id', async (request, response, next) => {
  const parsed = parseCustomer(request.body)
  if (parsed.error) return response.status(400).json({ message: parsed.error })

  try {
    const result = await prisma.customer.updateMany({
      where: { id: request.params.id, userId: request.userId },
      data: parsed.data,
    })
    if (!result.count) return response.status(404).json({ message: 'Customer not found.' })
    const customer = await prisma.customer.findFirst({ where: { id: request.params.id, userId: request.userId } })
    return response.json({ customer: serializeCustomer(customer) })
  } catch (error) {
    return next(error)
  }
})

router.delete('/:id', async (request, response, next) => {
  try {
    const result = await prisma.customer.deleteMany({ where: { id: request.params.id, userId: request.userId } })
    if (!result.count) return response.status(404).json({ message: 'Customer not found.' })
    return response.status(204).end()
  } catch (error) {
    return next(error)
  }
})

module.exports = router
