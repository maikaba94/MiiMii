const axios = require('axios');
const { axiosConfig } = require('../utils/httpsAgent');
const logger = require('../utils/logger');
const userService = require('./user');
const whatsappService = require('./whatsapp');
const ocrService = require('./ocr');
const fincraService = require('./fincra');
const rubiesService = require('./rubies');
const activityLogger = require('./activityLogger');
const databaseService = require('./database');
const { supabase } = require('../database/connection');
const { v4: uuidv4 } = require('uuid');

class KYCService {
  constructor() {
    this.sandboxURL = 'https://sandbox.dojah.io';
    this.productionURL = 'https://api.dojah.io';
    this.baseURL = process.env.NODE_ENV === 'production' ? this.productionURL : this.sandboxURL;
    this.appId = process.env.DOJAH_APP_ID;
    this.secretKey = process.env.DOJAH_SECRET_KEY;
    this.publicKey = process.env.DOJAH_PUBLIC_KEY;
    
    // Rate limiting
    this.lastRequestTime = 0;
    this.requestsThisMinute = 0;
    this.rateLimitWindow = 60000; // 1 minute
    this.maxRequestsPerMinute = 100;
  }

  async startKycProcess(user, phoneNumber, kycData, extractedData = null) {
    try {
      const { firstName, lastName, middleName, dateOfBirth, gender, address, bvn, nin, } = kycData;
      
      logger.info('Starting KYC process', { 
        userId: user.id, 
        phoneNumber,
        hasExtractedData: !!extractedData 
      });

      // Update user with KYC data
      await userService.updateUser(user.id, {
        firstName,
        lastName,
        middleName,
        dateOfBirth,
        gender,
        address,
        bvn,
        nin,
        kycStatus: 'pending',
        kycData: {
          submittedAt: new Date(),
          extractedData,
          verificationSteps: {
            bvnVerification: false,
            phoneVerification: false,
            documentVerification: false,
            facialVerification: false
          },
          verificationReference: uuidv4(),
          complianceChecks: {
            sanctionsList: false,
            watchList: false,
            pepCheck: false
          }
        }
      });

      // Start BVN verification with Rubies before other verifications
      let bvnVerification;

if (bvn) {
  bvnVerification = await this.verifyBVNWithRubies(bvn, {
    firstName,
    lastName,
    dateOfBirth,
    phoneNumber,
    userId: user.id
  });
} else if (nin) {
  bvnVerification = await rubiesService.validateNIN({
    nin,
    firstName,
    lastName,
    dateOfBirth,
    userId: user.id
  });

  bvnVerification.verified = bvnVerification.success === true;
} else {
  throw new Error('Either BVN or NIN is required');
}

      // Update user with BVN verification result
      await userService.updateUser(user.id, {
        'kycData.verificationSteps.bvnVerification': bvnVerification.verified,
        'kycData.bvnVerificationData': bvnVerification
      });

      // Only proceed with virtual account creation if BVN is verified
      if (!bvnVerification.verified) {
        throw new Error(`BVN validation failed: ${bvnVerification.error}`);
      }

      // Start comprehensive verification process
      const verificationResults = await this.performComprehensiveVerification(user, kycData);
      verificationResults.bvnVerification = bvnVerification;
      
      // Generate verification reference
      const reference = `KYC_${Date.now()}_${uuidv4().slice(0, 8)}`;

      // Log KYC initiation
      await activityLogger.logUserActivity(
        user.id,
        'kyc_submission',
        'kyc_process_started',
        {
          source: 'whatsapp',
          description: 'Comprehensive KYC verification process initiated with Rubies BVN validation',
          reference,
          verificationSteps: Object.keys(verificationResults),
          hasExtractedData: !!extractedData,
          bvnVerified: bvnVerification.verified,
          bvnProvider: 'rubies'
        }
      );

      // Send detailed status to user
      await this.sendKycStatusUpdate(user, phoneNumber, verificationResults, reference);

      return {
        reference,
        kycStatus: 'pending',
        verificationSteps: verificationResults,
        success: true
      };

    } catch (error) {
      logger.error('Failed to start KYC process', { 
        error: error.message, 
        userId: user.id,
        stack: error.stack
      });
      
      await activityLogger.logUserActivity(
        user.id,
        'kyc_submission',
        'kyc_process_failed',
        {
          source: 'whatsapp',
          description: 'KYC process initiation failed',
          error: error.message,
          severity: 'error'
        }
      );

      throw new Error(`KYC process failed: ${error.message}`);
    }
  }

  async performComprehensiveVerification(user, kycData) {
    const results = {
      bvnVerification: { verified: false, details: null, error: null },
      phoneVerification: { verified: false, details: null, error: null },
      complianceCheck: { passed: false, details: null, flags: [] },
      riskAssessment: { score: 0, level: 'unknown', factors: [] }
    };

    try {
      // 1. BVN Verification - Using Fincra instead of Dojah
      if (kycData.bvn) {
        results.bvnVerification = await this.verifyBVNWithRubies(kycData.bvn, {
          firstName: kycData.firstName,
          lastName: kycData.lastName,
          dateOfBirth: kycData.dateOfBirth,
          phoneNumber: user.whatsappNumber,
          userId: user.id
        });
      }

      // 2. Phone Number Verification
      results.phoneVerification = await this.verifyPhoneNumber(user.whatsappNumber, user);

      // 3. Compliance Checks (Sanctions, PEP, Watch List)
      results.complianceCheck = await this.performComplianceChecks(user);

      // 4. Risk Assessment
      results.riskAssessment = await this.calculateRiskScore(user, results);

      // Update user's KYC data with results
      await this.updateKycResults(user, results);

      return results;

    } catch (error) {
      logger.error('Comprehensive verification failed', { 
        error: error.message, 
        userId: user.id 
      });
      throw error;
    }
  }

  async verifyBvnAdvanced(bvn, user) {
    try {
      logger.info('Starting advanced BVN verification', { 
        userId: user.id, 
        bvnMasked: `***${bvn.slice(-4)}` 
      });

      // Build comprehensive query parameters
      const params = {
        bvn: bvn.toString().trim()
      };

      // Add user details for enhanced verification
      if (user.firstName) params.first_name = user.firstName.trim();
      if (user.lastName) params.last_name = user.lastName.trim();
      if (user.dateOfBirth) {
        const dobFormatted = this.formatDateForDojah(user.dateOfBirth);
        params.dob = dobFormatted;
      }
      if (user.whatsappNumber) {
        params.phone = this.formatPhoneForDojah(user.whatsappNumber);
      }

      const response = await this.makeRequest('GET', '/api/v1/kyc/bvn', params);

      if (response.entity) {
        const bvnData = response.entity;
        
        // Comprehensive data analysis
        const verification = {
          verified: true,
          matchScore: this.calculateBvnMatchScore(user, bvnData),
          details: {
            fullName: `${bvnData.firstname} ${bvnData.middlename || ''} ${bvnData.lastname}`.trim(),
            dateOfBirth: bvnData.date_of_birth,
            phoneNumber: bvnData.phone_number1,
            gender: bvnData.gender,
            enrollmentDate: bvnData.enrollment_date,
            enrollmentBank: bvnData.enrollment_bank,
            maritalStatus: bvnData.marital_status,
            stateOfOrigin: bvnData.state_of_origin,
            lgaOfOrigin: bvnData.lga_of_origin,
            watchListed: bvnData.watch_listed,
            email: bvnData.email,
            nin: bvnData.nin,
            levelOfAccount: bvnData.level_of_account,
            residentialAddress: bvnData.residential_address,
            base64Image: bvnData.base64image ? 'present' : 'absent'
          },
          validationChecks: {
            nameMatch: this.validateNameMatch(user, bvnData),
            dobMatch: this.validateDobMatch(user, bvnData),
            phoneMatch: this.validatePhoneMatch(user, bvnData),
            genderMatch: this.validateGenderMatch(user, bvnData),
            isWatchListed: bvnData.watch_listed === 'NO'
          }
        };

        // Calculate overall verification status
        const checks = verification.validationChecks;
        verification.overallMatch = checks.nameMatch && checks.dobMatch && 
                                  checks.isWatchListed && 
                                  (checks.phoneMatch || checks.genderMatch);

        // Log successful verification
        await activityLogger.logUserActivity(
          user.id,
          'kyc_verification',
          'bvn_verified',
          {
            source: 'system',
            description: 'BVN verification completed successfully',
            matchScore: verification.matchScore,
            overallMatch: verification.overallMatch,
            watchListed: !checks.isWatchListed
          }
        );

        logger.info('BVN verification completed', {
          userId: user.id,
          verified: verification.verified,
          matchScore: verification.matchScore,
          overallMatch: verification.overallMatch
        });

        return verification;

      } else {
        const errorMsg = response.error?.message || 'BVN not found or invalid';
        
        await activityLogger.logUserActivity(
          user.id,
          'kyc_verification',
          'bvn_verification_failed',
          {
            source: 'system',
            description: 'BVN verification failed',
            error: errorMsg,
            severity: 'warning'
          }
        );

        return {
          verified: false,
          error: errorMsg,
          details: null
        };
      }

    } catch (error) {
      logger.error('BVN verification failed', { 
        error: error.message, 
        userId: user.id 
      });

      await activityLogger.logUserActivity(
        user.id,
        'kyc_verification',
        'bvn_verification_error',
        {
          source: 'system',
          description: 'BVN verification encountered an error',
          error: error.message,
          severity: 'error'
        }
      );

      return {
        verified: false,
        error: error.message,
        details: null
      };
    }
  }

  async verifyPhoneNumber(phoneNumber, user) {
    try {
      logger.info('Starting phone verification', { 
        userId: user.id, 
        phoneNumber: phoneNumber.replace(/\d(?=\d{4})/g, '*') 
      });

      const formattedPhone = this.formatPhoneForDojah(phoneNumber);
      
      const response = await this.makeRequest('GET', '/api/v1/kyc/phone_number', {
        phone_number: formattedPhone
      });

      if (response.entity) {
        const phoneData = response.entity;
        
        const verification = {
          verified: true,
          details: {
            carrier: phoneData.carrier,
            type: phoneData.type,
            ported: phoneData.ported,
            portedDate: phoneData.ported_date,
            lastSeen: phoneData.last_seen,
            network: phoneData.network,
            countryCode: phoneData.country_code,
            valid: phoneData.valid,
            reachable: phoneData.reachable
          },
          validationChecks: {
            isValid: phoneData.valid,
            isReachable: phoneData.reachable,
            isActiveLine: phoneData.type !== 'landline'
          }
        };

        verification.overallValid = verification.validationChecks.isValid && 
                                  verification.validationChecks.isReachable;

        await activityLogger.logUserActivity(
          user.id,
          'kyc_verification',
          'phone_verified',
          {
            source: 'system',
            description: 'Phone number verification completed',
            carrier: phoneData.carrier,
            valid: verification.overallValid
          }
        );

        return verification;

      } else {
        return {
          verified: false,
          error: 'Phone number verification failed',
          details: null
        };
      }

    } catch (error) {
      logger.error('Phone verification failed', { 
        error: error.message, 
        userId: user.id 
      });

      return {
        verified: false,
        error: error.message,
        details: null
      };
    }
  }

  async performComplianceChecks(user) {
    try {
      logger.info('Starting compliance checks', { userId: user.id });

      const results = {
        passed: true,
        details: {},
        flags: []
      };

      // 1. Sanctions List Check
      try {
        const sanctionsCheck = await this.checkSanctionsList(user);
        results.details.sanctions = sanctionsCheck;
        if (!sanctionsCheck.clear) {
          results.flags.push('sanctions_match');
          results.passed = false;
        }
      } catch (error) {
        logger.warn('Sanctions check failed', { error: error.message, userId: user.id });
        results.details.sanctions = { error: error.message };
      }

      // 2. PEP (Politically Exposed Person) Check
      try {
        const pepCheck = await this.checkPoliticalExposure(user);
        results.details.pep = pepCheck;
        if (pepCheck.isPep) {
          results.flags.push('pep_match');
          // PEP doesn't automatically fail, but requires enhanced due diligence
        }
      } catch (error) {
        logger.warn('PEP check failed', { error: error.message, userId: user.id });
        results.details.pep = { error: error.message };
      }

      // 3. Watch List Check
      try {
        const watchListCheck = await this.checkWatchList(user);
        results.details.watchList = watchListCheck;
        if (!watchListCheck.clear) {
          results.flags.push('watchlist_match');
          results.passed = false;
        }
      } catch (error) {
        logger.warn('Watch list check failed', { error: error.message, userId: user.id });
        results.details.watchList = { error: error.message };
      }

      await activityLogger.logUserActivity(
        user.id,
        'compliance_check',
        'compliance_screening_completed',
        {
          source: 'system',
          description: 'Compliance screening completed',
          passed: results.passed,
          flags: results.flags,
          checksPerformed: Object.keys(results.details)
        }
      );

      return results;

    } catch (error) {
      logger.error('Compliance checks failed', { 
        error: error.message, 
        userId: user.id 
      });

      return {
        passed: false,
        error: error.message,
        details: {},
        flags: ['compliance_check_error']
      };
    }
  }

  async checkSanctionsList(user) {
    try {
      const response = await this.makeRequest('POST', '/api/v1/aml/screening/sanctions', {
        name: `${user.firstName} ${user.lastName}`.trim(),
        country: 'NG',
        dob: user.dateOfBirth
      });

      if (response.entity) {
        const sanctionsData = response.entity;
        return {
          clear: sanctionsData.hits === 0,
          hitCount: sanctionsData.hits,
          matches: sanctionsData.results || [],
          screeningId: sanctionsData.screening_id
        };
      }

      return { clear: true, hitCount: 0, matches: [] };
    } catch (error) {
      logger.error('Sanctions list check failed', { error: error.message, userId: user.id });
      throw error;
    }
  }

  async checkPoliticalExposure(user) {
    try {
      const response = await this.makeRequest('POST', '/api/v1/aml/screening/pep', {
        name: `${user.firstName} ${user.lastName}`.trim(),
        country: 'NG'
      });

      if (response.entity) {
        const pepData = response.entity;
        return {
          isPep: pepData.hits > 0,
          hitCount: pepData.hits,
          matches: pepData.results || [],
          riskLevel: pepData.hits > 0 ? 'high' : 'low'
        };
      }

      return { isPep: false, hitCount: 0, matches: [], riskLevel: 'low' };
    } catch (error) {
      logger.error('PEP check failed', { error: error.message, userId: user.id });
      throw error;
    }
  }

  async checkWatchList(user) {
    try {
      const response = await this.makeRequest('POST', '/api/v1/aml/screening/watchlist', {
        name: `${user.firstName} ${user.lastName}`.trim(),
        country: 'NG'
      });

      if (response.entity) {
        const watchListData = response.entity;
        return {
          clear: watchListData.hits === 0,
          hitCount: watchListData.hits,
          matches: watchListData.results || []
        };
      }

      return { clear: true, hitCount: 0, matches: [] };
    } catch (error) {
      logger.error('Watch list check failed', { error: error.message, userId: user.id });
      throw error;
    }
  }

  async calculateRiskScore(user, verificationResults) {
    try {
      let riskScore = 0;
      const factors = [];

      // BVN verification contributes to risk score
      if (verificationResults.bvnVerification.verified) {
        if (verificationResults.bvnVerification.overallMatch) {
          riskScore -= 0.3; // Lower risk
          factors.push('bvn_verified_match');
        } else {
          riskScore += 0.2; // Higher risk
          factors.push('bvn_verified_no_match');
        }
      } else {
        riskScore += 0.4; // Higher risk
        factors.push('bvn_not_verified');
      }

      // Phone verification
      if (verificationResults.phoneVerification.verified) {
        riskScore -= 0.1;
        factors.push('phone_verified');
      } else {
        riskScore += 0.1;
        factors.push('phone_not_verified');
      }

      // Compliance checks
      if (!verificationResults.complianceCheck.passed) {
        riskScore += 0.5; // Significant risk increase
        factors.push(...verificationResults.complianceCheck.flags);
      } else {
        riskScore -= 0.1;
        factors.push('compliance_clean');
      }

      // Additional risk factors
      if (user.whatsappNumber && !user.whatsappNumber.startsWith('+234')) {
        riskScore += 0.1;
        factors.push('foreign_number');
      }

      // Ensure score is between 0 and 1
      riskScore = Math.max(0, Math.min(1, riskScore + 0.5)); // Base score of 0.5

      const riskLevel = riskScore < 0.3 ? 'low' : 
                       riskScore < 0.7 ? 'medium' : 'high';

      await activityLogger.logUserActivity(
        user.id,
        'kyc_verification',
        'risk_assessment_completed',
        {
          source: 'system',
          description: 'Risk assessment completed',
          riskScore,
          riskLevel,
          factors: factors.join(', ')
        }
      );

      return {
        score: riskScore,
        level: riskLevel,
        factors
      };

    } catch (error) {
      logger.error('Risk calculation failed', { error: error.message, userId: user.id });
      return {
        score: 0.5,
        level: 'medium',
        factors: ['calculation_error']
      };
    }
  }

  async updateKycResults(user, results) {
    try {
      const kycData = {
        ...user.kycData,
        verificationResults: results,
        lastUpdated: new Date(),
        verificationSteps: {
          bvnVerification: results.bvnVerification.verified,
          phoneVerification: results.phoneVerification.verified,
          complianceCheck: results.complianceCheck.passed,
          riskAssessment: true
        }
      };

      // Determine overall KYC status
      let kycStatus = 'pending';
      
      if (results.bvnVerification.verified && 
          results.phoneVerification.verified && 
          results.complianceCheck.passed && 
          results.riskAssessment.level !== 'high') {
        kycStatus = 'verified';
      } else if (results.complianceCheck.flags.includes('sanctions_match') ||
                results.complianceCheck.flags.includes('watchlist_match') ||
                results.riskAssessment.level === 'high') {
        kycStatus = 'rejected';
      }

      await user.update({
        kycData,
        kycStatus,
        riskScore: results.riskAssessment.score
      });

      return { kycStatus, kycData };

    } catch (error) {
      logger.error('Failed to update KYC results', { error: error.message, userId: user.id });
      throw error;
    }
  }

  async sendKycStatusUpdate(user, phoneNumber, verificationResults, reference) {
    try {
      const { bvnVerification, phoneVerification, complianceCheck, riskAssessment } = verificationResults;

      let statusMessage = `🔍 *KYC Verification Update*\n\n`;
      statusMessage += `📄 Reference: ${reference}\n\n`;

      // BVN Status
      if (bvnVerification.verified) {
        statusMessage += `✅ BVN Verification: Completed\n`;
        if (bvnVerification.overallMatch) {
          statusMessage += `   ✅ All details match perfectly\n`;
        } else {
          statusMessage += `   ⚠️ Some details need review\n`;
        }
      } else {
        statusMessage += `❌ BVN Verification: Failed\n`;
        statusMessage += `   ${bvnVerification.error || 'Invalid BVN'}\n`;
      }

      // Phone Status
      if (phoneVerification.verified) {
        statusMessage += `✅ Phone Verification: Completed\n`;
      } else {
        statusMessage += `❌ Phone Verification: Failed\n`;
      }

      // Compliance Status
      if (complianceCheck.passed) {
        statusMessage += `✅ Compliance Check: Passed\n`;
      } else {
        statusMessage += `⚠️ Compliance Check: Requires Review\n`;
        if (complianceCheck.flags.length > 0) {
          statusMessage += `   Flags: ${complianceCheck.flags.join(', ')}\n`;
        }
      }

      // Risk Assessment
      const riskEmoji = riskAssessment.level === 'low' ? '🟢' : 
                       riskAssessment.level === 'medium' ? '🟡' : '🔴';
      statusMessage += `${riskEmoji} Risk Level: ${riskAssessment.level.toUpperCase()}\n\n`;

      // Overall Status
      if (user.kycStatus === 'verified') {
        statusMessage += `🎉 *Verification Complete!*\n\nYour account is now fully verified and you can access all MiiMii services.\n\n`;
      } else if (user.kycStatus === 'rejected') {
        statusMessage += `❌ *Verification Failed*\n\nYour verification could not be completed due to compliance requirements. Please contact support.\n\n`;
      } else {
        statusMessage += `⏳ *Verification Pending*\n\nWe're reviewing your information. This may take 24-48 hours.\n\n`;
      }

      statusMessage += `Need help? Contact our support team.`;

      await whatsappService.sendTextMessage(phoneNumber, statusMessage);

    } catch (error) {
      logger.error('Failed to send KYC status update', { 
        error: error.message, 
        userId: user.id 
      });
    }
  }

  async processIdDocument(imageData, documentType = 'any') {
    try {
      logger.info('Processing ID document', { documentType });

      // First, extract text using OCR
      const ocrResults = await ocrService.extractDataFromImage(imageData, 'identity_document');
      
      if (!ocrResults.text) {
        throw new Error('Could not extract text from document');
      }

      // Use Dojah for document verification if supported
      try {
        const response = await this.makeRequest('POST', '/api/v1/kyc/document', {
          document_type: documentType,
          image: imageData // Base64 encoded image
        });

        if (response.entity) {
          return {
            success: true,
            documentType: response.entity.document_type,
            extractedData: {
              firstName: response.entity.first_name,
              lastName: response.entity.last_name,
              middleName: response.entity.middle_name,
              dateOfBirth: response.entity.date_of_birth,
              gender: response.entity.gender,
              documentNumber: response.entity.document_number,
              issuedDate: response.entity.issued_date,
              expiryDate: response.entity.expiry_date,
              issuingAuthority: response.entity.issuing_authority
            },
            ocrResults,
            confidence: response.entity.confidence || 0.8
          };
        }
      } catch (dojahError) {
        logger.warn('Dojah document verification failed, using OCR only', { 
          error: dojahError.message 
        });
      }

      // Fallback to OCR-only extraction
      return {
        success: true,
        documentType: 'unknown',
        extractedData: ocrResults.data || {},
        ocrResults,
        confidence: 0.6,
        method: 'ocr_only'
      };

    } catch (error) {
      logger.error('Document processing failed', { error: error.message });
      throw error;
    }
  }

  // Utility methods for validation
  calculateBvnMatchScore(user, bvnData) {
    let score = 0;
    let totalChecks = 0;

    // Name matching
    if (this.validateNameMatch(user, bvnData)) score += 0.3;
    totalChecks += 0.3;

    // Date of birth matching
    if (this.validateDobMatch(user, bvnData)) score += 0.3;
    totalChecks += 0.3;

    // Phone matching
    if (this.validatePhoneMatch(user, bvnData)) score += 0.2;
    totalChecks += 0.2;

    // Gender matching
    if (this.validateGenderMatch(user, bvnData)) score += 0.1;
    totalChecks += 0.1;

    // Watch list status
    if (bvnData.watch_listed === 'NO') score += 0.1;
    totalChecks += 0.1;

    return totalChecks > 0 ? score / totalChecks : 0;
  }

  validateNameMatch(user, bvnData) {
    const userFirstName = user.firstName?.toLowerCase().trim();
    const userLastName = user.lastName?.toLowerCase().trim();
    const bvnFirstName = bvnData.firstname?.toLowerCase().trim();
    const bvnLastName = bvnData.lastname?.toLowerCase().trim();

    if (!userFirstName || !userLastName || !bvnFirstName || !bvnLastName) {
      return false;
    }

    // Exact match or similar match (allowing for minor differences)
    const firstNameMatch = userFirstName === bvnFirstName || 
                          this.calculateSimilarity(userFirstName, bvnFirstName) > 0.8;
    const lastNameMatch = userLastName === bvnLastName || 
                         this.calculateSimilarity(userLastName, bvnLastName) > 0.8;

    return firstNameMatch && lastNameMatch;
  }

  validateDobMatch(user, bvnData) {
    if (!user.dateOfBirth || !bvnData.date_of_birth) {
      return false;
    }

    const userDob = new Date(user.dateOfBirth);
    const bvnDob = new Date(bvnData.date_of_birth);

    return userDob.getTime() === bvnDob.getTime();
  }

  validatePhoneMatch(user, bvnData) {
    if (!user.whatsappNumber || !bvnData.phone_number1) {
      return false;
    }

    const userPhone = this.normalizePhoneNumber(user.whatsappNumber);
    const bvnPhone = this.normalizePhoneNumber(bvnData.phone_number1);

    return userPhone === bvnPhone;
  }

  validateGenderMatch(user, bvnData) {
    if (!user.gender || !bvnData.gender) {
      return true; // Don't penalize if data is missing
    }

    return user.gender.toLowerCase() === bvnData.gender.toLowerCase();
  }

  calculateSimilarity(str1, str2) {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i += 1) {
      matrix[0][i] = i;
    }

    for (let j = 0; j <= str2.length; j += 1) {
      matrix[j][0] = j;
    }

    for (let j = 1; j <= str2.length; j += 1) {
      for (let i = 1; i <= str1.length; i += 1) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + indicator
        );
      }
    }

    const distance = matrix[str2.length][str1.length];
    const maxLength = Math.max(str1.length, str2.length);
    return maxLength === 0 ? 1 : (maxLength - distance) / maxLength;
  }

  // Utility methods
  async makeRequest(method, endpoint, data = {}) {
    try {
      // Rate limiting
      await this.enforceRateLimit();

      const config = {
        ...axiosConfig,
        method,
        url: `${this.baseURL}${endpoint}`,
        headers: {
          ...axiosConfig.headers,
          'AppId': this.appId,
          'Authorization': this.secretKey,
          'Content-Type': 'application/json'
        },
        validateStatus: (status) => status < 500
      };

      if (method === 'GET') {
        config.params = data;
      } else {
        config.data = data;
      }

      const response = await axios(config);

      if (response.status >= 400) {
        throw new Error(`Dojah API error: ${response.data?.error || response.statusText}`);
      }

      return response.data;

    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error('Dojah API timeout');
      } else if (error.response) {
        throw new Error(`Dojah API error: ${error.response.data?.error || error.response.statusText}`);
      } else {
        throw new Error(`Request failed: ${error.message}`);
      }
    }
  }

  async enforceRateLimit() {
    const now = Date.now();
    
    // Reset counter if window has passed
    if (now - this.lastRequestTime > this.rateLimitWindow) {
      this.requestsThisMinute = 0;
    }

    // Check if we've exceeded the limit
    if (this.requestsThisMinute >= this.maxRequestsPerMinute) {
      const waitTime = this.rateLimitWindow - (now - this.lastRequestTime);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      this.requestsThisMinute = 0;
    }

    this.requestsThisMinute++;
    this.lastRequestTime = now;
  }

  formatDateForDojah(dateString) {
    try {
      const date = new Date(dateString);
      return date.toISOString().split('T')[0]; // YYYY-MM-DD
    } catch (error) {
      return dateString;
    }
  }

  formatPhoneForDojah(phoneNumber) {
    let cleaned = phoneNumber.replace(/\D/g, '');
    
    if (cleaned.startsWith('234')) {
      return `+${cleaned}`;
    } else if (cleaned.startsWith('0')) {
      return `+234${cleaned.substring(1)}`;
    } else if (cleaned.length === 10) {
      return `+234${cleaned}`;
    } else {
      return `+234${cleaned}`;
    }
  }

  normalizePhoneNumber(phoneNumber) {
    return phoneNumber.replace(/\D/g, '').slice(-10);
  }

  // Webhook handlers
  async handleKycVerified(data) {
    try {
      const { user_id, verification_status, details } = data;
      
      const user = await userService.getUserById(user_id);
      if (!user) {
        logger.warn('User not found for KYC verification webhook', { user_id });
        return;
      }

      await databaseService.executeWithRetry(async () => {
        const { error } = await supabase
          .from('users')
          .update({
            kycStatus: 'verified',
            kycData: {
              ...(user.kycData || {}),
              webhookVerification: details,
              verifiedAt: new Date().toISOString()
            },
            updatedAt: new Date().toISOString()
          })
          .eq('id', user_id);
        
        if (error) throw error;
      });

      await activityLogger.logUserActivity(
        user.id,
        'kyc_verification',
        'kyc_verified_webhook',
        {
          source: 'webhook',
          description: 'KYC verification completed via webhook',
          verificationStatus: verification_status
        }
      );

      // Notify user
      await whatsappService.sendTextMessage(
        user.whatsappNumber,
        `🎉 *Account Verified!*\n\nYour identity verification is now complete. You can access all MiiMii services!\n\nWelcome to the future of digital banking! 💰`
      );

    } catch (error) {
      logger.error('Failed to handle KYC verified webhook', { error: error.message, data });
    }
  }

  async handleKycRejected(data) {
    try {
      const { user_id, rejection_reason, details } = data;
      
      const user = await userService.getUserById(user_id);
      if (!user) {
        logger.warn('User not found for KYC rejection webhook', { user_id });
        return;
      }

      await databaseService.executeWithRetry(async () => {
        const { error } = await supabase
          .from('users')
          .update({
            kycStatus: 'rejected',
            kycData: {
              ...(user.kycData || {}),
              rejectionReason: rejection_reason,
              rejectionDetails: details,
              rejectedAt: new Date().toISOString()
            },
            updatedAt: new Date().toISOString()
          })
          .eq('id', user_id);
        
        if (error) throw error;
      });

      await activityLogger.logUserActivity(
        user.id,
        'kyc_verification',
        'kyc_rejected_webhook',
        {
          source: 'webhook',
          description: 'KYC verification rejected via webhook',
          rejectionReason: rejection_reason
        }
      );

      // Notify user
      await whatsappService.sendTextMessage(
        user.whatsappNumber,
        `❌ *Verification Unsuccessful*\n\nWe couldn't complete your identity verification.\n\nReason: ${rejection_reason}\n\nPlease contact our support team for assistance.`
      );

    } catch (error) {
      logger.error('Failed to handle KYC rejected webhook', { error: error.message, data });
    }
  }

  // Rubies BVN verification method
  async verifyBVNWithRubies(bvn, userData) {
    try {
      logger.info('Starting Rubies BVN verification', {
        bvnMasked: `***${bvn.slice(-4)}`,
        hasUserData: !!userData
      });

      const bvnData = {
        bvn: bvn.toString().trim(),
        firstName: userData.firstName,
        lastName: userData.lastName,
        dateOfBirth: userData.dateOfBirth,
        phoneNumber: userData.phoneNumber,
        userId: userData.userId
      };

      const verification = await rubiesService.validateBVN(bvnData);

      if (verification.success && verification.responseCode === '00') {
        logger.info('Rubies BVN verification successful', {
          bvnMasked: `***${bvn.slice(-4)}`,
          responseCode: verification.responseCode,
          responseMessage: verification.responseMessage
        });

        // Extract BVN data
        const bvnData = verification.bvn_data || verification.data || {};
        
        return {
          verified: true,
          status: 'verified',
          details: bvnData,
          provider: 'rubies',
          verifiedAt: new Date(),
          error: null,
          responseCode: verification.responseCode,
          responseMessage: verification.responseMessage
        };
      } else {
        logger.warn('Rubies BVN verification failed', {
          bvnMasked: `***${bvn.slice(-4)}`,
          responseCode: verification.responseCode,
          responseMessage: verification.responseMessage
        });

        return {
          verified: false,
          status: 'failed',
          details: null,
          error: verification.responseMessage || 'BVN verification failed',
          provider: 'rubies',
          verifiedAt: new Date(),
          responseCode: verification.responseCode
        };
      }

    } catch (error) {
      logger.error('Rubies BVN verification error', {
        error: error.message,
        bvnMasked: `***${bvn.slice(-4)}`,
        stack: error.stack
      });

      return {
        verified: false,
        status: 'error',
        details: null,
        error: error.message,
        provider: 'rubies',
        verifiedAt: new Date()
      };
    }
  }

  // Updated verifyBVN method to use Fincra
  async verifyBVN(bvn, userId) {
    try {
      const user = await userService.getUserById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const verification = await this.verifyBVNWithRubies(bvn, {
        firstName: user.firstName,
        lastName: user.lastName,
        dateOfBirth: user.dateOfBirth,
        phoneNumber: user.whatsappNumber,
        userId: user.id
      });

      // Log BVN verification attempt
      await activityLogger.logUserActivity(
        userId,
        'kyc_verification',
        verification.verified ? 'bvn_verified' : 'bvn_verification_failed',
        {
          source: 'api',
          description: `BVN verification ${verification.verified ? 'successful' : 'failed'} via Rubies`,
          provider: 'rubies',
          verified: verification.verified,
          responseCode: verification.responseCode,
          error: verification.error
        }
      );

      return {
        success: verification.verified,
        verified: verification.verified,
        data: verification.details,
        error: verification.error,
        provider: 'rubies',
        responseCode: verification.responseCode,
        responseMessage: verification.responseMessage
      };

    } catch (error) {
      logger.error('BVN verification failed', {
        error: error.message,
        userId,
        bvnMasked: `***${bvn.slice(-4)}`
      });

      return {
        success: false,
        verified: false,
        error: error.message,
        provider: 'fincra'
      };
    }
  }

  // Health check
  async healthCheck() {
    try {
      const response = await this.makeRequest('GET', '/api/v1/general/keywords');
      return { healthy: true, responseTime: Date.now() };
    } catch (error) {
      return { healthy: false, error: error.message };
    }
  }
}

module.exports = new KYCService();
