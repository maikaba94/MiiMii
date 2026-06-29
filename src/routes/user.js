const express = require('express');
const userService = require('../services/user');
const walletService = require('../services/wallet');
const kycService = require('../services/kyc');
const { SupportTicket } = require('../models');
const { body, param, query, validationResult } = require('express-validator');
const logger = require('../utils/logger');

const router = express.Router();

// Middleware to validate request
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// Register or get user (WhatsApp onboarding)
router.post('/register',
  body('phoneNumber').isMobilePhone('any'),
  body('firstName').optional().notEmpty(),
  body('lastName').optional().notEmpty(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, firstName, lastName } = req.body;
      
      // Create display name from first and last name
      let displayName = null;
      if (firstName && lastName) {
        displayName = `${firstName} ${lastName}`;
      } else if (firstName) {
        displayName = firstName;
      }

      const user = await userService.getOrCreateUser(phoneNumber, displayName);
      
      // Get wallet info
      const wallet = user.wallet || await walletService.getWalletBalance(user.id);
      
      res.json({
        success: true,
        message: user.createdAt === user.updatedAt ? 'User registered successfully' : 'User login successful',
        user: {
          id: user.id,
          phoneNumber: user.whatsappNumber,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          kycStatus: user.kycStatus,
          isActive: user.isActive,
          isBanned: user.isBanned,
          hasPin: !!user.pin,
          canTransact: user.canPerformTransactions(),
          createdAt: user.createdAt,
          lastSeen: user.lastSeen
        },
        wallet: {
          balance: parseFloat(wallet.balance || 0),
          isActive: wallet.isActive,
          isFrozen: wallet.isFrozen
        }
      });
    } catch (error) {
      logger.error('User registration failed', { error: error.message, phoneNumber: req.body.phoneNumber });
      res.status(500).json({ error: error.message });
    }
  }
);

// Get user profile
router.get('/profile/:phoneNumber',
  param('phoneNumber').isMobilePhone('any'),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Get wallet balance
      const walletBalance = await walletService.getWalletBalance(user.id);
      
      // Get user stats
      const stats = await userService.getUserStats(user.id);

      res.json({
        success: true,
        profile: {
          id: user.id,
          phoneNumber: user.whatsappNumber,
          firstName: user.firstName,
          lastName: user.lastName,
          middleName: user.middleName,
          email: user.email,
          dateOfBirth: user.dateOfBirth,
          gender: user.gender,
          address: user.address,
          bvn: user.bvn ? user.bvn.substring(0, 3) + '********' : null, // Mask BVN
          kycStatus: user.kycStatus,
          isActive: user.isActive,
          isBanned: user.isBanned,
          hasPin: !!user.pin,
          canTransact: user.canPerformTransactions(),
          createdAt: user.createdAt,
          lastSeen: user.lastSeen,
          metadata: user.metadata
        },
        wallet: {
          balance: walletBalance,
          canPerformTransactions: user.canPerformTransactions()
        },
        stats
      });
    } catch (error) {
      logger.error('Failed to get user profile', { error: error.message, phoneNumber: req.params.phoneNumber });
      res.status(500).json({ error: 'Failed to get user profile' });
    }
  }
);

// Update user profile
router.put('/profile/:phoneNumber',
  param('phoneNumber').isMobilePhone('any'),
  body('firstName').optional().notEmpty(),
  body('lastName').optional().notEmpty(),
  body('middleName').optional().notEmpty(),
  body('email').optional().isEmail(),
  body('dateOfBirth').optional().isISO8601(),
  body('gender').optional().isIn(['male', 'female']),
  body('address').optional().notEmpty(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const updateData = req.body;
      
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Remove empty values
      Object.keys(updateData).forEach(key => {
        if (updateData[key] === '') {
          delete updateData[key];
        }
      });

      const updatedUser = await userService.updateUser(user.id, updateData);

      res.json({
        success: true,
        message: 'Profile updated successfully',
        user: {
          id: updatedUser.id,
          phoneNumber: updatedUser.whatsappNumber,
          firstName: updatedUser.firstName,
          lastName: updatedUser.lastName,
          middleName: updatedUser.middleName,
          email: updatedUser.email,
          dateOfBirth: updatedUser.dateOfBirth,
          gender: updatedUser.gender,
          address: updatedUser.address,
          kycStatus: updatedUser.kycStatus,
          hasPin: !!updatedUser.pin,
          canTransact: updatedUser.canPerformTransactions()
        }
      });
    } catch (error) {
      logger.error('Failed to update user profile', { error: error.message, phoneNumber: req.params.phoneNumber });
      res.status(500).json({ error: error.message });
    }
  }
);

// Set user PIN
router.post('/set-pin',
  body('phoneNumber').isMobilePhone('any'),
  body('pin').isLength({ min: 4, max: 4 }).isNumeric(),
  body('confirmPin').isLength({ min: 4, max: 4 }).isNumeric(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, pin, confirmPin } = req.body;
      
      if (pin !== confirmPin) {
        return res.status(400).json({ error: 'PIN and confirm PIN do not match' });
      }

      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      await userService.setUserPin(user.id, pin);

      res.json({
        success: true,
        message: 'PIN set successfully',
        canTransact: user.canPerformTransactions()
      });
    } catch (error) {
      logger.error('Failed to set PIN', { error: error.message, phoneNumber: req.body.phoneNumber });
      res.status(500).json({ error: error.message });
    }
  }
);

// Change user PIN
router.post('/change-pin',
  body('phoneNumber').isMobilePhone('any'),
  body('currentPin').isLength({ min: 4, max: 4 }).isNumeric(),
  body('newPin').isLength({ min: 4, max: 4 }).isNumeric(),
  body('confirmPin').isLength({ min: 4, max: 4 }).isNumeric(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, currentPin, newPin, confirmPin } = req.body;
      
      if (newPin !== confirmPin) {
        return res.status(400).json({ error: 'New PIN and confirm PIN do not match' });
      }

      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Validate current PIN
      await userService.validateUserPin(user.id, currentPin);

      // Set new PIN
      await userService.setUserPin(user.id, newPin);

      res.json({
        success: true,
        message: 'PIN changed successfully'
      });
    } catch (error) {
      logger.error('Failed to change PIN', { error: error.message, phoneNumber: req.body.phoneNumber });
      res.status(500).json({ error: error.message });
    }
  }
);

// Validate PIN
router.post('/validate-pin',
  body('phoneNumber').isMobilePhone('any'),
  body('pin').isLength({ min: 4, max: 4 }).isNumeric(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, pin } = req.body;
      
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const isValid = await userService.validateUserPin(user.id, pin);

      res.json({
        success: true,
        valid: isValid,
        message: 'PIN validated successfully'
      });
    } catch (error) {
      logger.error('PIN validation failed', { error: error.message, phoneNumber: req.body.phoneNumber });
      res.status(400).json({ error: error.message });
    }
  }
);

// Start KYC process (basic info)
router.post('/kyc/start',
  body('phoneNumber').isMobilePhone('any'),
  body('firstName').notEmpty(),
  body('lastName').notEmpty(),
  body('middleName').optional().isString(),
  body('dateOfBirth').isISO8601(),
  body('gender').isIn(['male', 'female']),
  body('address').notEmpty(),
  body('bvn').optional().isLength({ min: 11, max: 11 }).isNumeric(),
body('nin').optional().isLength({ min: 11, max: 11 }).isNumeric(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, firstName, lastName, middleName, dateOfBirth, gender, address, bvn } = req.body;
      if (!bvn && !nin) {
  return res.status(400).json({
    error: 'Either BVN or NIN is required'
  });
      }
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found. Please register first.' });
      }

      const result = await kycService.startKycProcess(user, phoneNumber, {
  firstName,
  lastName,
 middleName,
  dateOfBirth,
  gender,
  address,
  bvn,
  nin
});

      res.json({
        success: true,
        message: 'KYC process started successfully',
        kyc: result,
        user: {
          kycStatus: user.kycStatus,
          canTransact: user.canPerformTransactions()
        }
      });
    } catch (error) {
      logger.error('KYC process failed', { error: error.message, phoneNumber: req.body.phoneNumber });
      res.status(500).json({ error: error.message });
    }
  }
);

// Get KYC status
router.get('/kyc/status/:phoneNumber',
  param('phoneNumber').isMobilePhone('any'),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({
        success: true,
        kyc: {
          status: user.kycStatus,
          isComplete: user.isKycComplete(),
          data: user.kycData,
          canTransact: user.canPerformTransactions()
        }
      });
    } catch (error) {
      logger.error('Failed to get KYC status', { error: error.message, phoneNumber: req.params.phoneNumber });
      res.status(500).json({ error: 'Failed to get KYC status' });
    }
  }
);

// Check if user exists
router.post('/check-exists',
  body('phoneNumber').isMobilePhone('any'),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber } = req.body;
      
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      
      res.json({
        success: true,
        exists: !!user,
        user: user ? {
          phoneNumber: user.whatsappNumber,
          firstName: user.firstName,
          lastName: user.lastName,
          kycStatus: user.kycStatus,
          hasPin: !!user.pin,
          canTransact: user.canPerformTransactions(),
          isActive: user.isActive,
          isBanned: user.isBanned
        } : null
      });
    } catch (error) {
      logger.error('Failed to check user existence', { error: error.message, phoneNumber: req.body.phoneNumber });
      res.status(500).json({ error: 'Failed to check user' });
    }
  }
);

// Get onboarding status/checklist
router.get('/onboarding/:phoneNumber',
  param('phoneNumber').isMobilePhone('any'),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const checklist = {
        basicProfile: {
          completed: !!(user.firstName && user.lastName),
          items: {
            firstName: !!user.firstName,
            lastName: !!user.lastName,
            phoneNumber: !!user.whatsappNumber
          }
        },
        pinSetup: {
          completed: !!user.pin,
          required: true
        },
        kycVerification: {
          completed: user.kycStatus === 'verified',
          status: user.kycStatus,
          required: true,
          items: {
            personalInfo: !!(user.firstName && user.lastName && user.dateOfBirth && user.gender && user.address),
            bvnVerification: !!user.bvn,
            documentUpload: user.kycData && user.kycData.documents && user.kycData.documents.length > 0
          }
        },
        walletSetup: {
          completed: !!user.wallet,
          canTransact: user.canPerformTransactions()
        }
      };

      const overallProgress = Object.values(checklist).reduce((total, item) => {
        return total + (item.completed ? 1 : 0);
      }, 0) / Object.keys(checklist).length * 100;

      res.json({
        success: true,
        onboarding: {
          isComplete: user.canPerformTransactions(),
          progress: Math.round(overallProgress),
          checklist,
          nextStep: getNextOnboardingStep(checklist)
        }
      });
    } catch (error) {
      logger.error('Failed to get onboarding status', { error: error.message, phoneNumber: req.params.phoneNumber });
      res.status(500).json({ error: 'Failed to get onboarding status' });
    }
  }
);

// Helper function to determine next onboarding step
function getNextOnboardingStep(checklist) {
  if (!checklist.basicProfile.completed) {
    return 'complete_profile';
  }
  if (!checklist.pinSetup.completed) {
    return 'set_pin';
  }
  if (!checklist.kycVerification.completed) {
    if (!checklist.kycVerification.items.personalInfo) {
      return 'kyc_personal_info';
    }
    if (!checklist.kycVerification.items.bvnVerification) {
      return 'kyc_bvn_verification';
    }
    if (!checklist.kycVerification.items.documentUpload) {
      return 'kyc_document_upload';
    }
    return 'kyc_review';
  }
  return 'completed';
}

// Search users (admin function)
router.get('/search',
  query('q').notEmpty(),
  query('limit').optional().isInt({ min: 1, max: 50 }),
  validateRequest,
  async (req, res) => {
    try {
      const { q, limit = 10 } = req.query;
      
      const users = await userService.searchUsers(q, limit);
      
      res.json({
        success: true,
        users: users.map(user => ({
          id: user.id,
          phoneNumber: user.whatsappNumber,
          firstName: user.firstName,
          lastName: user.lastName,
          kycStatus: user.kycStatus,
          isActive: user.isActive,
          isBanned: user.isBanned,
          lastSeen: user.lastSeen,
          walletBalance: parseFloat(user.wallet?.balance || 0)
        }))
      });
    } catch (error) {
      logger.error('User search failed', { error: error.message, query: req.query.q });
      res.status(500).json({ error: 'Search failed' });
    }
  }
);

// Create Support Ticket (User endpoint - phone number based)
router.post('/support/tickets',
  [
    body('phoneNumber').isMobilePhone('any').withMessage('Valid phone number is required'),
    body('type').isIn(['dispute', 'complaint', 'inquiry', 'technical', 'refund']).withMessage('Valid ticket type is required'),
    body('subject').isString().trim().notEmpty().isLength({ min: 5, max: 200 }).withMessage('Subject must be between 5 and 200 characters'),
    body('description').isString().trim().notEmpty().isLength({ min: 10, max: 5000 }).withMessage('Description must be between 10 and 5000 characters'),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent']).withMessage('Invalid priority level'),
    body('transactionId').optional().isUUID().withMessage('Invalid transaction ID format')
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, type, subject, description, priority = 'medium', transactionId } = req.body;
      
      // Get user by phone number
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found. Please register first.' });
      }

      // Check if user is active
      if (!user.isActive || user.isBanned) {
        return res.status(403).json({ error: 'Account is inactive or banned' });
      }
      
      // Generate unique ticket number
      const ticketNumber = `TKT-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
      
      // Create support ticket
      const ticket = await SupportTicket.create({
        ticketNumber,
        userId: user.id,
        transactionId: transactionId || null,
        type,
        priority,
        status: 'open',
        subject: subject.trim(),
        description: description.trim(),
        metadata: {
          source: 'user_api',
          phoneNumber: phoneNumber,
          createdAt: new Date().toISOString()
        }
      });

      logger.info('Support ticket created via user API', { 
        ticketId: ticket.id, 
        ticketNumber: ticket.ticketNumber,
        userId: user.id,
        phoneNumber: phoneNumber
      });
      
      res.json({
        success: true,
        message: 'Support ticket created successfully',
        ticket: {
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          type: ticket.type,
          priority: ticket.priority,
          status: ticket.status,
          subject: ticket.subject,
          createdAt: ticket.createdAt
        }
      });
    } catch (error) {
      logger.error('Failed to create support ticket', { 
        error: error.message,
        stack: error.stack,
        phoneNumber: req.body.phoneNumber
      });
      res.status(500).json({ 
        error: 'Failed to create support ticket',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
);

// Get User's Support Tickets
router.get('/support/tickets/:phoneNumber',
  param('phoneNumber').isMobilePhone('any'),
  query('status').optional().isIn(['open', 'in_progress', 'resolved', 'closed']),
  query('type').optional().isIn(['dispute', 'complaint', 'inquiry', 'technical', 'refund']),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('offset').optional().isInt({ min: 0 }),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber } = req.params;
      const { status, type, limit = 20, offset = 0 } = req.query;
      
      // Get user by phone number
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const where = { userId: user.id };
      if (status) where.status = status;
      if (type) where.type = type;

      const { count, rows: tickets } = await SupportTicket.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10)
      });

      return res.json({
        success: true,
        tickets: tickets.map(ticket => ({
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          type: ticket.type,
          priority: ticket.priority,
          status: ticket.status,
          subject: ticket.subject,
          description: ticket.description,
          resolution: ticket.resolution,
          resolvedAt: ticket.resolvedAt,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt
        })),
        pagination: {
          total: count,
          limit: parseInt(limit, 10),
          offset: parseInt(offset, 10),
          hasMore: (parseInt(offset, 10) + parseInt(limit, 10)) < count
        }
      });
    } catch (error) {
      logger.error('Failed to get support tickets', { error: error.message, phoneNumber: req.params.phoneNumber });
      return res.status(500).json({ error: 'Failed to get support tickets' });
    }
  }
);

// Get Single Support Ticket
router.get('/support/tickets/:phoneNumber/:ticketId',
  param('phoneNumber').isMobilePhone('any'),
  param('ticketId').isUUID(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, ticketId } = req.params;
      
      // Get user by phone number
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const ticket = await SupportTicket.findOne({
        where: {
          id: ticketId,
          userId: user.id
        }
      });

      if (!ticket) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      return res.json({
        success: true,
        ticket: {
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          type: ticket.type,
          priority: ticket.priority,
          status: ticket.status,
          subject: ticket.subject,
          description: ticket.description,
          resolution: ticket.resolution,
          resolvedAt: ticket.resolvedAt,
          createdAt: ticket.createdAt,
          updatedAt: ticket.updatedAt,
          metadata: ticket.metadata
        }
      });
    } catch (error) {
      logger.error('Failed to get support ticket', { error: error.message, ticketId: req.params.ticketId });
      return res.status(500).json({ error: 'Failed to get support ticket' });
    }
  }
);

module.exports = router;
