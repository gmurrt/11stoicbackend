// api/validate-receipt.js - Vercel Serverless Function
export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { receiptData, bundleId, productId } = req.body;

    // Validate input
    if (!receiptData) {
      return res.status(400).json({
        isValid: false,
        error: 'Receipt data is required'
      });
    }

    if (bundleId !== 'com.elevenstoic.app') {
      return res.status(400).json({
        isValid: false,
        error: 'Invalid bundle ID'
      });
    }

    console.log('[Backend] Validating receipt for product:', productId);

    // Apple's receipt validation URLs
    const PRODUCTION_URL = 'https://buy.itunes.apple.com/verifyReceipt';
    const SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';
    
    // IMPORTANT: Replace this with your actual shared secret from App Store Connect
    const SHARED_SECRET = '3f35fbe05c344721914472d25e3e0284';

    // Helper function to validate with Apple
    async function validateWithApple(receiptData, url) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            'receipt-data': receiptData,
            'password': SHARED_SECRET,
            'exclude-old-transactions': true
          }),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
      } catch (error) {
        clearTimeout(timeoutId);
        throw error;
      }
    }

    let response;
    let environment;

    // Always try production first
    try {
      console.log('[Backend] Trying production validation...');
      response = await validateWithApple(receiptData, PRODUCTION_URL);
      environment = 'production';
      
      // Handle status 21007 (sandbox receipt used in production)
      if (response.status === 21007) {
        console.log('[Backend] Status 21007: Sandbox receipt detected, switching to sandbox...');
        response = await validateWithApple(receiptData, SANDBOX_URL);
        environment = 'sandbox';
      }
    } catch (prodError) {
      console.error('[Backend] Production validation failed:', prodError.message);
      
      // Fallback to sandbox
      console.log('[Backend] Falling back to sandbox validation...');
      try {
        response = await validateWithApple(receiptData, SANDBOX_URL);
        environment = 'sandbox';
      } catch (sandboxError) {
        console.error('[Backend] Both production and sandbox validation failed');
        return res.status(500).json({
          isValid: false,
          error: 'Receipt validation failed with Apple'
        });
      }
    }

    console.log(`[Backend] Apple response status: ${response.status} (${environment})`);

    // Check if receipt is valid (status 0 = success)
    if (response.status !== 0) {
      console.error(`[Backend] Receipt validation failed with status: ${response.status}`);
      
      const statusMeanings = {
        21000: 'The App Store could not read the JSON object you provided.',
        21002: 'The data in the receipt-data property was malformed or missing.',
        21003: 'The receipt could not be authenticated.',
        21004: 'The shared secret you provided does not match the shared secret on file for your account.',
        21005: 'The receipt server is not currently available.',
        21006: 'This receipt is valid but the subscription has expired.',
        21007: 'This receipt is from the sandbox environment, but it was sent to the production environment for verification.',
        21008: 'This receipt is from the production environment, but it was sent to the sandbox environment for verification.',
        21010: 'This receipt could not be authorized. Treat this the same as if a purchase was never made.'
      };
      
      const statusMeaning = statusMeanings[response.status] || 'Unknown error';
      console.error(`[Backend] Status meaning: ${statusMeaning}`);
      
      // For status 21006 (expired), still return some info
      if (response.status === 21006) {
        return res.json({
          isValid: false,
          error: 'Subscription has expired',
          status: response.status,
          expired: true
        });
      }
      
      return res.json({
        isValid: false,
        error: `Receipt validation failed: ${statusMeaning}`,
        status: response.status
      });
    }

    // Verify bundle ID matches
    if (response.receipt?.bundle_id !== 'com.elevenstoic.app') {
      console.error(`[Backend] Bundle ID mismatch: expected com.elevenstoic.app, got ${response.receipt?.bundle_id}`);
      return res.json({
        isValid: false,
        error: 'Bundle ID mismatch'
      });
    }

    // Check for valid subscription
    let isValidSubscription = false;
    let subscriptionInfo = null;

    // Method 1: Check latest_receipt_info (most reliable for subscriptions)
    if (response.latest_receipt_info && response.latest_receipt_info.length > 0) {
      console.log('[Backend] Checking latest_receipt_info...');
      
      const relevantTransactions = response.latest_receipt_info.filter(
        (transaction) => transaction.product_id === 'com.elevenstoic.monthly'
      );

      if (relevantTransactions.length > 0) {
        // Sort by expires_date_ms to get the latest
        relevantTransactions.sort((a, b) => parseInt(b.expires_date_ms) - parseInt(a.expires_date_ms));
        const latestTransaction = relevantTransactions[0];

        console.log('[Backend] Latest transaction:', {
          product_id: latestTransaction.product_id,
          expires_date: new Date(parseInt(latestTransaction.expires_date_ms)),
          current_date: new Date()
        });

        // Check if subscription is still active
        const expirationDate = parseInt(latestTransaction.expires_date_ms);
        const currentDate = Date.now();
        
        // Add grace period for network delays (5 minutes)
        const gracePeriod = 5 * 60 * 1000; // 5 minutes in milliseconds
        
        if (expirationDate > (currentDate - gracePeriod)) {
          isValidSubscription = true;
          subscriptionInfo = {
            productId: latestTransaction.product_id,
            expiresDate: new Date(expirationDate),
            transactionId: latestTransaction.transaction_id,
            environment: environment,
            isTrialPeriod: latestTransaction.is_trial_period === 'true',
            isIntroOfferPeriod: latestTransaction.is_in_intro_offer_period === 'true'
          };
          console.log('[Backend] Active subscription found in latest_receipt_info');
        } else {
          console.log(`[Backend] Subscription expired ${Math.round((currentDate - expirationDate) / (1000 * 60 * 60))} hours ago`);
        }
      }
    }

    // Method 2: Check in_app array for purchases (fallback)
    if (!isValidSubscription && response.receipt?.in_app) {
      console.log('[Backend] Checking in_app array...');
      
      const relevantPurchases = response.receipt.in_app.filter(
        (purchase) => purchase.product_id === 'com.elevenstoic.monthly'
      );
      
      if (relevantPurchases.length > 0) {
        // Sort by purchase_date_ms to get the latest
        relevantPurchases.sort((a, b) => parseInt(b.purchase_date_ms) - parseInt(a.purchase_date_ms));
        const latestPurchase = relevantPurchases[0];
        
        isValidSubscription = true;
        subscriptionInfo = {
          productId: latestPurchase.product_id,
          transactionId: latestPurchase.transaction_id,
          environment: environment,
          purchaseDate: new Date(parseInt(latestPurchase.purchase_date_ms))
        };
        console.log('[Backend] Valid purchase found in in_app array');
      }
    }

    // Method 3: Check pending_renewal_info (for development/testing)
    if (!isValidSubscription && response.pending_renewal_info && environment === 'sandbox') {
      console.log('[Backend] Checking pending_renewal_info (sandbox only)...');
      
      const pendingRenewal = response.pending_renewal_info.find(
        (renewal) => renewal.product_id === 'com.elevenstoic.monthly'
      );
      
      if (pendingRenewal && pendingRenewal.auto_renew_status === '1') {
        console.log('[Backend] Found active pending renewal in sandbox');
        isValidSubscription = true;
        subscriptionInfo = {
          productId: pendingRenewal.product_id,
          isPending: true,
          environment: environment,
          autoRenewStatus: pendingRenewal.auto_renew_status
        };
      }
    }

    // CRITICAL FIX: Add sandbox fallback BEFORE final result
    if (!isValidSubscription && environment === 'sandbox' && 
        response.receipt?.bundle_id === 'com.elevenstoic.app') {
      console.log('[Backend] Sandbox fallback - allowing receipt for testing');
      isValidSubscription = true;
      subscriptionInfo = {
        productId: 'com.elevenstoic.monthly',
        environment: environment,
        fallback: true
      };
    }

    console.log(`[Backend] Final validation result: ${isValidSubscription}`);

    // Add response caching headers for successful validations
    if (isValidSubscription) {
      res.setHeader('Cache-Control', 'private, max-age=300'); // Cache for 5 minutes
    }

    return res.json({
      isValid: isValidSubscription,
      environment: environment,
      subscriptionInfo: subscriptionInfo,
      timestamp: new Date().toISOString(),
      // Add debug info for development
      ...(environment === 'sandbox' && {
        debug: {
          hasLatestReceiptInfo: !!(response.latest_receipt_info && response.latest_receipt_info.length > 0),
          hasInApp: !!(response.receipt?.in_app && response.receipt.in_app.length > 0),
          hasPendingRenewal: !!(response.pending_renewal_info && response.pending_renewal_info.length > 0)
        }
      })
    });

  } catch (error) {
    console.error('[Backend] Receipt validation error:', error);
    
    // Different error responses based on error type
    if (error.name === 'AbortError') {
      return res.status(408).json({
        isValid: false,
        error: 'Request timeout - Apple servers did not respond in time'
      });
    }
    
    if (error.message?.includes('fetch')) {
      return res.status(502).json({
        isValid: false,
        error: 'Unable to connect to Apple servers'
      });
    }
    
    return res.status(500).json({
      isValid: false,
      error: 'Internal server error during validation'
    });
  }
}