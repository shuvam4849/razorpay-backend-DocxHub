// razorpay-server.js - Complete Razorpay payment backend
require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');
const multer = require('multer');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ========== LOAD FROM .env ==========
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const CONVERTAPI_TOKEN = process.env.CONVERTAPI_TOKEN;

// Product IDs for one-time credit packages
const PRODUCT_IDS = {
    credits_20: process.env.PRODUCT_ID_20_CREDITS,
    credits_50: process.env.PRODUCT_ID_50_CREDITS,
    credits_100: process.env.PRODUCT_ID_100_CREDITS,
    credits_250: process.env.PRODUCT_ID_250_CREDITS
};

// Subscription Plan IDs
const PLAN_IDS = {
    pro: process.env.PLAN_ID_PRO,
    premium: process.env.PLAN_ID_PREMIUM
};

// ========== CURRENCY CONFIGURATION ==========
// Supported currencies with their symbols and conversion rates (1 INR = ?)
const SUPPORTED_CURRENCIES = {
    INR: { code: 'INR', symbol: '₹', rate: 1 },
    USD: { code: 'USD', symbol: '$', rate: 0.012 },
    GBP: { code: 'GBP', symbol: '£', rate: 0.0095 },
    EUR: { code: 'EUR', symbol: '€', rate: 0.011 },
    AUD: { code: 'AUD', symbol: 'A$', rate: 0.018 },
    CAD: { code: 'CAD', symbol: 'C$', rate: 0.016 },
    SGD: { code: 'SGD', symbol: 'S$', rate: 0.016 },
    AED: { code: 'AED', symbol: 'د.إ', rate: 0.044 }
};

// Function to validate and get currency
function getValidCurrency(currency) {
    return SUPPORTED_CURRENCIES[currency] ? currency : 'INR';
}

// Function to convert amount from INR to target currency
function convertAmount(amountINR, targetCurrency) {
    if (targetCurrency === 'INR') return amountINR;
    const rate = SUPPORTED_CURRENCIES[targetCurrency]?.rate || 1;
    return (amountINR * rate).toFixed(2);
}

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET
});

console.log('🔑 Razorpay initialized with Key ID:', RAZORPAY_KEY_ID);
console.log('📦 Product IDs loaded:', PRODUCT_IDS);
console.log('📦 Plan IDs loaded:', PLAN_IDS);
console.log('💱 Supported currencies:', Object.keys(SUPPORTED_CURRENCIES).join(', '));
console.log('🔄 ConvertAPI Token:', CONVERTAPI_TOKEN ? 'Set ✅' : 'Missing ❌');

// Initialize Firebase Admin (used to verify user ID tokens on protected routes)
const firebaseApp = initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const auth = getAuth(firebaseApp);
const firestore = getFirestore(firebaseApp);

// ========== AUTH MIDDLEWARE ==========
// Verifies the Firebase ID token sent by the frontend in the Authorization header
async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ success: false, error: 'Not logged in' });

    try {
        req.user = await auth.verifyIdToken(idToken);
        next();
    } catch (e) {
        console.error('❌ Token verification failed:', e.message);
        res.status(401).json({ success: false, error: 'Invalid or expired session' });
    }
}

// ========== CREDIT CHECK MIDDLEWARE ==========
// Atomically checks and deducts one credit server-side so it can't be bypassed
async function requireAndDeductCredit(req, res, next) {
    const userRef = firestore.collection('users').doc(req.user.uid);
    try {
        const remaining = await firestore.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            const credits = doc.data()?.credits ?? 5;
            if (credits <= 0) throw new Error('NO_CREDITS');
            t.update(userRef, { credits: credits - 1, lastCreditUsed: FieldValue.serverTimestamp() });
            return credits - 1;
        });
        req.remainingCredits = remaining;
        next();
    } catch (e) {
        if (e.message === 'NO_CREDITS') {
            return res.status(402).json({ success: false, error: 'No credits remaining', requiresUpgrade: true });
        }
        console.error('❌ Credit check failed:', e.message);
        res.status(500).json({ success: false, error: 'Credit check failed' });
    }
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ========== RESUME TEMPLATE CREDIT CHECK ==========
// Mirrors the free/paid template list from template-selector.html, but enforced
// server-side — the frontend's own credit deduction can be skipped by a user
// who calls this endpoint directly, so this is the real gate.
const FREE_TEMPLATES = new Set(['tech-modern', 'corporate-blue', 'academic']);
const TEMPLATE_COST = 5;

async function requireCreditsForTemplate(req, res, next) {
    const { templateId } = req.body;
    if (!templateId) return res.status(400).json({ success: false, error: 'Missing templateId' });

    const userRef = firestore.collection('users').doc(req.user.uid);
    try {
        const remaining = await firestore.runTransaction(async (t) => {
            const doc = await t.get(userRef);
            const data = doc.data() || {};
            const isPro = data.subscription?.status === 'active' && data.subscription?.plan === 'pro';
            const cost = (FREE_TEMPLATES.has(templateId) || isPro) ? 0 : TEMPLATE_COST;
            const credits = data.credits ?? 5;

            if (cost === 0) return credits;
            if (credits < cost) throw new Error('NO_CREDITS');

            t.update(userRef, { credits: credits - cost, lastCreditUsed: FieldValue.serverTimestamp() });
            return credits - cost;
        });
        req.remainingCredits = remaining;
        next();
    } catch (e) {
        if (e.message === 'NO_CREDITS') {
            return res.status(402).json({ success: false, error: `This template requires ${TEMPLATE_COST} credits`, requiresUpgrade: true });
        }
        console.error('❌ Template credit check failed:', e.message);
        res.status(500).json({ success: false, error: 'Credit check failed' });
    }
}

// Strip anything unsafe out of a user-supplied filename before it hits a header
function sanitizeFilename(name) {
    const cleaned = (name || 'resume').replace(/[^a-zA-Z0-9_\-]/g, '_');
    return `${cleaned.slice(0, 100)}.pdf`;
}

// ========== RESUME PDF GENERATION (PUPPETEER) ==========
app.post('/api/generate-pdf', requireAuth, requireCreditsForTemplate, async (req, res) => {
    let browser = null;
    try {
        const { html, css } = req.body;
        const filename = sanitizeFilename(req.body.filename);

        if (!html || html.trim() === '') {
            return res.status(400).json({ success: false, error: 'No HTML content provided' });
        }

        console.log(`📄 Generating PDF (${filename}) for user ${req.user.uid} — HTML: ${html.length} chars, CSS: ${(css || '').length} chars`);

        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless
        });

        const page = await browser.newPage();

        const fullHTML = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
                <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
                <style>
                    * { margin: 0; padding: 0; box-sizing: border-box; }
                    body { margin: 0; padding: 20px; background: white; font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif; }
                    ${css || ''}
                </style>
            </head>
            <body>${html}</body>
            </html>
        `;

        await page.setContent(fullHTML, { waitUntil: ['networkidle0', 'load', 'domcontentloaded'], timeout: 30000 });
        await page.evaluateHandle('document.fonts.ready');
        await new Promise(resolve => setTimeout(resolve, 500));

        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '15mm', right: '15mm', bottom: '15mm', left: '15mm' },
            displayHeaderFooter: false,
            preferCSSPageSize: true,
            scale: 1
        });

        console.log('✅ PDF generated:', pdf.length, 'bytes');

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('X-Remaining-Credits', req.remainingCredits);
        res.send(pdf);

    } catch (error) {
        console.error('❌ PDF Generation Error:', error);
        res.status(500).json({ success: false, error: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

// Store customer IDs in memory (use database in production)
const customerCache = new Map();

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        razorpay_key_set: !!RAZORPAY_KEY_ID,
        supported_currencies: Object.keys(SUPPORTED_CURRENCIES),
        message: 'Server is running'
    });
});

// Add rate limiting to backend
const rateLimit = require('express-rate-limit');

const paymentLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: 'Too many payment attempts. Please try again later.'
});

// ========== CREATE ORDER FOR ONE-TIME CREDIT PACKAGE ==========
app.post('/api/create-credit-order', async (req, res) => {
    try {
        console.log('📦 Create credit order request:', req.body);
        
        const { productKey, credits, amount, userId, email, name, currency = 'INR' } = req.body;
        
        // Validate and get currency
        const validCurrency = getValidCurrency(currency);
        
        // amount is in INR from frontend, convert if needed
        let amountInCurrency = amount;
        if (validCurrency !== 'INR') {
            amountInCurrency = convertAmount(amount, validCurrency);
        }
        
        // Convert to smallest unit (paise for INR, cents for others)
        const amountInSmallestUnit = Math.round(amountInCurrency * 100);
        
        console.log(`💰 Amount: ${amount} INR → ${amountInCurrency} ${validCurrency} (${amountInSmallestUnit} ${validCurrency === 'INR' ? 'paise' : 'cents'})`);
        
        const options = {
            amount: amountInSmallestUnit,
            currency: validCurrency,
            receipt: `credit_${credits}_${Date.now()}`,
            notes: {
                userId: userId,
                credits: credits,
                productKey: productKey,
                type: 'one_time_credit_package',
                email: email || '',
                name: name || '',
                platform: 'DocxHub',
                originalCurrency: 'INR',
                originalAmount: String(amount)
            }
        };
        
        console.log('📝 Creating order with options:', options);
        
        const order = await razorpay.orders.create(options);
        
        console.log('✅ Order created:', order.id);
        
        res.json({
            success: true,
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            keyId: RAZORPAY_KEY_ID
        });
        
    } catch (error) {
        console.error('❌ Error creating credit order:', error);
        res.status(500).json({ 
            success: false, 
            error: error.error?.description || error.message 
        });
    }
});

// ========== CREATE SUBSCRIPTION ORDER ==========
app.post('/api/create-subscription-order', async (req, res) => {
    try {
        console.log('📦 Create subscription request:', req.body);
        
        const { plan, credits, amount, userId, email, name, currency = 'INR' } = req.body;
        
        const planId = plan === 'pro' ? PLAN_IDS.pro : PLAN_IDS.premium;
        
        console.log('📝 Using Plan ID:', planId);
        console.log('💰 Currency requested:', currency);
        
        // Try to find existing customer first
        let customerId = customerCache.get(userId);
        
        if (!customerId) {
            try {
                const customers = await razorpay.customers.all({
                    count: 100
                });
                
                const existingCustomer = customers.items.find(c => c.email === email);
                
                if (existingCustomer) {
                    customerId = existingCustomer.id;
                    customerCache.set(userId, customerId);
                    console.log('✅ Found existing customer:', customerId);
                }
            } catch (searchError) {
                console.log('⚠️ Error searching customers:', searchError.message);
            }
        }
        
        if (!customerId) {
            try {
                const customer = await razorpay.customers.create({
                    name: name || email,
                    email: email,
                    notes: {
                        userId: userId
                    }
                });
                customerId = customer.id;
                customerCache.set(userId, customerId);
                console.log('✅ Created new customer:', customerId);
            } catch (customerError) {
                console.error('❌ Customer creation error:', customerError);
                if (customerError.error?.description?.includes('already exists')) {
                    const customers = await razorpay.customers.all({
                        email: email,
                        count: 1
                    });
                    if (customers.items.length > 0) {
                        customerId = customers.items[0].id;
                        customerCache.set(userId, customerId);
                        console.log('✅ Found existing customer after error:', customerId);
                    } else {
                        throw customerError;
                    }
                } else {
                    throw customerError;
                }
            }
        }
        
        // Note: Razorpay subscriptions are created in INR only
        // The currency parameter is stored in notes for reference
        const subscription = await razorpay.subscriptions.create({
            plan_id: planId,
            customer_id: customerId,
            total_count: 12,
            quantity: 1,
            notes: {
                userId: userId,
                plan: plan,
                creditsPerMonth: String(credits),
                displayCurrency: currency,
                originalAmountINR: String(amount)
            }
        });
        
        console.log('✅ Subscription created:', subscription.id);
        
        res.json({
            success: true,
            subscriptionId: subscription.id,
            customerId: customerId,
            keyId: RAZORPAY_KEY_ID
        });
        
    } catch (error) {
        console.error('❌ Error creating subscription:', error);
        res.status(500).json({ 
            success: false, 
            error: error.error?.description || error.message 
        });
    }
});

// ========== VERIFY PAYMENT ==========
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { orderId, paymentId, signature, credits, userId } = req.body;
        
        console.log('🔐 Verifying payment:', { orderId, paymentId, credits, userId });
        
        // Verify signature
        const body = orderId + '|' + paymentId;
        const expectedSignature = crypto
            .createHmac('sha256', RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');
        
        if (expectedSignature === signature) {
            console.log('✅ Payment verified successfully');
            res.json({ 
                success: true, 
                message: 'Payment verified successfully',
                credits: credits
            });
        } else {
            console.log('❌ Invalid signature');
            res.status(400).json({ success: false, error: 'Invalid signature' });
        }
        
    } catch (error) {
        console.error('❌ Error verifying payment:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== GET EXCHANGE RATES (NEW ENDPOINT) ==========
app.get('/api/exchange-rates', (req, res) => {
    const rates = {};
    for (const [code, config] of Object.entries(SUPPORTED_CURRENCIES)) {
        rates[code] = {
            code: config.code,
            symbol: config.symbol,
            rate: config.rate
        };
    }
    res.json({ 
        success: true, 
        base: 'INR',
        rates: rates,
        supportedCurrencies: Object.keys(SUPPORTED_CURRENCIES)
    });
});

// ========== FILE CONVERSION (PROXIES CONVERTAPI — TOKEN NEVER LEAVES THE SERVER) ==========
app.post('/api/convert', requireAuth, requireAndDeductCredit, upload.single('file'), async (req, res) => {
    try {
        const { from, to } = req.body; // e.g. from=pdf, to=docx
        if (!req.file || !from || !to) {
            return res.status(400).json({ success: false, error: 'Missing file, from, or to' });
        }

        console.log(`🔄 Converting ${req.file.originalname}: ${from} → ${to} for user ${req.user.uid}`);

        const form = new FormData();
        form.append('File', new Blob([req.file.buffer]), req.file.originalname);
        form.append('StoreFile', 'true');
        if (req.body.ocr === 'true') {
            form.append('Ocr', 'true');
            form.append('OcrLanguage', 'eng');
        }

        const convertUrl = `https://v2.convertapi.com/convert/${from}/to/${to}?download=attachment`;

        const response = await fetch(convertUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${CONVERTAPI_TOKEN}` },
            body: form
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('❌ ConvertAPI error:', errText);
            return res.status(response.status).json({ success: false, error: 'Conversion failed' });
        }

        console.log('✅ Conversion complete:', req.file.originalname);

        res.set('Content-Type', response.headers.get('content-type'));
        res.set('Content-Disposition', response.headers.get('content-disposition') || `attachment; filename=converted.${to}`);
        res.set('X-Remaining-Credits', req.remainingCredits);
        const buffer = Buffer.from(await response.arrayBuffer());
        res.send(buffer);

    } catch (error) {
        console.error('❌ Conversion error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ========== TEST ENDPOINT ==========
app.post('/api/test', (req, res) => {
    console.log('Test endpoint hit:', req.body);
    res.json({ success: true, message: 'Test endpoint working' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Razorpay payment server running on port ${PORT}`);
    console.log(`📍 API URL: http://localhost:${PORT}`);
    console.log(`🔑 Razorpay Key: ${RAZORPAY_KEY_ID ? 'Set ✅' : 'Missing ❌'}`);
    console.log(`🔐 Razorpay Secret: ${RAZORPAY_KEY_SECRET ? 'Set ✅' : 'Missing ❌'}`);
    console.log(`📦 Pro Plan ID: ${PLAN_IDS.pro}`);
    console.log(`📦 Premium Plan ID: ${PLAN_IDS.premium}`);
    console.log(`💱 Supported Currencies: ${Object.keys(SUPPORTED_CURRENCIES).join(', ')}`);
    console.log(`🔄 ConvertAPI Token: ${CONVERTAPI_TOKEN ? 'Set ✅' : 'Missing ❌'}`);
});