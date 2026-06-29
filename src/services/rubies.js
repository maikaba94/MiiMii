const axios = require('axios');
const logger = require('../utils/logger');
// Models removed - using Supabase client instead
const { axiosConfig } = require('../utils/httpsAgent');
const whatsappService = require('./whatsapp');
const RetryHelper = require('../utils/retryHelper');
const activityLogger = require('./activityLogger');

class RubiesService {
  constructor() {
    // Rubies API URLs - from actual documentation
    this.devURL = 'https://api-sme-dev.rubies.ng/dev';
    this.productionURL = 'https://api-sme.rubies.ng/prod'; // Production URL from documentation

    // Environment detection - Force production environment
    const overrideEnv = (process.env.RUBIES_ENV || process.env.APP_ENV || '').toLowerCase();
    const isProduction = overrideEnv
      ? overrideEnv === 'prod' || overrideEnv === 'production'
      : process.env.NODE_ENV === 'production';

    // Force production environment
    this.selectedEnvironment = 'production';
    this.baseURL = this.productionURL;

    // Rubies API credentials - Uses Authorization header with API key (sk_test_ or sk_live_)
    this.apiKey = process.env.RUBIES_API_KEY;
    this.webhookSecret = process.env.RUBIES_WEBHOOK_SECRET;
    
    // Rate limiting
    this.lastRequestTime = 0;
    this.requestQueue = [];
    this.isProcessingQueue = false;

    // Circuit breaker for Rubies API
    this.circuitBreaker = RetryHelper.createCircuitBreaker({
      failureThreshold: 3,
      resetTimeout: 300000, // 5 minutes
      monitoringPeriod: 60000, // 1 minute
      operationName: 'rubies_api'
    });

    // Safe runtime config log (no secrets leaked)
    const mask = (val) => {
      if (!val) return 'MISSING';
      const s = String(val);
      if (s.length <= 6) return `${s[0] || ''}***${s[s.length - 1] || ''}`;
      return `${s.slice(0, 8)}***${s.slice(-4)}`;
    };

    logger.info('RubiesService initialized', {
      nodeEnv: process.env.NODE_ENV || 'undefined',
      selectedEnvironment: this.selectedEnvironment,
      baseURL: this.baseURL,
      hasApiKey: !!this.apiKey,
      apiKeyPreview: mask(this.apiKey),
      apiKeyPrefix: this.apiKey ? this.apiKey.substring(0, 7) : 'MISSING'
    });
  }

  async makeRequest(method, endpoint, data = {}, additionalHeaders = {}) {
    return await RetryHelper.retryBankApiCall(async () => {
      // Rate limiting
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < 200) {
        await new Promise(resolve => setTimeout(resolve, 200 - timeSinceLastRequest));
      }
      this.lastRequestTime = Date.now();

      // Validate API key
      if (!this.apiKey) {
        throw new Error('RUBIES_API_KEY environment variable is required');
      }

      const config = {
        ...axiosConfig,
        method,
        url: `${this.baseURL}${endpoint}`,
        headers: {
          ...axiosConfig.headers,
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'Authorization': this.apiKey, // Direct API key as shown in documentation
          ...additionalHeaders
        },
        timeout: 30000
      };

      if (method.toLowerCase() === 'get') {
        config.params = data;
      } else {
        config.data = data;
      }

      logger.debug('Making Rubies API request', {
        method,
        endpoint,
        hasData: Object.keys(data).length > 0,
        environment: this.selectedEnvironment
      });

      const response = await axios(config);
      
      logger.debug('Rubies API response', {
        status: response.status,
        responseCode: response.data?.responseCode,
        endpoint
      });

      return response.data;
    }, {
      operationName: `rubies_${method.toLowerCase()}_${endpoint.replace(/\//g, '_')}`
    });
  }

  // BVN Validation Service - Based on baas-kyc section
  async validateBVN(bvnData) {
    try {
      const { bvn, firstName, lastName, dateOfBirth, phoneNumber } = bvnData;
      
      // Validate required fields
      if (!bvn || bvn.length !== 11 || !/^\d{11}$/.test(bvn)) {
        throw new Error('Invalid BVN format. BVN must be exactly 11 digits.');
      }

      // Prepare payload based on Rubies production documentation
      const payload = {
        bvn: bvn.toString().trim(),
        dob: dateOfBirth ? this.formatDateForRubies(dateOfBirth) : undefined,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        reference: `BVN_${Date.now()}_${bvnData.userId || 'unknown'}`
      };

      // Remove undefined fields
      Object.keys(payload).forEach(key => payload[key] === undefined && delete payload[key]);

      logger.info('Starting Rubies BVN validation', {
        bvnMasked: `***${bvn.slice(-4)}`,
        environment: this.selectedEnvironment
      });

      // Check if we should use fallback mode (only for development/testing)
      const useFallback = process.env.RUBIES_FALLBACK_MODE === 'true' && 
                         process.env.NODE_ENV === 'development';

      if (useFallback) {
        logger.info('Using fallback BVN validation mode', {
          bvnMasked: `***${bvn.slice(-4)}`,
          reason: !process.env.RUBIES_API_KEY ? 'No API key' : 'Fallback mode enabled'
        });

        // Simulate successful validation for development
        return {
          success: true,
          data: {
            first_name: firstName || 'Test',
            last_name: lastName || 'User',
            phone_number1: phoneNumber || '08000000000'
          },
          responseCode: '00',
          responseMessage: 'Fallback validation successful',
          bvn_data: {
            first_name: firstName || 'Test',
            last_name: lastName || 'User',
            phone_number1: phoneNumber || '08000000000'
          }
        };
      }

      // BVN validation endpoint - using working endpoint from test
      const response = await this.makeRequest('POST', '/baas-kyc/bvn-validation', payload);

      if (response.responseCode === '00') {
        logger.info('Rubies BVN validation successful', {
          bvnMasked: `***${bvn.slice(-4)}`,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        });

        // Log activity
        await activityLogger.logUserActivity(
          bvnData.userId || null,
          'kyc_verification',
          'bvn_verified',
          {
            source: 'api',
            description: 'BVN verification successful via Rubies',
            bvnMasked: `***${bvn.slice(-4)}`,
            provider: 'rubies',
            responseCode: response.responseCode,
            responseMessage: response.responseMessage,
            success: true,
            ipAddress: bvnData.ipAddress || null,
            userAgent: bvnData.userAgent || null
          }
        );

        return {
          success: true,
          data: response.data,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage,
          bvn_data: response.data // Customer details from BVN
        };
      } else {
        throw new Error(response.responseMessage || 'BVN verification failed');
      }
    } catch (error) {
      logger.error('Rubies BVN validation error', {
        error: error.message,
        bvnMasked: bvnData.bvn ? `***${bvnData.bvn.slice(-4)}` : 'unknown',
        errorType: error.name || 'Unknown',
        isRetryable: error.isRetryable || false
      });

      // Log activity
      await activityLogger.logUserActivity(
        bvnData.userId || null,
        'kyc_verification',
        'bvn_verification_failed',
        {
          source: 'api',
          description: 'BVN verification failed via Rubies',
          bvnMasked: bvnData.bvn ? `***${bvnData.bvn.slice(-4)}` : 'unknown',
          provider: 'rubies',
          success: false,
          error: error.message,
          errorType: error.name || 'Unknown',
        ipAddress: bvnData.ipAddress || null,
        userAgent: bvnData.userAgent || null
        }
      );

      // Handle different error types
      const isServerError = error.message && (
        error.message.includes('502') || 
        error.message.includes('503') || 
        error.message.includes('504') ||
        error.message.includes('Gateway time-out') ||
        error.message.includes('Bad Gateway') ||
        error.message.includes('Request failed with status code 502')
      );

      if (isServerError) {
        // Create a more specific error for server issues
        const serverError = new Error('BVN verification service is temporarily unavailable. Please try again later.');
        serverError.name = 'RubiesServerError';
        serverError.isRetryable = true;
        serverError.originalError = error;
        throw serverError;
      } else {
        // Re-throw other errors as-is
        throw error;
      }
    }
  }
async validateNIN(ninData) {
  try {
    const {
      nin,
      firstName,
      lastName,
      dateOfBirth,
      userId
    } = ninData;

    if (!nin || !/^\d{11}$/.test(nin)) {
      throw new Error("Invalid NIN");
    }

    const payload = {
      idNumber: nin,
      firstName,
      lastName,
      dob: dateOfBirth
        ? this.formatDateForRubies(dateOfBirth)
        : undefined,
      reference: `NIN_${Date.now()}_${userId || "unknown"}`
    };

    Object.keys(payload).forEach(
      key => payload[key] === undefined && delete payload[key]
    );

    const response = await this.makeRequest(
      "POST",
      "/baas-kyc/nin-validation",
      payload
    );

    if (response.responseCode === "00") {
      return {
        success: true,
        data: response,
        responseCode: response.responseCode,
        responseMessage: response.responseMessage
      };
    }

    throw new Error(response.responseMessage);

  } catch (error) {
    logger.error("Rubies NIN validation failed", {
      error: error.message
    });

    throw error;
  }
}
  // Virtual Account Service - Based on baas-virtual-account section
  async createVirtualAccount(userData) {
    try {
      // Validate required fields
      const requiredFields = ['firstName', 'lastName', 'phoneNumber', 'bvn'];
      for (const field of requiredFields) {
        if (!userData[field]) {
          throw new Error(`Missing required field: ${field}`);
        }
      }

      // Step 1: Prepare payload based on Rubies production documentation
      const payload = {
        accountAmountControl: 'EXACT', // Control type as per documentation
        accountParent: process.env.RUBIES_ACCOUNT_PARENT || '9018866641', // Configurable parent account
        accountType: 'DISPOSABLE', // Account type: DISPOSABLE or REUSABLE
        amount: '0', // Initial amount
        bvn: userData.bvn.toString().trim(),
        photo: userData.photo || '', // Optional photo (base64 string)
        validTime: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60), // 1 year validity in timestamp
        firstName: userData.firstName.trim(),
        gender: userData.gender || 'Male', // Gender as per documentation
        lastName: userData.lastName.trim(),
        phoneNumber: this.formatPhoneNumber(userData.phoneNumber),
        reference: userData.reference || `VA_${Date.now()}_${userData.userId}`
      };

      logger.info('Creating virtual account with Rubies', {
        userId: userData.userId,
        phoneNumber: payload.phoneNumber,
        reference: payload.reference,
        environment: this.selectedEnvironment
      });

      // Step 2: Initiate virtual account creation using production endpoint
      const response = await this.makeRequest('POST', '/baas-virtual-account/initiate-create-virtual-account', payload);

      if (response.responseCode === '00') {
        logger.info('Virtual account initiation successful, OTP sent', {
          userId: userData.userId,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage,
          reference: payload.reference
        });

        // Log activity
        await activityLogger.logUserActivity(
          userData.userId,
          'wallet_funding',
          'virtual_account_initiated',
          {
            description: 'Virtual account creation initiated, OTP sent',
            provider: 'rubies',
            responseCode: response.responseCode,
            responseMessage: response.responseMessage,
            success: true,
            source: 'api',
            reference: payload.reference
          }
        );

        return {
          success: true,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage,
          reference: payload.reference,
          otpRequired: true,
          message: 'Virtual account creation initiated. OTP sent for verification.'
        };
      } else {
        throw new Error(response.responseMessage || 'Failed to create virtual account');
      }
    } catch (error) {
      logger.error('Virtual account creation error', {
        userId: userData.userId,
        error: error.message,
        stack: error.stack
      });

      // Handle specific Rubies API errors
      let errorMessage = 'Virtual account creation failed due to technical issues. Please try again later or contact support.';
      
      if (error.message.includes('Account parent does not belong to this user')) {
        errorMessage = 'Virtual account creation failed: Invalid account configuration. Please contact support.';
        logger.error('Rubies API configuration error - account parent not valid', {
          userId: userData.userId,
          accountParent: process.env.RUBIES_ACCOUNT_PARENT || '9018866641',
          error: error.message
        });
      } else if (error.message.includes('Invalid account parent')) {
        errorMessage = 'Virtual account creation failed: Account configuration error. Please contact support.';
      }

      // Log activity
      await activityLogger.logUserActivity(
        userData.userId,
        'wallet_funding',
        'virtual_account_created_error',
        {
          description: 'Virtual account creation error',
          provider: 'rubies',
          success: false,
          error: error.message,
          source: 'api'
        }
      );

      return {
        success: false,
        error: error.message,
        message: errorMessage
      };
    }
  }

  // Complete Virtual Account Creation (after OTP verification)
  async completeVirtualAccountCreation(otpData) {
    try {
      const payload = {
        reference: otpData.reference,
        otp: otpData.otp
      };

      const response = await this.makeRequest('POST', '/baas-virtual-account/completeVirtualAccountCreation', payload);

      if (response.responseCode === '00') {
        logger.info('Virtual account creation completed', {
          reference: otpData.reference,
          responseCode: response.responseCode
        });

        return {
          success: true,
          accountNumber: response.accountNumber,
          accountName: response.accountName,
          bankName: response.channelBankName || 'RUBIES MFB',
          bankCode: response.channelBankCode || '090175',
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        throw new Error(response.responseMessage || 'Failed to complete virtual account creation');
      }
    } catch (error) {
      logger.error('Complete virtual account creation error', { error: error.message });
      throw error;
    }
  }

  // Resend OTP for Virtual Account Creation
  async resendOtp(reference) {
    try {
      const payload = { reference };
      const response = await this.makeRequest('POST', '/baas-virtual-account/resendOtp', payload);

      if (response.responseCode === '00') {
        return {
          success: true,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        throw new Error(response.responseMessage || 'Failed to resend OTP');
      }
    } catch (error) {
      logger.error('Resend OTP error', { error: error.message });
      throw error;
    }
  }

  // Get Virtual Account Details
  async getVirtualAccount(accountNumber) {
    try {
      const payload = {
        accountNumber: accountNumber.toString().trim()
      };

      const response = await this.makeRequest('POST', '/baas-virtual-account/getVirtualAccount', payload);

      if (response.responseCode === '00') {
        return {
          success: true,
          accountNumber: response.accountNumber,
          accountName: response.accountName,
          accountCurrency: response.accountCurrency,
          channelBankCode: response.channelBankCode,
          channelBankName: response.channelBankName,
          accountCreatedDate: response.accountCreatedDate,
          accountParent: response.accountParent,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        throw new Error(response.responseMessage || 'Failed to get virtual account');
      }
    } catch (error) {
      logger.error('Get virtual account error', { error: error.message, accountNumber });
      throw error;
    }
  }

  // Get Virtual Account List
  async getVirtualAccountList(payload = {}) {
    try {
      const response = await this.makeRequest('POST', '/baas-virtual-account/getVirtualAccountList', payload);

      if (response.responseCode === '00') {
        return {
          success: true,
          data: response.data,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        throw new Error(response.responseMessage || 'Failed to get virtual account list');
      }
    } catch (error) {
      logger.error('Get virtual account list error', { error: error.message });
      throw error;
    }
  }

  // Get Virtual Account Transaction List
  async getVirtualAccountTransactionList(accountNumber) {
    try {
      const payload = {
        accountNumber: accountNumber.toString().trim()
      };

      const response = await this.makeRequest('POST', '/baas-virtual-account/getVirtualAccountTransactionList', payload);

      if (response.responseCode === '00') {
        return {
          success: true,
          data: response.data,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        throw new Error(response.responseMessage || 'Failed to get virtual account transaction list');
      }
    } catch (error) {
      logger.error('Get virtual account transaction list error', { error: error.message });
      throw error;
    }
  }

  // Transaction Services - Based on baas-Transaction section

  // Name Enquiry
  async nameEnquiry(accountNumber, bankCode) {
    try {
      const payload = {
        accountNumber: accountNumber.toString().trim(),
        accountBankCode: bankCode.toString().trim()
      };

      logger.info('Making Rubies name enquiry', {
        accountNumber: payload.accountNumber,
        accountBankCode: payload.accountBankCode,
        environment: this.selectedEnvironment
      });

      // Name enquiry endpoint - using working endpoint from test
      const response = await this.makeRequest('POST', '/baas-transaction/name-enquiry', payload);

      if (response.responseCode === '00') {
        return {
          success: true,
          accountName: response.accountName,
          accountNumber: response.accountNumber,
          bankCode: response.bankCode,
          bankName: response.bankName,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        throw new Error(response.responseMessage || 'Name enquiry failed');
      }
    } catch (error) {
      logger.error('Rubies name enquiry failed', { 
        error: error.message, 
        accountNumber, 
        bankCode
      });
      throw error;
    }
  }

  // Fund Transfer
  async initiateTransfer(transferData) {
    try {
      // Validate transfer data
      const requiredFields = ['userId', 'amount', 'accountNumber', 'bankCode', 'narration', 'reference'];
      for (const field of requiredFields) {
        if (!transferData[field]) {
          throw new Error(`Missing required field: ${field}`);
        }
      }

      // Get user's virtual account number from wallet
      const walletService = require('./wallet');
      const userWallet = await walletService.getUserWallet(transferData.userId);

      if (!userWallet || !userWallet.virtualAccountNumber) {
        throw new Error('User virtual account not found');
      }

      const payload = {
        amount: parseFloat(transferData.amount), // Should be number, not string
        bankCode: transferData.bankCode.toString().trim(),
        bankName: transferData.bankName || 'OPay',
        creditAccountName: transferData.beneficiaryName || 'Recipient',
        creditAccountNumber: transferData.accountNumber.toString().trim(),
        debitAccountName: transferData.senderName || 'MiiMii User',
        debitAccountNumber: userWallet.virtualAccountNumber,
        narration: transferData.narration.trim(),
        reference: transferData.reference,
        sessionId: transferData.reference // Use reference as sessionId
      };

      logger.info('Initiating Rubies transfer', {
        amount: payload.amount,
        creditAccountNumber: payload.creditAccountNumber,
        bankCode: payload.bankCode,
        reference: payload.reference,
        environment: this.selectedEnvironment
      });

      // Fund transfer endpoint - using working pattern from test
      const response = await this.makeRequest('POST', '/baas-transaction/fund-transfer', payload);

      if (response.responseCode === '00') {
        return {
          success: true,
          reference: response.reference || transferData.reference,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage,
          status: 'pending' // Rubies will send webhook for final status
        };
      } else {
        return {
          success: false,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage || 'Transfer failed'
        };
      }
    } catch (error) {
      logger.error('Rubies transfer failed', { error: error.message, transferData });
      
      return {
        success: false,
        message: error.message || 'Transfer processing failed',
        response: error.response?.data
      };
    }
  }

  // Get Bank List
  async getBankList() {
    try {
      logger.info('Fetching bank list from Rubies', {
        environment: this.selectedEnvironment
      });
      
      // Bank list endpoint - using correct endpoint from documentation
      const response = await this.makeRequest('POST', '/baas-transaction/bank-list', {
        readAll: "YES"
      });

      if (response.responseCode === '00' && response.data) {
        const banks = response.data;
        
        logger.info('Successfully fetched bank list from Rubies', {
          bankCount: banks.length,
          environment: this.selectedEnvironment
        });

        return banks.map(bank => ({
          code: bank.code,
          name: bank.name,
          slug: bank.code, // Keeping slug for potential future use
          type: 'commercial', // Defaulting type
          category: 'deposit_money_bank' // Defaulting category
        }));
      } else {
        throw new Error(response.responseMessage || 'Failed to fetch bank list');
      }
    } catch (error) {
      logger.error('Failed to get bank list from Rubies', { 
        error: error.message,
        environment: this.selectedEnvironment,
        statusCode: error.response?.status,
        is404: error.response?.status === 404
      });
      
      // If it's a 404 error, return empty array to trigger fallback mechanisms
      if (error.response?.status === 404) {
        logger.warn('Rubies bank list endpoint not found (404), using fallback mechanisms');
        return [];
      }
      
      throw error;
    }
  }

  // Post Single Transaction
  async postSingleTransaction(transactionData) {
    try {
      const response = await this.makeRequest('POST', '/baas-Transaction/postSingleTransaction', transactionData);

      if (response.responseCode === '00') {
        return {
          success: true,
          data: response.data,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        throw new Error(response.responseMessage || 'Failed to post transaction');
      }
    } catch (error) {
      logger.error('Post single transaction error', { error: error.message });
      throw error;
    }
  }

  // TSQ (Transaction Status Query)
  async transactionStatusQuery(reference) {
    try {
      const payload = { reference };
      const response = await this.makeRequest('POST', '/baas-Transaction/tsq', payload);

      if (response.responseCode === '00') {
        return {
          success: true,
          data: response.data,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        throw new Error(response.responseMessage || 'Failed to query transaction status');
      }
    } catch (error) {
      logger.error('Transaction status query error', { error: error.message });
      throw error;
    }
  }

  // Wallet Services - Based on baas-wallet section

  // Wallet Balance Enquiry
  async getWalletBalance(accountNumber) {
    try {
      const payload = {
        accountNumber: accountNumber.toString().trim()
      };

      const response = await this.makeRequest('POST', '/baas-wallet/wallet-balance-enquiry', payload);

      if (response.responseCode === '00') {
        return {
          success: true,
          accountBalance: response.accountBalance,
          accountLedgerBalance: response.accountLedgerBalance,
          accountBankCode: response.accountBankCode,
          accountBankName: response.accountBankName,
          accountBranchCode: response.accountBranchCode,
          accountCurrency: response.accountCurrency,
          accountCustomerPhone: response.accountCustomerPhone,
          accountName: response.accountName,
          accountNumber: response.accountNumber,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        throw new Error(response.responseMessage || 'Failed to get wallet balance');
      }
    } catch (error) {
      logger.error('Get wallet balance error', { error: error.message, accountNumber });
      throw error;
    }
  }

  // Retrieve Wallet Details
  async retrieveWalletDetails(accountNumber) {
    try {
      const payload = {
        accountNumber: accountNumber.toString().trim()
      };

      // Use correct endpoint: /baas-wallet/retrieve-wallet-details
      const response = await this.makeRequest('POST', '/baas-wallet/retrieve-wallet-details', payload);

      if (response.responseCode === '00') {
        return {
          success: true,
          accountId: response.accountId,
          accountCustomerId: response.accountCustomerId,
          accountNumber: response.accountNumber,
          accountName: response.accountName,
          accountCurrency: response.accountCurrency,
          accountBalance: parseFloat(response.accountBalance || 0),
          accountStatus: response.accountStatus,
          accountLedgerBalance: parseFloat(response.accountLedgerBalance || 0),
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        throw new Error(response.responseMessage || 'Failed to retrieve wallet details');
      }
    } catch (error) {
      logger.error('Retrieve wallet details error', { error: error.message, accountNumber });
      throw error;
    }
  }

  // Read Wallet Transactions
  async readWalletTransactions(accountNumber, startDate, endDate, page = 0) {
    try {
      const payload = {
        accountNumber: accountNumber.toString().trim(),
        startDate: startDate, // Format: "2024-04-12"
        endDate: endDate, // Format: "2024-05-06"
        page: page
      };

      const response = await this.makeRequest('POST', '/baas-wallet/read-wallet-transaction', payload);

      if (response.responseCode === '00') {
        return {
          success: true,
          data: response.data,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        throw new Error(response.responseMessage || 'Failed to read wallet transactions');
      }
    } catch (error) {
      logger.error('Read wallet transactions error', { error: error.message, accountNumber });
      throw error;
    }
  }

  async getBankMapping() {
    try {
      const banks = await this.getBankList();
      
      // Create mapping from bank names to codes
      const bankMapping = {};
      banks.forEach(bank => {
        const lowerName = bank.name.toLowerCase();
        bankMapping[lowerName] = bank.code;
        
        // Add common variations
        if (lowerName.includes('guaranty trust')) bankMapping['gtbank'] = bank.code;
        if (lowerName.includes('first bank')) bankMapping['first'] = bank.code;
        if (lowerName.includes('access')) bankMapping['access'] = bank.code;
        if (lowerName.includes('zenith')) bankMapping['zenith'] = bank.code;
        if (lowerName.includes('united bank for africa')) bankMapping['uba'] = bank.code;
        if (lowerName.includes('fidelity')) bankMapping['fidelity'] = bank.code;
        if (lowerName.includes('union')) bankMapping['union'] = bank.code;
        if (lowerName.includes('wema')) bankMapping['wema'] = bank.code;
        if (lowerName.includes('sterling')) bankMapping['sterling'] = bank.code;
        if (lowerName.includes('ecobank')) bankMapping['ecobank'] = bank.code;
        if (lowerName.includes('fcmb')) bankMapping['fcmb'] = bank.code;
        if (lowerName.includes('stanbic')) bankMapping['stanbic'] = bank.code;
        if (lowerName.includes('keystone')) bankMapping['keystone'] = bank.code;
      });

      return { bankMapping, banks };
    } catch (error) {
      logger.error('Failed to get bank mapping from Rubies', { error: error.message });
      throw error;
    }
  }

  async getInstitutionCode(bankName) {
    try {
      const bankMapping = await this.getBankMapping();
      const lowerBankName = bankName.toLowerCase();
      
      // Try exact match first
      if (bankMapping.bankMapping[lowerBankName]) {
        return bankMapping.bankMapping[lowerBankName];
      }
      
      // Try partial match
      for (const [pattern, code] of Object.entries(bankMapping.bankMapping)) {
        if (lowerBankName.includes(pattern) || pattern.includes(lowerBankName)) {
          return code;
        }
      }
      
      throw new Error(`No institution code found for bank: ${bankName}`);
    } catch (error) {
      logger.error('Failed to get institution code from Rubies', { 
        bankName, 
        error: error.message 
      });
      throw error;
    }
  }

  // Webhook handling
  verifyWebhook(payload, signature) {
    try {
      if (!this.webhookSecret) {
        logger.warn('Rubies webhook secret not configured');
        return false;
      }

      const crypto = require('crypto');
      const expectedSignature = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(JSON.stringify(payload))
        .digest('hex');

      return signature === expectedSignature;
    } catch (error) {
      logger.error('Webhook verification failed', { error: error.message });
      return false;
    }
  }

  async processWebhookEvent(event) {
    try {
      logger.info('Processing Rubies webhook event', {
        responseCode: event.responseCode,
        reference: event.reference || event.paymentReference,
        service: event.service,
        drCr: event.drCr,
        amount: event.amount,
        environment: this.selectedEnvironment
      });

      // Process based on response code and transaction type from Rubies documentation
      if (event.responseCode === '00') {
        // Check if this is a credit to one of our virtual accounts
        if (event.drCr === 'CR' || event.service === 'Fund Transfer') {
          await this.handleAccountCredit(event);
        } else {
          await this.handleTransferSuccess(event);
        }
      } else {
        // Handle failed transactions
        switch (event.responseCode) {
          case '14':
          case '33':
            await this.handleTransferFailed(event);
            break;
          case '34':
            await this.handleSettlementRequired(event);
            break;
          case '-1':
            await this.handleTransferProcessing(event);
            break;
          default:
            logger.info('Unhandled Rubies webhook response code', { 
              responseCode: event.responseCode,
              responseMessage: event.responseMessage 
            });
        }
      }
    } catch (error) {
      logger.error('Failed to process Rubies webhook event', { error: error.message, event });
      throw error;
    }
  }

  async handleTransferSuccess(data) {
    try {
      const reference = data.reference || data.contractReference || data.paymentReference;
      if (reference) {
        const transactionService = require('./transaction');
        const transaction = await transactionService.getTransactionByReference(reference);
        if (transaction) {
          await transactionService.updateTransactionStatus(transaction.id, 'completed', {
            processedAt: new Date().toISOString(),
            providerResponse: data
          });
        }
        
        logger.info('Transfer marked as successful', { reference, provider: 'rubies' });
      }
    } catch (error) {
      logger.error('Failed to handle transfer success', { error: error.message, data });
    }
  }

  async handleTransferFailed(data) {
    try {
      const reference = data.reference || data.contractReference || data.paymentReference;
      if (reference) {
        const transactionService = require('./transaction');
        const transaction = await transactionService.getTransactionByReference(reference);
        if (transaction) {
          await transactionService.updateTransactionStatus(transaction.id, 'failed', {
            failureReason: data.responseMessage || data.message,
            processedAt: new Date().toISOString(),
            providerResponse: data
          });
        }
        
        logger.info('Transfer marked as failed', { 
          reference, 
          reason: data.responseMessage, 
          provider: 'rubies' 
        });
      }
    } catch (error) {
      logger.error('Failed to handle transfer failure', { error: error.message, data });
    }
  }

  async handleSettlementRequired(data) {
    try {
      const reference = data.reference || data.contractReference || data.paymentReference;
      if (reference) {
        const transactionService = require('./transaction');
        const transaction = await transactionService.getTransactionByReference(reference);
        if (transaction) {
          await transactionService.updateTransactionStatus(transaction.id, 'pending_settlement', {
            failureReason: data.responseMessage || 'Settlement Required',
            processedAt: new Date().toISOString(),
            providerResponse: data
          });
        }
        
        logger.info('Transfer marked as pending settlement', { 
          reference, 
          reason: data.responseMessage, 
          provider: 'rubies' 
        });
      }
    } catch (error) {
      logger.error('Failed to handle settlement required', { error: error.message, data });
    }
  }

  async handleTransferProcessing(data) {
    try {
      const reference = data.reference || data.contractReference || data.paymentReference;
      if (reference) {
        const transactionService = require('./transaction');
        const transaction = await transactionService.getTransactionByReference(reference);
        if (transaction) {
          await transactionService.updateTransactionStatus(transaction.id, 'processing', {
            processedAt: new Date().toISOString(),
            providerResponse: data
          });
        }
        
        logger.info('Transfer marked as processing', { reference, provider: 'rubies' });
      }
    } catch (error) {
      logger.error('Failed to handle transfer processing', { error: error.message, data });
    }
  }

  async handleAccountCredit(data) {
    try {
      // Rubies webhook data structure based on documentation
      const accountNumber = data.creditAccount || data.accountNumber;
      const amount = parseFloat(data.amount);
      
      if (accountNumber && amount > 0) {
        // Find user by virtual account number in wallet
        const walletService = require('./wallet');
        const databaseService = require('./database');
        const supabaseHelper = require('./supabaseHelper');
        
        const wallet = await databaseService.executeWithRetry(async () => {
          return await supabaseHelper.findOne('wallets', { virtualAccountNumber: accountNumber });
        });
        
        if (wallet) {
          // Lazy load to avoid circular dependency
          const userService = require('./user');
          const user = await userService.getUserById(wallet.userId);
          if (user) {
            // Credit the digital wallet using the existing mechanism
            const walletService = require('./wallet');
            await walletService.creditWalletFromVirtualAccount({
              customer_id: user.id,
              amount: data.amount,
              reference: data.paymentReference || data.sessionId,
              sender_name: data.originatorName || data.creditAccountName,
              sender_bank: data.bankName || 'Unknown Bank'
            });
            
            logger.info('Digital wallet credited from Rubies virtual account', {
              userId: user.id,
              amount: data.amount,
              reference: data.paymentReference,
              accountNumber
            });
          } else {
            logger.warn('User not found for wallet', { walletId: wallet.id, accountNumber });
          }
        } else {
          logger.warn('No wallet found for virtual account number', { accountNumber });
        }
      }
    } catch (error) {
      logger.error('Failed to handle Rubies account credit', { error: error.message, data });
    }
  }

  // Utility methods
  formatDateForRubies(dateStr) {
    // Format date for Rubies API
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date format');
    }
    return date.toISOString().split('T')[0]; // YYYY-MM-DD format
  }

  formatPhoneNumber(phone) {
    // Format phone number for Rubies API - Nigerian format without country code
    let normalized = phone.replace(/\D/g, '');
    
    // If it starts with 234, remove it and add 0
    if (normalized.startsWith('234')) {
      normalized = '0' + normalized.slice(3);
    }
    
    // If it doesn't start with 0, add it
    if (!normalized.startsWith('0')) {
      normalized = '0' + normalized;
    }
    
    return normalized;
  }

  // Resolve institution code from bank name or code
  async resolveInstitutionCode(input) {
    if (!input) return null;

    const raw = String(input).trim().toLowerCase();

    // Ignore pure numeric tokens (prevents mapping amounts like "100" -> 000100)
    if (/^\d+$/.test(raw)) {
      return null;
    }

    // Skip generic words that commonly appear in messages
    const genericWords = new Set([
      'bank','account','acct','acc','number','no','acctno','accno','send','transfer','to','for','the','my','your',
      'amount','money','naira','fee','charges','pin','yes','no','confirm','confirmation','receipt','reference','ref',
      'successful','success','completed','complete','please','help','buy','pay','data','airtime','bill','bills',
      'recipient','name','mr','mrs','ms','sir','ma','and','on','in','of','with','at','from','via'
    ]);
    if (genericWords.has(raw)) {
      return null;
    }

    // If already a 6-digit institution code
    if (/^\d{6}$/.test(raw)) {
      return raw;
    }

    // If 3-digit bank code (CBN style), try convert using mappings
    if (/^\d{3}$/.test(raw)) {
      const codeMapping = {
        '082': '000082', '044': '000044', '014': '000014', '011': '000016', '058': '000058', '057': '000057',
        '070': '000070', '032': '000032', '035': '000035', '232': '000232', '050': '000050', '214': '000214',
        '221': '000221', '068': '000068', '023': '000023', '030': '000030', '215': '000215', '084': '000084',
        '033': '000033', '090': '000090', '091': '000091', '092': '000092', '093': '000093', '094': '000094',
        '095': '000095', '096': '000096', '097': '000097', '098': '000098', '099': '000099', '100': '000100',
        '101': '000101', '102': '000102', '103': '000103', '104': '000104', '105': '000105', '106': '000106'
      };
      return codeMapping[raw] || null;
    }

    // Normalize common synonyms/misspellings
    let normalized = raw
      .replace(/moni[e]?point|monipoint/gi, 'moniepoint')
      .replace(/gtb|gt bank|guaranty\s*trust/gi, 'gtbank')
      .replace(/first\s*bank(?:\s*of\s*nigeria)?|firstbank|fbn/gi, 'first bank')
      .replace(/stanbic\s*ibtc|ibtc/gi, 'stanbic ibtc')
      .replace(/eco\s*bank/gi, 'ecobank')
      .replace(/opay/gi, 'opay')
      .trim();

    // Try to get bank list from Rubies API for dynamic resolution
    try {
      const bankList = await this.getBankList();
      if (bankList && bankList.length > 0) {
        logger.info('Using dynamic bank list for institution code resolution', { 
          bankCount: bankList.length,
          input: raw 
        });
        
        const bankNameLower = normalized.toLowerCase();
        
        // Skip common non-bank words
        const skipWords = ['send', 'naira', 'to', 'from', 'transfer', 'money', 'amount', 'bank', 'account', 'number'];
        if (skipWords.includes(bankNameLower)) {
          logger.warn('Skipping common non-bank word', { input: raw, normalized: bankNameLower });
          return null;
        }
        
        const matchingBank = bankList.find(bank => {
          const institutionName = bank.name.toLowerCase();
          
          // 1. Direct match (highest priority)
          if (institutionName === bankNameLower) {
            return true;
          }
          
          // 2. Special cases for common abbreviations (high priority)
          if (bankNameLower === 'gtb' && institutionName.includes('gtbank')) {
            return true;
          }
          if (bankNameLower === 'fbn' && institutionName.includes('firstbank')) {
            return true;
          }
          if (bankNameLower === 'ibtc' && institutionName.includes('stanbic')) {
            return true;
          }
          if (bankNameLower === 'fcmb' && institutionName.includes('first city monument')) {
            return true;
          }
          if (bankNameLower === 'monie' && institutionName.includes('moniepoint')) {
            return true;
          }
          if (bankNameLower === 'rubies' && institutionName.includes('rubies')) {
            return true;
          }
          if (bankNameLower === 'opay' && institutionName.includes('opay')) {
            return true;
          }
          if (bankNameLower === 'keystone' && institutionName.includes('keystone')) {
            return true;
          }
          
          // 3. Partial match - bank name contains input (medium priority)
          if (institutionName.includes(bankNameLower)) {
            return true;
          }
          
          // 4. Partial match - input contains bank name
          if (bankNameLower.includes(institutionName)) {
            return true;
          }
          
          // 5. 5-letter matching - check if first 5 letters match (lower priority)
          if (bankNameLower.length >= 5 && institutionName.startsWith(bankNameLower.substring(0, 5))) {
            return true;
          }
          
          // 6. Reverse 5-letter matching - check if bank name starts with first 5 letters of input
          if (institutionName.length >= 5 && bankNameLower.startsWith(institutionName.substring(0, 5))) {
            return true;
          }
          
          return false;
        });
        
        if (matchingBank) {
          logger.info('Bank resolved via dynamic Rubies API bank list', {
            input: raw,
            normalized: bankNameLower,
            matchedBank: matchingBank.name,
            matchedCode: matchingBank.code
          });
          return matchingBank.code;
        } else {
          logger.warn('No matching bank found in Rubies API bank list', {
            input: raw,
            normalized: bankNameLower,
            availableBanks: bankList.slice(0, 5).map(b => b.name) // Log first 5 banks for debugging
          });
        }
      } else {
        logger.warn('Rubies API bank list is empty, using static fallback');
      }
    } catch (error) {
      logger.warn('Rubies bank list lookup failed during institution code resolution', { 
        error: error.message, 
        input: raw 
      });
    }

    // Fallback to static bank mapping - using correct Rubies API bank codes
    const staticBankMapping = {
      'opay': '100004',
      'moniepoint': '100004', 
      'gtbank': '000013',
      'gtb': '000013',
      'guaranty trust': '000013',
      'access': '000014',
      'access bank': '000014',
      'first bank': '000016',
      'firstbank': '000016',
      'fbn': '000016',
      'zenith': '000015',
      'zenith bank': '000015',
      'uba': '000004',
      'united bank for africa': '000004',
      'keystone': '000002',
      'keystone bank': '000002',
      'stanbic': '000012',
      'stanbic ibtc': '000012',
      'ibtc': '000012',
      'ecobank': '000010',
      'eco bank': '000010',
      'fidelity': '000007',
      'fidelity bank': '000007',
      'union': '000018',
      'union bank': '000018',
      'wema': '000017',
      'wema bank': '000017',
      'sterling': '000001',
      'sterling bank': '000001',
      'kuda': '000090',
      'kuda bank': '000090',
      'palm pay': '000091',
      'palmpay': '000091',
      'vfd': '000092',
      'vfd microfinance': '000092',
      'providus': '000023',
      'providus bank': '000023',
      'jaiz': '000006',
      'jaiz bank': '000006',
      'taj': '000104',
      'taj bank': '000104',
      'unity': '000011',
      'unity bank': '000011',
      'heritage': '000020',
      'heritage bank': '000020',
      'rubies mfb': '090175',
      'rubies': '090175',
      'mfb': '090175',
      '9 payment': '100004',
      '9pay': '100004',
      'citibank': '000009',
      'diamond': '000005',
      'fcmb': '000003',
      'standard chartered': '000021',
      'rand merchant': '000024',
      'polari': '000008',
      'suntrust': '000022',
      'polaris': '999991',
      'polaris bank': '999991'
    };

    const mappedCode = staticBankMapping[normalized];
    if (mappedCode) {
      logger.info('Using static bank mapping for Rubies', {
        input: raw,
        normalized,
        mappedCode
      });
      return mappedCode;
    }

    return null;
  }

  // Transaction Status Query (TSQ)
  async queryTransactionStatus(reference) {
    try {
      const payload = {
        reference: reference.toString().trim()
      };

      logger.info('Querying Rubies transaction status', {
        reference: payload.reference,
        environment: this.selectedEnvironment
      });

      // Transaction status query endpoint
      const response = await this.makeRequest('POST', '/baas-transaction/tsq', payload);

      if (response.responseCode === '00') {
        return {
          success: true,
          amount: response.amount,
          bankCode: response.bankCode,
          bankName: response.bankName,
          contractReference: response.contractReference,
          creditAccountNumber: response.creditAccountNumber,
          debitAccountName: response.debitAccountName,
          debitAccountNumber: response.debitAccountNumber,
          narration: response.narration,
          paymentReference: response.paymentReference,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage
        };
      } else {
        return {
          success: false,
          responseCode: response.responseCode,
          responseMessage: response.responseMessage || 'Transaction query failed'
        };
      }
    } catch (error) {
      logger.error('Rubies transaction status query failed', { 
        error: error.message, 
        reference 
      });
      throw error;
    }
  }
}

module.exports = new RubiesService();
