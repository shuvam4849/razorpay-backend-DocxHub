// razorpay-server.js - Complete Razorpay payment backend
require('dotenv').config();
const express = require('express');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ========== LOAD FROM .env ==========
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

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

// Initialize Razorpay
const razorpay = new Razorpay({
    key_id: RAZORPAY_KEY_ID,
    key_secret: RAZORPAY_KEY_SECRET
});

console.log('🔑 Razorpay initialized with Key ID:', RAZORPAY_KEY_ID);
console.log('📦 Product IDs loaded:', PRODUCT_IDS);
console.log('📦 Plan IDs loaded:', PLAN_IDS);

// Store customer IDs in memory (use database in production)
const customerCache = new Map();

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        razorpay_key_set: !!RAZORPAY_KEY_ID,
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
        
        const { productKey, credits, amount, userId, email, name } = req.body;
        
        // amount is already in rupees from frontend (e.g., 399, 799, 1199, 2499)
        // Convert to paise (1 Rupee = 100 paise)
        const amountInPaise = amount * 100;
        
        console.log(`💰 Amount: ₹${amount} (${amountInPaise} paise)`);
        
        const options = {
            amount: amountInPaise,
            currency: 'INR',
            receipt: `credit_${credits}_${Date.now()}`,
            notes: {
                userId: userId,
                credits: credits,
                productKey: productKey,
                type: 'one_time_credit_package',
                email: email || '',
                name: name || '',
                platform: 'DocxHub'
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

// ========== CREATE SUBSCRIPTION ORDER (FIXED) ==========
app.post('/api/create-subscription-order', async (req, res) => {
    try {
        console.log('📦 Create subscription request:', req.body);
        
        const { plan, credits, amount, userId, email, name } = req.body;
        
        const planId = plan === 'pro' ? PLAN_IDS.pro : PLAN_IDS.premium;
        
        console.log('📝 Using Plan ID:', planId);
        
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
        
        // FIXED: Use total_count = 12 (12 months) or 24 (2 years)
        // Do NOT use 999 as it causes UPI expiry error
        const subscription = await razorpay.subscriptions.create({
            plan_id: planId,
            customer_id: customerId,
            total_count: 12,  // Changed from 999 to 12 (1 year subscription)
            quantity: 1,
            notes: {
                userId: userId,
                plan: plan,
                creditsPerMonth: String(credits)
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
});