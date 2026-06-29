const express = require('express');
const kycService = require('../services/kyc');
const userService = require('../services/user');
const { body, param, validationResult } = require('express-validator');
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

// Start KYC process
router.post('/start',
  body('phoneNumber').isMobilePhone('any'),
  body('firstName').notEmpty(),
  body('lastName').notEmpty(),
  body('middleName').optional().isString(),
  body('dateOfBirth').isISO8601(),
  body('gender').isIn(['male', 'female']),
  body('address').notEmpty(),
  body('bvn').isLength({ min: 11, max: 11 }).isNumeric(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, firstName, lastName, middleName, dateOfBirth, gender, address, bvn } = req.body;
      
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const result = await kycService.startKycProcess(user, phoneNumber, {
        firstName,
        lastName,
        middleName,
        dateOfBirth,
        gender,
        address,
        bvn
      });

      res.json({
        success: true,
        message: 'KYC process started successfully',
        kycStatus: result.kycStatus,
        reference: result.reference
      });
    } catch (error) {
      logger.error('Failed to start KYC process', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
);

// Get KYC status
router.get('/status/:phoneNumber',
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
        kycStatus: user.kycStatus,
        kycData: user.kycData,
        userInfo: {
          firstName: user.firstName,
          lastName: user.lastName,
          middleName: user.middleName,
          dateOfBirth: user.dateOfBirth,
          gender: user.gender,
          address: user.address,
          bvn: user.bvn ? '***' + user.bvn.slice(-4) : null // Mask BVN for security
        }
      });
    } catch (error) {
      logger.error('Failed to get KYC status', { error: error.message });
      res.status(500).json({ error: 'Failed to get KYC status' });
    }
  }
);

// Update KYC information
router.put('/update',
  body('phoneNumber').isMobilePhone('any'),
  body('firstName').optional().notEmpty(),
  body('lastName').optional().notEmpty(),
  body('middleName').optional().isString(),
  body('dateOfBirth').optional().isISO8601(),
  body('gender').optional().isIn(['male', 'female']),
  body('address').optional().notEmpty(),
  body('bvn').optional().isLength({ min: 11, max: 11 }).isNumeric(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, ...updateData } = req.body;
      
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.kycStatus === 'verified') {
        return res.status(400).json({ error: 'Cannot update KYC information for verified users' });
      }

      // Remove undefined values
      const cleanedData = Object.fromEntries(
        Object.entries(updateData).filter(([_, v]) => v !== undefined)
      );

      const updatedUser = await userService.updateUser(user.id, {
        ...cleanedData,
        kycStatus: 'pending' // Reset to pending when information is updated
      });

      res.json({
        success: true,
        message: 'KYC information updated successfully',
        kycStatus: updatedUser.kycStatus
      });
    } catch (error) {
      logger.error('Failed to update KYC information', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
);

// Verify BVN
router.post('/verify-bvn',
  body('phoneNumber').isMobilePhone('any'),
  body('bvn').isLength({ min: 11, max: 11 }).isNumeric(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, bvn } = req.body;
      
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const result = await kycService.verifyBvn(bvn, user);

      res.json({
        success: true,
        message: 'BVN verification completed',
        verified: result.verified,
        details: result.details
      });
    } catch (error) {
      logger.error('Failed to verify BVN', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
);
// Verify NIN
router.post('/verify-nin',
  body('phoneNumber').isMobilePhone('any'),
  body('nin').isLength({ min: 11, max: 11 }).isNumeric(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, nin } = req.body;

      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const result = await kycService.validateNIN({
        nin,
        firstName: user.firstName,
        lastName: user.lastName,
        dateOfBirth: user.dateOfBirth,
        userId: user.id
      });

      res.json({
        success: true,
        message: 'NIN verification completed',
        verified: true,
        details: result.data
      });

    } catch (error) {
      logger.error('Failed to verify NIN', {
        error: error.message
      });

      res.status(500).json({
        error: error.message
      });
    }
  }
);
// Submit KYC documents
router.post('/submit-documents',
  body('phoneNumber').isMobilePhone('any'),
  body('documentType').isIn(['id_card', 'passport', 'drivers_license', 'voters_card']),
  body('documentNumber').notEmpty(),
  validateRequest,
  async (req, res) => {
    try {
      const { phoneNumber, documentType, documentNumber } = req.body;
      
      const user = await userService.getUserByPhoneNumber(phoneNumber);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const result = await kycService.submitDocuments(user, {
        documentType,
        documentNumber
      });

      res.json({
        success: true,
        message: 'KYC documents submitted successfully',
        reference: result.reference,
        status: result.status
      });
    } catch (error) {
      logger.error('Failed to submit KYC documents', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
);

// Admin: Get all KYC applications
router.get('/applications',
  async (req, res) => {
    try {
      const { status, page = 1, limit = 20 } = req.query;
      
      const where = {};
      if (status) where.kycStatus = status;

      const offset = (parseInt(page) - 1) * parseInt(limit);

      const users = await require('../models').User.findAndCountAll({
        where,
        order: [['updatedAt', 'DESC']],
        limit: parseInt(limit),
        offset,
        attributes: [
          'id', 'firstName', 'lastName', 'middleName', 'whatsappNumber',
          'dateOfBirth', 'gender', 'address', 'bvn', 'kycStatus', 'kycData',
          'createdAt', 'updatedAt'
        ]
      });

      res.json({
        success: true,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: users.count,
          pages: Math.ceil(users.count / parseInt(limit))
        },
        applications: users.rows.map(user => ({
          id: user.id,
          name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
          whatsappNumber: user.whatsappNumber,
          kycStatus: user.kycStatus,
          bvn: user.bvn ? '***' + user.bvn.slice(-4) : null,
          submittedAt: user.updatedAt,
          documents: user.kycData?.documents || []
        }))
      });
    } catch (error) {
      logger.error('Failed to get KYC applications', { error: error.message });
      res.status(500).json({ error: 'Failed to get KYC applications' });
    }
  }
);

// Admin: Approve/Reject KYC
router.post('/review/:userId',
  param('userId').isUUID(),
  body('action').isIn(['approve', 'reject']),
  body('reason').optional().isString(),
  validateRequest,
  async (req, res) => {
    try {
      const { userId } = req.params;
      const { action, reason } = req.body;
      
      const user = await userService.getUserById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const result = await kycService.reviewKycApplication(user, action, reason);

      res.json({
        success: true,
        message: `KYC ${action}d successfully`,
        kycStatus: result.kycStatus
      });
    } catch (error) {
      logger.error('Failed to review KYC application', { error: error.message });
      res.status(500).json({ error: error.message });
    }
  }
);

module.exports = router;
