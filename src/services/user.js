const logger = require('../utils/logger');
const databaseService = require('./database');
const supabaseHelper = require('./supabaseHelper');
const { supabase } = require('../database/connection');
const activityLogger = require('./activityLogger');
const walletService = require('./wallet');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

class UserService {
  async getOrCreateUser(whatsappNumber, displayName = null) {
    try {
      if (!whatsappNumber) {
        throw new Error('WhatsApp number is required');
      }

      // Clean phone number
      let cleanNumber;
      try {
        cleanNumber = this.cleanPhoneNumber(whatsappNumber);
      } catch (cleanError) {
        logger.error('Phone number cleaning failed', { 
          error: cleanError?.message || 'Unknown error',
          whatsappNumber,
          errorType: typeof cleanError
        });
        throw new Error(`Invalid phone number format: ${whatsappNumber}. ${cleanError?.message || 'Please check the phone number format.'}`);
      }
      
      // Try to find existing user using Supabase
      let user;
      try {
        const { data: foundUser, error: findError } = await databaseService.executeWithRetry(async () => {
          return await supabase
            .from('users')
            .select('*')
            .eq('whatsappNumber', cleanNumber)
            .maybeSingle();
        });

        if (findError) {
          throw findError;
        }

        user = foundUser;
        
        // If user exists, fetch wallet separately
        if (user) {
          const { data: wallet, error: walletError } = await supabase
            .from('wallets')
            .select('*')
            .eq('userId', user.id)
            .maybeSingle();
          
          if (!walletError && wallet) {
            user.wallet = wallet;
          }
          
          // Add helper methods to user object
          this.addUserHelperMethods(user);
        }
      } catch (findError) {
        logger.error('Database find operation failed', {
          error: findError?.message || 'Unknown error',
          cleanNumber,
          errorType: typeof findError,
          stack: findError?.stack
        });
        throw findError;
      }

      if (!user) {
        // Create new user using Supabase
        try {
          const newUserData = {
            id: uuidv4(),
            whatsappNumber: cleanNumber,
            fullName: displayName || null,
            isActive: true,
            onboardingStep: 'initial',
            kycStatus: 'not_required',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          const { data: newUser, error: createError } = await databaseService.executeWithRetry(async () => {
            return await supabase
              .from('users')
              .insert(newUserData)
              .select('*')
              .single();
          });

          if (createError) {
            throw createError;
          }

          user = newUser;

          // Create wallet for new user
          const walletService = require('./wallet');
          await walletService.createWallet(user.id);

          // Fetch wallet for the new user
          const { data: wallet, error: walletError } = await supabase
            .from('wallets')
            .select('*')
            .eq('userId', user.id)
            .maybeSingle();
          
          if (!walletError && wallet) {
            user.wallet = wallet;
          }

          logger.info('New user created', { userId: user.id, whatsappNumber: cleanNumber });
        } catch (createError) {
          logger.error('User creation failed', {
            error: createError?.message || 'Unknown error',
            cleanNumber,
            errorType: typeof createError,
            stack: createError?.stack
          });
          throw createError;
        }
      } else {
        // Update display name if provided and not already set
        if (displayName && !user.fullName) {
          try {
            await databaseService.executeWithRetry(async () => {
              const { error: updateError } = await supabase
                .from('users')
                .update({ fullName: displayName, updatedAt: new Date().toISOString() })
                .eq('id', user.id);
              
              if (updateError) throw updateError;
              
      // Update local user object
      user.fullName = displayName;
      
      // Re-add helper methods after update
      this.addUserHelperMethods(user);
            });
          } catch (updateError) {
            // Non-critical error, log but don't fail
            logger.warn('Failed to update display name', {
              error: updateError?.message || 'Unknown error',
              userId: user.id
            });
          }
        }
      }

      return user;
    } catch (error) {
      // Ensure we always have an error object
      const errorMessage = error?.message || (typeof error === 'string' ? error : 'Unknown error');
      const errorStack = error?.stack || (error instanceof Error ? error.stack : undefined);
      
      logger.error('Failed to get or create user', { 
        error: errorMessage,
        stack: errorStack,
        whatsappNumber,
        errorType: typeof error,
        errorConstructor: error?.constructor?.name,
        isError: error instanceof Error
      });
      
      // Re-throw as Error object if it's not already one
      if (error instanceof Error) {
        throw error;
      } else {
        throw new Error(errorMessage);
      }
    }
  }

  async createUser(data) {
    try {
      return await databaseService.createWithRetry(User, data, {}, { operationName: 'create user' });
    } catch (error) {
      logger.error('Failed to create user', { error: error?.message || 'Unknown error', stack: error?.stack, data });
      throw error;
    }
  }

  async getUserById(userId) {
    try {
      const user = await databaseService.executeWithRetry(async () => {
        return await supabaseHelper.findByPk('users', userId);
      });
      
      if (!user) {
        throw new Error('User not found');
      }
      
      // Fetch wallet separately
      const wallet = await databaseService.executeWithRetry(async () => {
        return await supabaseHelper.findOne('wallets', { userId });
      });
      
      if (wallet) {
        user.wallet = wallet;
      }
      
      // Add helper methods to user object for backward compatibility
      return this.addUserHelperMethods(user);
    } catch (error) {
      logger.error('Failed to get user by ID', { error: error?.message || 'Unknown error', stack: error?.stack, userId });
      throw error;
    }
  }

  /**
   * Add helper methods to user object for backward compatibility
   */
  addUserHelperMethods(user) {
    if (!user || typeof user !== 'object') return user;
    
    // Add clearConversationState method
    user.clearConversationState = async () => {
      return await this.updateUser(user.id, {
        conversationState: null,
        sessionData: null
      });
    };
    
    // Add updateConversationState method
    user.updateConversationState = async (state) => {
      return await this.updateUser(user.id, {
        conversationState: state
      });
    };
    
    // Add save method (for compatibility)
    user.save = async () => {
      // Extract only the fields that should be updated
      const { id, wallet, ...updateData } = user;
      const updated = await this.updateUser(id, updateData);
      // Update local object with returned data
      Object.assign(user, updated);
      return updated;
    };
    
    // Add update method (for Sequelize compatibility)
    user.update = async (updateData) => {
      const updated = await this.updateUser(user.id, updateData);
      // Update local object with returned data
      Object.assign(user, updated);
      // Re-add helper methods after update
      this.addUserHelperMethods(user);
      return updated;
    };
    
    // Add reload method (for Sequelize compatibility)
    user.reload = async () => {
      const reloaded = await this.getUserById(user.id);
      // Replace all properties except helper methods
      const helperMethods = {
        clearConversationState: user.clearConversationState,
        updateConversationState: user.updateConversationState,
        save: user.save,
        update: user.update,
        reload: user.reload,
        validatePin: user.validatePin,
        canPerformTransactions: user.canPerformTransactions
      };
      Object.assign(user, reloaded);
      // Restore helper methods
      Object.assign(user, helperMethods);
      return user;
    };
    
    // Add validatePin method (for PIN validation)
    user.validatePin = async (pin) => {
      if (!user.pin) {
        return false;
      }
      // Check if PIN is disabled - always return true
      if (!user.pinEnabled) {
        return true;
      }
      // Validate PIN using bcrypt
      return await bcrypt.compare(pin, user.pin);
    };
    
    // Add canPerformTransactions method (for transaction eligibility check)
    user.canPerformTransactions = () => {
      const now = new Date();
      return user.isActive && 
             !user.isBanned && 
             user.onboardingStep === 'completed' &&
             user.pin &&
             (!user.pinLockedUntil || new Date(user.pinLockedUntil) < now);
    };
    
    return user;
  }

  /**
   * Check if user has completed onboarding (virtual account creation)
   */
  async checkUserOnboardingStatus(userId) {
    try {
      const user = await this.getUserById(userId);
      const walletService = require('./wallet');
      
      // Get user's wallet
      const wallet = await walletService.getUserWallet(userId);
      
      // Check if user has virtual account
      const hasVirtualAccount = !!(wallet?.virtualAccountNumber);
      
      // Check if user has completed all required onboarding steps
      const requiredFields = ['firstName', 'lastName', 'bvn', 'gender', 'dateOfBirth'];
      const missingFields = requiredFields.filter(field => !user[field]);
      
      // Check onboarding step
      const isOnboardingComplete = user.onboardingStep === 'completed';
      
      // User is considered fully onboarded if:
      // 1. They have a virtual account number
      // 2. All required fields are filled
      // 3. Onboarding step is marked as completed
      const isComplete = hasVirtualAccount && missingFields.length === 0 && isOnboardingComplete;
      
      return {
        isComplete,
        hasVirtualAccount,
        isOnboardingComplete,
        missingFields,
        onboardingStep: user.onboardingStep,
        wallet: wallet ? {
          id: wallet.id,
          hasVirtualAccount: !!wallet.virtualAccountNumber,
          virtualAccountNumber: wallet.virtualAccountNumber
        } : null
      };
    } catch (error) {
      logger.error('Error checking user onboarding status', { 
        error: error.message, 
        userId 
      });
      
      // Default to incomplete if we can't check
      return {
        isComplete: false,
        hasVirtualAccount: false,
        isOnboardingComplete: false,
        missingFields: ['firstName', 'lastName', 'bvn', 'gender', 'dateOfBirth'],
        onboardingStep: 'initial',
        wallet: null
      };
    }
  }

  async getUserByWhatsappNumber(whatsappNumber) {
    try {
      const cleanNumber = this.cleanPhoneNumber(whatsappNumber);
      
      const user = await databaseService.findOneWithRetry(User, {
        where: { whatsappNumber: cleanNumber },
        include: [{ model: Wallet, as: 'wallet' }]
      }, { operationName: 'find user by WhatsApp number' });

      return user;
    } catch (error) {
      logger.error('Failed to get user by WhatsApp number', { error: error.message, whatsappNumber });
      throw error;
    }
  }

  async findByAppEmail(email) {
    try {
      if (!email) return null;
      return await databaseService.findOneWithRetry(User, {
        where: { appEmail: email.toLowerCase() }
      }, { operationName: 'find user by appEmail' });
    } catch (error) {
      logger.error('Failed to get user by app email', { error: error.message, email });
      throw error;
    }
  }

  async updateUser(userId, updateData) {
    try {
      const updated = await databaseService.executeWithRetry(async () => {
        return await supabaseHelper.update('users', updateData, { id: userId });
      });

      if (!updated) {
        throw new Error('User not found or no changes made');
      }

      // Return updated data (don't fetch again to avoid extra query)
      // Helper methods will be added by the caller if needed
      return updated;
    } catch (error) {
      logger.error('Failed to update user', { error: error.message, userId, updateData });
      throw error;
    }
  }

  async _deleteRowsInBatches(table, userId, { column = 'userId', batchSize = 250 } = {}) {
    let totalDeleted = 0;
    let iterations = 0;
    const maxIterations = 20000;

    while (iterations < maxIterations) {
      iterations += 1;
      const { data, error } = await supabase
        .from(table)
        .select('id')
        .eq(column, userId)
        .limit(batchSize);

      if (error) throw error;
      if (!data?.length) break;

      const ids = data.map((row) => row.id);
      const { error: deleteError } = await supabase.from(table).delete().in('id', ids);
      if (deleteError) throw deleteError;

      totalDeleted += ids.length;
      if (data.length < batchSize) break;
    }

    return totalDeleted;
  }

  async _clearUserForeignKeyReferences(userId) {
    const referenceClears = [
      { table: 'users', column: 'referredBy' },
      { table: 'wallets', column: 'frozenBy' },
      { table: 'transactions', column: 'approvedBy' },
      { table: 'transactions', column: 'rejectedBy' },
      { table: 'supportTickets', column: 'assignedTo' },
      { table: 'activityLogs', column: 'adminUserId' },
      { table: 'activityLogs', column: 'reviewedBy' }
    ];

    for (const { table, column } of referenceClears) {
      const { error } = await supabase
        .from(table)
        .update({ [column]: null })
        .eq(column, userId);
      if (error) throw error;
    }

    const { error: parentError } = await supabase
      .from('transactions')
      .update({ parentTransactionId: null })
      .eq('userId', userId);
    if (parentError) throw parentError;
  }

  async _purgeUserRelatedData(userId) {
    await this._clearUserForeignKeyReferences(userId);

    const tablesInOrder = [
      'chatMessages',
      'notifications',
      'activityLogs',
      'virtualCards',
      'beneficiaries',
      'bankAccounts',
      'supportTickets',
      'transactions'
    ];

    const purgeSummary = {};
    for (const table of tablesInOrder) {
      const batchSize = table === 'transactions' || table === 'activityLogs' ? 200 : 300;
      const deletedCount = await databaseService.executeWithRetry(
        () => this._deleteRowsInBatches(table, userId, { batchSize }),
        3
      );
      purgeSummary[table] = deletedCount;
    }

    const { error: walletError } = await supabase
      .from('wallets')
      .delete()
      .eq('userId', userId);
    if (walletError) throw walletError;

    logger.info('Purged user related data', { userId, purgeSummary });
    return purgeSummary;
  }

  async deleteUser(userId, options = {}) {
    const { force = false, deletedBy = null, reason = null } = options;
    
    try {
      const user = await this.getUserById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      const wallet = await walletService.getUserWallet(userId);
      const walletBalance = wallet ? parseFloat(wallet.balance || 0) : 0;
      const pendingBalance = wallet ? parseFloat(wallet.pendingBalance || 0) : 0;

      if (!force && (walletBalance !== 0 || pendingBalance !== 0)) {
        throw new Error('User wallet must have zero balance and no pending funds before deletion');
      }

      const snapshot = {
        id: user.id,
        whatsappNumber: user.whatsappNumber,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email
      };

      await activityLogger.logAdminAction(
        deletedBy || null,
        userId,
        reason || 'User account permanently deleted by admin',
        {
          deletedBy,
          reason,
          targetUserId: userId,
          userSnapshot: snapshot
        }
      );

      await this._purgeUserRelatedData(userId);

      const { error: deleteUserError } = await supabase.from('users').delete().eq('id', userId);
      if (deleteUserError) throw deleteUserError;

      logger.info('User deleted successfully', { userId, deletedBy, force });
      return snapshot;
    } catch (error) {
      logger.error('Failed to delete user', { error: error.message, userId, deletedBy, force });
      throw error;
    }
  }

  async getAllUsers(options = {}) {
    try {
      const {
        page = 1,
        limit = 50,
        isActive = null,
        kycStatus = null
      } = options;

      const offset = (page - 1) * limit;
      const whereClause = {};

      if (isActive !== null) {
        whereClause.isActive = isActive;
      }

      if (kycStatus !== null) {
        whereClause.kycStatus = kycStatus;
      }

      const users = await databaseService.findWithRetry(User, {
        where: whereClause,
        include: [{ model: Wallet, as: 'wallet' }],
        limit,
        offset,
        order: [['createdAt', 'DESC']]
      }, { operationName: 'get all users' });

      return users;
    } catch (error) {
      logger.error('Failed to get all users', { error: error.message, options });
      throw error;
    }
  }

  async searchUsers(searchTerm, options = {}) {
    try {
      const { limit = 20 } = options;
      const cleanSearchTerm = this.cleanPhoneNumber(searchTerm);

      const users = await databaseService.findWithRetry(User, {
        where: {
          [Op.or]: [
            { whatsappNumber: { [Op.like]: `%${cleanSearchTerm}%` } },
            { firstName: { [Op.iLike]: `%${searchTerm}%` } },
            { lastName: { [Op.iLike]: `%${searchTerm}%` } },
            { email: { [Op.iLike]: `%${searchTerm}%` } }
          ]
        },
        include: [{ model: Wallet, as: 'wallet' }],
        limit,
        order: [['createdAt', 'DESC']]
      }, { operationName: 'search users' });

      return users;
    } catch (error) {
      logger.error('Failed to search users', { error: error.message, searchTerm });
      throw error;
    }
  }

  async updateUserKYCStatus(userId, kycStatus, reviewNotes = null) {
    try {
      const updateData = { 
        kycStatus,
        kycUpdatedAt: new Date()
      };

      if (reviewNotes) {
        updateData.kycReviewNotes = reviewNotes;
      }

      const [updatedRowsCount] = await databaseService.updateWithRetry(User, updateData, {
        where: { id: userId }
      }, { operationName: 'update user KYC status' });

      if (updatedRowsCount === 0) {
        throw new Error('User not found');
      }

      logger.info('User KYC status updated', { userId, kycStatus, reviewNotes });
      return await this.getUserById(userId);
    } catch (error) {
      logger.error('Failed to update user KYC status', { error: error.message, userId, kycStatus });
      throw error;
    }
  }

  async banUser(userId, reason = null, bannedBy = null) {
    try {
      const updateData = {
        isActive: false,
        isBanned: true,
        bannedAt: new Date(),
        banReason: reason,
        bannedBy: bannedBy
      };

      const [updatedRowsCount] = await databaseService.updateWithRetry(User, updateData, {
        where: { id: userId }
      }, { operationName: 'ban user' });

      if (updatedRowsCount === 0) {
        throw new Error('User not found');
      }

      logger.info('User banned', { userId, reason, bannedBy });
      return await this.getUserById(userId);
    } catch (error) {
      logger.error('Failed to ban user', { error: error.message, userId, reason });
      throw error;
    }
  }

  async unbanUser(userId, unbannedBy = null) {
    try {
      const updateData = {
        isActive: true,
        isBanned: false,
        bannedAt: null,
        banReason: null,
        bannedBy: null,
        unbannedAt: new Date(),
        unbannedBy: unbannedBy
      };

      const [updatedRowsCount] = await databaseService.updateWithRetry(User, updateData, {
        where: { id: userId }
      }, { operationName: 'unban user' });

      if (updatedRowsCount === 0) {
        throw new Error('User not found');
      }

      logger.info('User unbanned', { userId, unbannedBy });
      return await this.getUserById(userId);
    } catch (error) {
      logger.error('Failed to unban user', { error: error.message, userId });
      throw error;
    }
  }

  async setUserPin(userId, pin) {
    try {
      if (!/^\d{4}$/.test(pin)) {
        throw new Error('PIN must be 4 digits');
      }

      // Hash the PIN before storing
      const hashedPin = await bcrypt.hash(pin, 10);

      // Update user PIN using Supabase
      const { data: updatedUser, error: updateError } = await databaseService.executeWithRetry(async () => {
        return await supabase
          .from('users')
          .update({
            pin: hashedPin,
            pinAttempts: 0,
            pinLockedUntil: null,
            pinSetAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          })
          .eq('id', userId)
          .select()
          .single();
      });

      if (updateError) {
        throw updateError;
      }

      if (!updatedUser) {
        throw new Error('User not found');
      }

      // Add helper methods to user object
      this.addUserHelperMethods(updatedUser);

      logger.info('User PIN set', { userId });
      
      return updatedUser;
    } catch (error) {
      logger.error('Failed to set user PIN', { error: error.message, userId });
      throw error;
    }
  }

  async validateUserPin(userId, pin) {
    try {
      const user = await this.getUserById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }

      if (!user.pin) {
        throw new Error('PIN not set');
      }

      // Check if PIN is disabled - no validation required
      if (!user.pinEnabled) {
        logger.info('PIN validation skipped - PIN is disabled', { userId });
        return true;
      }

      // Check if PIN is locked
      if (user.pinLockedUntil && new Date(user.pinLockedUntil) > new Date()) {
        const lockMinutes = Math.ceil((new Date(user.pinLockedUntil) - new Date()) / 60000);
        throw new Error(`PIN locked for ${lockMinutes} more minutes`);
      }

      // Validate PIN using bcrypt
      const isValid = await bcrypt.compare(pin, user.pin);

      if (isValid) {
        // Reset PIN attempts on successful validation
        await databaseService.executeWithRetry(async () => {
          const { error: updateError } = await supabase
            .from('users')
            .update({
              pinAttempts: 0,
              pinLockedUntil: null,
              updatedAt: new Date().toISOString()
            })
            .eq('id', userId);
          
          if (updateError) throw updateError;
        });
        return true;
      } else {
        // Increment PIN attempts
        const newAttempts = (user.pinAttempts || 0) + 1;
        let pinLockedUntil = null;

        // Lock PIN after 3 failed attempts for 15 minutes
        if (newAttempts >= 3) {
          pinLockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
        }

        await databaseService.executeWithRetry(async () => {
          const { error: updateError } = await supabase
            .from('users')
            .update({
              pinAttempts: newAttempts,
              pinLockedUntil: pinLockedUntil ? pinLockedUntil.toISOString() : null,
              updatedAt: new Date().toISOString()
            })
            .eq('id', userId);
          
          if (updateError) throw updateError;
        });

        if (pinLockedUntil) {
          throw new Error('PIN locked for 15 minutes due to too many failed attempts');
        } else {
          throw new Error(`Invalid PIN. ${3 - newAttempts} attempts remaining`);
        }
      }
    } catch (error) {
      logger.error('PIN validation failed', { error: error.message, userId });
      throw error;
    }
  }

  async incrementAppLoginAttempts(userId) {
    try {
      const user = await this.getUserById(userId);
      if (!user) return;
      const attempts = (user.appLoginAttempts || 0) + 1;
      const updates = { 
        appLoginAttempts: attempts,
        updatedAt: new Date().toISOString()
      };
      if (attempts >= 5) {
        updates.appLockUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      }
      
      await databaseService.executeWithRetry(async () => {
        const { error } = await supabase
          .from('users')
          .update(updates)
          .eq('id', userId);
        
        if (error) throw error;
      });
    } catch (error) {
      logger.error('Failed to increment app login attempts', { error: error.message, userId });
    }
  }

  async resetAppLoginAttempts(userId) {
    try {
      const user = await this.getUserById(userId);
      if (!user) return;
      
      await databaseService.executeWithRetry(async () => {
        const { error } = await supabase
          .from('users')
          .update({
            appLoginAttempts: 0,
            appLockUntil: null,
            updatedAt: new Date().toISOString()
          })
          .eq('id', userId);
        
        if (error) throw error;
      });
    } catch (error) {
      logger.error('Failed to reset app login attempts', { error: error.message, userId });
    }
  }

  async generatePasswordResetOTP(email) {
    try {
      const user = await this.findByAppEmail(email);
      if (!user) {
        // Don't reveal if email exists or not for security
        return { success: true, message: 'If the email exists, an OTP has been sent' };
      }

      // Generate 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now

      await user.update({
        appPasswordResetOTP: otp,
        appPasswordResetOTPExpiry: otpExpiry,
        appPasswordResetOTPAttempts: 0
      });

      logger.info('Password reset OTP generated', { userId: user.id, email });

      // Send OTP via email
      try {
        const emailService = require('./emailService');
        const emailResult = await emailService.sendPasswordResetOTP(email, otp);
        if (!emailResult.success) {
          logger.warn('Failed to send password reset OTP email', {
            error: emailResult.error,
            userId: user.id
          });
          // Still return success but log the email failure
        }
      } catch (emailError) {
        logger.warn('Email service error during password reset OTP', {
          error: emailError.message,
          userId: user.id
        });
        // Continue even if email fails - OTP is still generated
      }

      // In production, remove OTP from response and send via email only
      return {
        success: true,
        message: 'If the email exists, an OTP has been sent',
        // Remove this in production - OTP should only be sent via email
        ...(process.env.NODE_ENV !== 'production' && { otp }) // Only for development/testing
      };
    } catch (error) {
      logger.error('Failed to generate password reset OTP', { error: error.message, email });
      throw error;
    }
  }

  async verifyPasswordResetOTP(email, otp) {
    try {
      const user = await this.findByAppEmail(email);
      if (!user) {
        return { valid: false, error: 'Invalid email or OTP' };
      }

      // Check if OTP exists and is not expired
      if (!user.appPasswordResetOTP || !user.appPasswordResetOTPExpiry) {
        return { valid: false, error: 'No OTP found. Please request a new one.' };
      }

      if (new Date(user.appPasswordResetOTPExpiry) < new Date()) {
        // Clear expired OTP
        await databaseService.executeWithRetry(async () => {
          const { error } = await supabase
            .from('users')
            .update({
              appPasswordResetOTP: null,
              appPasswordResetOTPExpiry: null,
              appPasswordResetOTPAttempts: 0,
              updatedAt: new Date().toISOString()
            })
            .eq('id', user.id);
          
          if (error) throw error;
        });
        return { valid: false, error: 'OTP has expired. Please request a new one.' };
      }

      // Check attempt limit (max 5 attempts)
      if (user.appPasswordResetOTPAttempts >= 5) {
        // Clear OTP after max attempts
        await databaseService.executeWithRetry(async () => {
          const { error } = await supabase
            .from('users')
            .update({
              appPasswordResetOTP: null,
              appPasswordResetOTPExpiry: null,
              appPasswordResetOTPAttempts: 0,
              updatedAt: new Date().toISOString()
            })
            .eq('id', user.id);
          
          if (error) throw error;
        });
        return { valid: false, error: 'Too many failed attempts. Please request a new OTP.' };
      }

      // Verify OTP
      if (user.appPasswordResetOTP !== otp) {
        // Increment attempt counter
        await databaseService.executeWithRetry(async () => {
          const { error } = await supabase
            .from('users')
            .update({
              appPasswordResetOTPAttempts: (user.appPasswordResetOTPAttempts || 0) + 1,
              updatedAt: new Date().toISOString()
            })
            .eq('id', user.id);
          
          if (error) throw error;
        });
        const remainingAttempts = 5 - (user.appPasswordResetOTPAttempts + 1);
        return { 
          valid: false, 
          error: `Invalid OTP. ${remainingAttempts > 0 ? `${remainingAttempts} attempt(s) remaining.` : 'Please request a new OTP.'}` 
        };
      }

      // OTP is valid
      return { valid: true, user };
    } catch (error) {
      logger.error('Failed to verify password reset OTP', { error: error.message });
      return { valid: false, error: 'OTP verification failed' };
    }
  }

  async resetPasswordWithOTP(email, otp, newPassword) {
    try {
      const verification = await this.verifyPasswordResetOTP(email, otp);
      if (!verification.valid) {
        throw new Error(verification.error || 'Invalid or expired OTP');
      }

      const user = verification.user;

      // Hash new password
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(newPassword, saltRounds);

      // Update password and clear OTP
      await databaseService.executeWithRetry(async () => {
        const { error } = await supabase
          .from('users')
          .update({
            appPasswordHash: passwordHash,
            appPasswordResetOTP: null,
            appPasswordResetOTPExpiry: null,
            appPasswordResetOTPAttempts: 0,
            appLoginAttempts: 0,
            appLockUntil: null,
            updatedAt: new Date().toISOString()
          })
          .eq('id', user.id);
        
        if (error) throw error;
      });

      logger.info('Password reset successful with OTP', { userId: user.id });

      return { success: true, message: 'Password reset successful' };
    } catch (error) {
      logger.error('Failed to reset password with OTP', { error: error.message });
      throw error;
    }
  }

  async disableUserPin(userId, confirmationPin) {
    try {
      const user = await this.getUserById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }

      if (!user.pin) {
        throw new Error('PIN not set');
      }

      // Validate the confirmation PIN using helper method
      const isValidPin = await user.validatePin(confirmationPin);
      if (!isValidPin) {
        throw new Error('Invalid PIN provided for confirmation');
      }

      // Disable PIN
      await databaseService.executeWithRetry(async () => {
        const { error } = await supabase
          .from('users')
          .update({
            pinEnabled: false,
            updatedAt: new Date().toISOString()
          })
          .eq('id', userId);
        
        if (error) throw error;
      });

      logger.info('PIN disabled for user', { userId, pinEnabled: false });
      
      return {
        success: true,
        message: 'PIN has been successfully disabled. Transactions will no longer require PIN verification.',
        pinEnabled: false
      };
    } catch (error) {
      logger.error('Failed to disable PIN', { error: error.message, userId });
      throw error;
    }
  }

  async enableUserPin(userId, confirmationPin) {
    try {
      const user = await this.getUserById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }

      if (!user.pin) {
        throw new Error('PIN not set');
      }

      // Validate the confirmation PIN using helper method
      const isValidPin = await user.validatePin(confirmationPin);
      if (!isValidPin) {
        throw new Error('Invalid PIN provided for confirmation');
      }

      // Enable PIN
      await databaseService.executeWithRetry(async () => {
        const { error } = await supabase
          .from('users')
          .update({
            pinEnabled: true,
            updatedAt: new Date().toISOString()
          })
          .eq('id', userId);
        
        if (error) throw error;
      });

      logger.info('PIN enabled for user', { userId, pinEnabled: true });
      
      return {
        success: true,
        message: 'PIN has been successfully enabled. Transactions will now require PIN verification.',
        pinEnabled: true
      };
    } catch (error) {
      logger.error('Failed to enable PIN', { error: error.message, userId });
      throw error;
    }
  }

  async getPinStatus(userId) {
    try {
      const user = await this.getUserById(userId);
      
      if (!user) {
        throw new Error('User not found');
      }

      return {
        hasPin: !!user.pin,
        pinEnabled: user.pinEnabled,
        pinLocked: user.pinLockedUntil && user.pinLockedUntil > new Date(),
        pinLockedUntil: user.pinLockedUntil
      };
    } catch (error) {
      logger.error('Failed to get PIN status', { error: error.message, userId });
      throw error;
    }
  }

  async getUserStats() {
    try {
      const stats = await databaseService.safeExecute(async () => {
        const [results] = await databaseService.queryWithRetry(`
          SELECT 
            COUNT(*) as total_users,
            COUNT(CASE WHEN "isActive" = true THEN 1 END) as active_users,
            COUNT(CASE WHEN "isBanned" = true THEN 1 END) as banned_users,
            COUNT(CASE WHEN "kycStatus" = 'verified' THEN 1 END) as verified_users,
            COUNT(CASE WHEN "createdAt" >= NOW() - INTERVAL '30 days' THEN 1 END) as new_users_30d
          FROM "Users"
        `, { type: require('sequelize').QueryTypes.SELECT });

        return results[0];
      }, {
        operationName: 'get user statistics',
        fallbackValue: {
          total_users: 0,
          active_users: 0,
          banned_users: 0,
          verified_users: 0,
          new_users_30d: 0
        }
      });

      return stats;
    } catch (error) {
      logger.error('Failed to get user stats', { error: error.message });
      return {
        total_users: 0,
        active_users: 0,
        banned_users: 0,
        verified_users: 0,
        new_users_30d: 0
      };
    }
  }

  cleanPhoneNumber(phoneNumber) {
    if (!phoneNumber) {
      throw new Error('Phone number is required');
    }

    // Convert to string if not already
    const phoneStr = String(phoneNumber).trim();
    if (!phoneStr) {
      throw new Error('Phone number cannot be empty');
    }

    // Remove all non-digit characters
    let cleaned = phoneStr.replace(/\D/g, '');
    
    if (!cleaned || cleaned.length === 0) {
      throw new Error(`Invalid phone number: ${phoneNumber} - no digits found`);
    }
    
    // Handle different input formats and convert to E.164
    if (cleaned.startsWith('234') && cleaned.length === 13) {
      // Already in +234 format without the + (e.g., 2349072874728)
      return `+${cleaned}`;
    } else if (cleaned.startsWith('0') && cleaned.length === 11) {
      // Nigerian local format (e.g., 08012345678)
      return `+234${cleaned.slice(1)}`;
    } else if (cleaned.length === 10 && /^[789]/.test(cleaned)) {
      // 10-digit Nigerian number without leading 0 (e.g., 8012345678)
      return `+234${cleaned}`;
    } else if (phoneStr.startsWith('+234') && cleaned.length === 13) {
      // Already properly formatted
      return phoneStr;
    } else if (phoneStr.startsWith('+') && cleaned.length >= 10 && cleaned.length <= 15) {
      // Other international numbers already in E.164 format
      return phoneStr;
    }
    
    // If none of the above patterns match, assume it's a Nigerian number without country code
    if (cleaned.length === 10) {
      return `+234${cleaned}`;
    }
    
    // If it's 13 digits starting with 234, add +
    if (cleaned.length === 13 && cleaned.startsWith('234')) {
      return `+${cleaned}`;
    }
    
    throw new Error(`Invalid phone number format: ${phoneNumber}. Expected Nigerian format (08012345678) or international E.164 format (+234...). Got: ${cleaned.length} digits`);
  }

  formatPhoneNumber(phoneNumber) {
    // cleanPhoneNumber now returns E.164 format, so just return it
    return this.cleanPhoneNumber(phoneNumber);
  }

  validatePhoneNumber(phoneNumber) {
    try {
      this.cleanPhoneNumber(phoneNumber);
      return true;
    } catch (error) {
      return false;
    }
  }
}

module.exports = new UserService();