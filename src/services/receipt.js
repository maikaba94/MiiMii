const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, registerFont } = require('canvas');
const logger = require('../utils/logger');

class ReceiptService {
  constructor() {
    this.fontPath = path.join(__dirname, '../../assets/fonts');
    this.logoPath = path.join(__dirname, '../../assets/images');
    this.templatePath = path.join(__dirname, '../../assets/templates');
    
    // High-quality scaling factor for better image resolution
    this.scale = 2; // 2x scaling for 800x1200 instead of 400x600
    
    // Register Google Outfit font if available
    try {
      const outfitFontPath = path.join(this.fontPath, 'Outfit-Regular.ttf');
      const outfitBoldFontPath = path.join(this.fontPath, 'Outfit-Bold.ttf');
      
      if (fs.existsSync(outfitFontPath)) {
        registerFont(outfitFontPath, { family: 'Outfit' });
        logger.info('Google Outfit font registered successfully');
      }
      
      if (fs.existsSync(outfitBoldFontPath)) {
        registerFont(outfitBoldFontPath, { family: 'Outfit Bold' });
        logger.info('Google Outfit Bold font registered successfully');
      }
    } catch (error) {
      logger.warn('Font registration failed, using default fonts', { error: error.message });
    }
  }

  // Helper method to scale coordinates and dimensions
  scaleValue(value) {
    return value * this.scale;
  }

  async loadLogo() {
    try {
      const logoPath = path.join(this.logoPath, 'logo.png');
      if (fs.existsSync(logoPath)) {
        const logo = await loadImage(logoPath);
        logger.info('Logo loaded successfully');
        return logo;
      } else {
        logger.warn('Logo file not found, using placeholder');
        return null;
      }
    } catch (error) {
      logger.warn('Failed to load logo, using placeholder', { error: error.message });
      return null;
    }
  }

  async generateReceipt(transactionData) {
    try {
      const {
        transactionType,
        amount,
        sender,
        beneficiary,
        reference,
        date,
        status = 'Successful',
        remark = '',
        charges = 0,
        discount = 0
      } = transactionData;

      // Create high-quality canvas
      const canvas = createCanvas(this.scaleValue(400), this.scaleValue(600));
      const ctx = canvas.getContext('2d');
      
      // Enable high-quality rendering
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Set background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.scaleValue(400), this.scaleValue(600));

      // Header
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, this.scaleValue(400), this.scaleValue(80));

      // Load and draw logo
      const logo = await this.loadLogo();
      if (logo) {
        // Calculate logo dimensions to fit in header
        const logoSize = this.scaleValue(40);
        const logoX = this.scaleValue(30);
        const logoY = this.scaleValue(20);
        ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
      } else {
        // Logo placeholder (red swirl)
        ctx.fillStyle = '#ff6666';
        ctx.beginPath();
        ctx.arc(this.scaleValue(50), this.scaleValue(40), this.scaleValue(20), 0, 2 * Math.PI);
        ctx.fill();
      }

      // MiiMii.AI title
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${this.scaleValue(24)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('MiiMii.AI', this.scaleValue(200), this.scaleValue(35));

      // Transaction Receipt title
      ctx.fillStyle = '#000000';
      ctx.font = `bold italic ${this.scaleValue(28)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('Transaction Receipt', this.scaleValue(200), this.scaleValue(120));

      // Generated date
      ctx.font = `${this.scaleValue(12)}px Outfit, Arial`;
      ctx.fillStyle = '#666666';
      ctx.fillText(`Generated from The MiiMii AI on ${date}`, this.scaleValue(200), this.scaleValue(140));

      // Content area background
      ctx.fillStyle = '#f0f8f0';
      ctx.fillRect(this.scaleValue(20), this.scaleValue(160), this.scaleValue(360), this.scaleValue(320));

      // Transaction details
      const details = [
        { label: 'Transaction Amount', value: `₦ ${parseFloat(amount).toLocaleString()}.00` },
        { label: 'Transaction Type', value: transactionType || 'Bank Transfer' },
        { label: 'Transaction Date', value: date },
        { label: 'Sender', value: sender || 'N/A' },
        { label: 'Beneficiary', value: beneficiary || 'N/A' },
        { label: 'Bank', value: transactionData.recipientBank || 'Rubies MFB' },
        { label: 'Remark', value: remark || 'N/A' },
        { label: 'Transaction Fee', value: `₦ ${parseFloat(charges || 0).toLocaleString()}.00` },
        { label: 'Transaction Reference', value: reference },
        { label: 'Transaction Status', value: status }
      ];

      let yPos = this.scaleValue(180);
      details.forEach((detail, index) => {
        // Label
        ctx.fillStyle = '#333333';
        ctx.font = `bold ${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'left';
        ctx.fillText(detail.label, this.scaleValue(40), yPos);

        // Separator line
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.scaleValue(40), yPos + this.scaleValue(5));
        ctx.lineTo(this.scaleValue(360), yPos + this.scaleValue(5));
        ctx.stroke();

        // Value
        ctx.fillStyle = '#000000';
        ctx.font = `${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'right';
        ctx.fillText(detail.value, this.scaleValue(360), yPos);

        yPos += this.scaleValue(35);
      });

      // Footer - Short contact info
      ctx.fillStyle = '#666666';
      ctx.font = `${this.scaleValue(9)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('Support: contactcenter@chatmiimii.com', this.scaleValue(200), this.scaleValue(520));

      // Red line
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.scaleValue(50), this.scaleValue(540));
      ctx.lineTo(this.scaleValue(350), this.scaleValue(540));
      ctx.stroke();

      // Brand message
      ctx.fillStyle = '#000000';
      ctx.font = `${this.scaleValue(9)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      const brandMessage = 'MiiMii is powered by a CBN licensed partner and insured by NDIC. Send money, buy airtime, buy data, pay your bills and cable subscription with just a chat all inside whatsapp';
      // Split into multiple lines if needed (max ~50 chars per line)
      const words = brandMessage.split(' ');
      let line = '';
      yPos = this.scaleValue(560); // Reuse existing yPos variable
      words.forEach((word, index) => {
        const testLine = line + word + ' ';
        if (testLine.length > 50 && line.length > 0) {
          ctx.fillText(line.trim(), this.scaleValue(200), yPos);
          line = word + ' ';
          yPos += this.scaleValue(15);
        } else {
          line = testLine;
        }
      });
      if (line.trim().length > 0) {
        ctx.fillText(line.trim(), this.scaleValue(200), yPos);
      }

      // Convert to buffer
      const buffer = canvas.toBuffer('image/jpeg', { quality: 1.0 });
      
      // Validate the generated buffer
      if (!buffer || !Buffer.isBuffer(buffer)) {
        throw new Error('Failed to generate valid image buffer');
      }
      
      const bufferSizeInKB = buffer.length / 1024;
      logger.info('Receipt generated successfully', {
        reference,
        transactionType,
        amount,
        bufferSize: `${bufferSizeInKB.toFixed(2)}KB`
      });

      return buffer;
    } catch (error) {
      logger.error('Failed to generate receipt', { error: error.message, transactionData });
      throw error;
    }
  }

  async generateAirtimeReceipt(transactionData) {
    try {
      const {
        network,
        phoneNumber,
        amount,
        reference,
        date,
        status = 'Successful',
        discount = 0
      } = transactionData;

      // Create high-quality canvas
      const canvas = createCanvas(this.scaleValue(400), this.scaleValue(600));
      const ctx = canvas.getContext('2d');
      
      // Enable high-quality rendering
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Set background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.scaleValue(400), this.scaleValue(600));

      // Header
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, this.scaleValue(400), this.scaleValue(80));

      // Load and draw logo
      const logo = await this.loadLogo();
      if (logo) {
        // Calculate logo dimensions to fit in header
        const logoSize = this.scaleValue(40);
        const logoX = this.scaleValue(30);
        const logoY = this.scaleValue(20);
        ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
      } else {
        // Logo placeholder (red swirl)
        ctx.fillStyle = '#ff6666';
        ctx.beginPath();
        ctx.arc(this.scaleValue(50), this.scaleValue(40), this.scaleValue(20), 0, 2 * Math.PI);
        ctx.fill();
      }

      // MiiMii.AI title
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${this.scaleValue(24)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('MiiMii.AI', this.scaleValue(200), this.scaleValue(35));

      // Transaction Receipt title
      ctx.fillStyle = '#000000';
      ctx.font = `bold italic ${this.scaleValue(28)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('Transaction Receipt', this.scaleValue(200), this.scaleValue(120));

      // Generated date
      ctx.font = `${this.scaleValue(12)}px Outfit, Arial`;
      ctx.fillStyle = '#666666';
      ctx.fillText(`Generated from The MiiMii AI on ${date}`, this.scaleValue(200), this.scaleValue(140));

      // Content area background
      ctx.fillStyle = '#f0f8f0';
      ctx.fillRect(this.scaleValue(20), this.scaleValue(160), this.scaleValue(360), this.scaleValue(320));

      // Transaction details (removed discount as requested)
      const details = [
        { label: 'Transaction Amount', value: `₦ ${parseFloat(amount).toLocaleString()}.00` },
        { label: 'Transaction Type', value: 'Airtime Purchase' },
        { label: 'Transaction Date', value: date },
        { label: 'Network', value: network },
        { label: 'Phone Number', value: phoneNumber },
        { label: 'Transaction Reference', value: reference },
        { label: 'Transaction Status', value: status }
      ];

      let yPos = this.scaleValue(180);
      details.forEach((detail, index) => {
        // Label
        ctx.fillStyle = '#333333';
        ctx.font = `bold ${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'left';
        ctx.fillText(detail.label, this.scaleValue(40), yPos);

        // Separator line
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.scaleValue(40), yPos + this.scaleValue(5));
        ctx.lineTo(this.scaleValue(360), yPos + this.scaleValue(5));
        ctx.stroke();

        // Value
        ctx.fillStyle = '#000000';
        ctx.font = `${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'right';
        ctx.fillText(detail.value, this.scaleValue(360), yPos);

        yPos += this.scaleValue(35);
      });

      // Footer - Short contact info
      ctx.fillStyle = '#666666';
      ctx.font = `${this.scaleValue(9)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('Support: contactcenter@chatmiimii.com', this.scaleValue(200), this.scaleValue(520));

      // Red line
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.scaleValue(50), this.scaleValue(540));
      ctx.lineTo(this.scaleValue(350), this.scaleValue(540));
      ctx.stroke();

      // Brand message
      ctx.fillStyle = '#000000';
      ctx.font = `${this.scaleValue(9)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      const brandMessage = 'MiiMii is powered by a CBN licensed partner and insured by NDIC. Send money, buy airtime, buy data, pay your bills and cable subscription with just a chat all inside whatsapp';
      // Split into multiple lines if needed (max ~50 chars per line)
      const words = brandMessage.split(' ');
      let line = '';
      yPos = this.scaleValue(560); // Reuse existing yPos variable
      words.forEach((word, index) => {
        const testLine = line + word + ' ';
        if (testLine.length > 50 && line.length > 0) {
          ctx.fillText(line.trim(), this.scaleValue(200), yPos);
          line = word + ' ';
          yPos += this.scaleValue(15);
        } else {
          line = testLine;
        }
      });
      if (line.trim().length > 0) {
        ctx.fillText(line.trim(), this.scaleValue(200), yPos);
      }

      // Convert to buffer
      const buffer = canvas.toBuffer('image/jpeg', { quality: 1.0 });
      
      // Validate the generated buffer
      if (!buffer || !Buffer.isBuffer(buffer)) {
        throw new Error('Failed to generate valid image buffer');
      }
      
      const bufferSizeInKB = buffer.length / 1024;
      logger.info('Airtime receipt generated successfully', {
        reference,
        network,
        phoneNumber,
        amount,
        bufferSize: `${bufferSizeInKB.toFixed(2)}KB`
      });

      return buffer;
    } catch (error) {
      logger.error('Failed to generate airtime receipt', { error: error.message, transactionData });
      throw error;
    }
  }

  async generateDataReceipt(transactionData) {
    try {
      const {
        network,
        phoneNumber,
        dataPlan,
        amount,
        reference,
        date,
        status = 'Successful',
        discount = 0
      } = transactionData;

      // Create high-quality canvas
      const canvas = createCanvas(this.scaleValue(400), this.scaleValue(600));
      const ctx = canvas.getContext('2d');
      
      // Enable high-quality rendering
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Set background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.scaleValue(400), this.scaleValue(600));

      // Header
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, this.scaleValue(400), this.scaleValue(80));

      // Load and draw logo
      const logo = await this.loadLogo();
      if (logo) {
        const logoSize = this.scaleValue(40);
        const logoX = this.scaleValue(30);
        const logoY = this.scaleValue(20);
        ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
      } else {
        ctx.fillStyle = '#ff6666';
        ctx.beginPath();
        ctx.arc(this.scaleValue(50), this.scaleValue(40), this.scaleValue(20), 0, 2 * Math.PI);
        ctx.fill();
      }

      // MiiMii.AI title
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${this.scaleValue(24)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('MiiMii.AI', this.scaleValue(200), this.scaleValue(35));

      // Transaction Receipt title
      ctx.fillStyle = '#000000';
      ctx.font = `bold italic ${this.scaleValue(28)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('Transaction Receipt', this.scaleValue(200), this.scaleValue(120));

      // Generated date
      ctx.font = `${this.scaleValue(12)}px Outfit, Arial`;
      ctx.fillStyle = '#666666';
      ctx.fillText(`Generated from The MiiMii AI on ${date}`, this.scaleValue(200), this.scaleValue(140));

      // Content area background
      ctx.fillStyle = '#f0f8f0';
      ctx.fillRect(this.scaleValue(20), this.scaleValue(160), this.scaleValue(360), this.scaleValue(320));

      // Transaction details
      const details = [
        { label: 'Transaction Amount', value: `₦ ${parseFloat(amount).toLocaleString()}.00` },
        { label: 'Transaction Type', value: 'Data Purchase' },
        { label: 'Transaction Date', value: date },
        { label: 'Network', value: network },
        { label: 'Phone Number', value: phoneNumber },
        { label: 'Data Plan', value: dataPlan },
        { label: 'Transaction Reference', value: reference },
        { label: 'Transaction Status', value: status }
      ];

      let yPos = this.scaleValue(180);
      details.forEach((detail, index) => {
        // Label
        ctx.fillStyle = '#333333';
        ctx.font = `bold ${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'left';
        ctx.fillText(detail.label, this.scaleValue(40), yPos);

        // Separator line
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.scaleValue(40), yPos + this.scaleValue(5));
        ctx.lineTo(this.scaleValue(360), yPos + this.scaleValue(5));
        ctx.stroke();

        // Value
        ctx.fillStyle = '#000000';
        ctx.font = `${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'right';
        ctx.fillText(detail.value, this.scaleValue(360), yPos);

        yPos += this.scaleValue(35);
      });

      // Footer - Short contact info
      ctx.fillStyle = '#666666';
      ctx.font = `${this.scaleValue(9)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('Support: contactcenter@chatmiimii.com', this.scaleValue(200), this.scaleValue(520));

      // Red line
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.scaleValue(50), this.scaleValue(540));
      ctx.lineTo(this.scaleValue(350), this.scaleValue(540));
      ctx.stroke();

      // Brand message
      ctx.fillStyle = '#000000';
      ctx.font = `${this.scaleValue(9)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      const brandMessage = 'MiiMii is powered by a CBN licensed partner and insured by NDIC. Send money, buy airtime, buy data, pay your bills and cable subscription with just a chat all inside whatsapp';
      // Split into multiple lines if needed (max ~50 chars per line)
      const words = brandMessage.split(' ');
      let line = '';
      yPos = this.scaleValue(560); // Reuse existing yPos variable
      words.forEach((word, index) => {
        const testLine = line + word + ' ';
        if (testLine.length > 50 && line.length > 0) {
          ctx.fillText(line.trim(), this.scaleValue(200), yPos);
          line = word + ' ';
          yPos += this.scaleValue(15);
        } else {
          line = testLine;
        }
      });
      if (line.trim().length > 0) {
        ctx.fillText(line.trim(), this.scaleValue(200), yPos);
      }

      // Convert to buffer
      const buffer = canvas.toBuffer('image/jpeg', { quality: 1.0 });
      
      // Validate the generated buffer
      if (!buffer || !Buffer.isBuffer(buffer)) {
        throw new Error('Failed to generate valid image buffer');
      }
      
      const bufferSizeInKB = buffer.length / 1024;
      logger.info('Data receipt generated successfully', {
        reference,
        network,
        phoneNumber,
        dataPlan,
        amount,
        bufferSize: `${bufferSizeInKB.toFixed(2)}KB`
      });

      return buffer;
    } catch (error) {
      logger.error('Failed to generate data receipt', { error: error.message, transactionData });
      throw error;
    }
  }

  async generateElectricityReceipt(transactionData) {
    try {
      const {
        disco,
        meterType,
        meterNumber,
        amount,
        charges,
        reference,
        date,
        status = 'Successful',
        token = null
      } = transactionData;

      // Create high-quality canvas
      const canvas = createCanvas(this.scaleValue(400), this.scaleValue(650));
      const ctx = canvas.getContext('2d');
      
      // Enable high-quality rendering
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Set background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.scaleValue(400), this.scaleValue(650));

      // Header
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, this.scaleValue(400), this.scaleValue(80));

      // Load and draw logo
      const logo = await this.loadLogo();
      if (logo) {
        const logoSize = this.scaleValue(40);
        const logoX = this.scaleValue(30);
        const logoY = this.scaleValue(20);
        ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
      } else {
        ctx.fillStyle = '#ff6666';
        ctx.beginPath();
        ctx.arc(this.scaleValue(50), this.scaleValue(40), this.scaleValue(20), 0, 2 * Math.PI);
        ctx.fill();
      }

      // MiiMii.AI title
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${this.scaleValue(24)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('MiiMii.AI', this.scaleValue(200), this.scaleValue(35));

      // Transaction Receipt title
      ctx.fillStyle = '#000000';
      ctx.font = `bold italic ${this.scaleValue(28)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('Transaction Receipt', this.scaleValue(200), this.scaleValue(120));

      // Generated date
      ctx.font = `${this.scaleValue(12)}px Outfit, Arial`;
      ctx.fillStyle = '#666666';
      ctx.fillText(`Generated from The MiiMii AI on ${date}`, this.scaleValue(200), this.scaleValue(140));

      // Content area background
      ctx.fillStyle = '#f0f8f0';
      ctx.fillRect(this.scaleValue(20), this.scaleValue(160), this.scaleValue(360), this.scaleValue(370));

      // Transaction details
      const details = [
        { label: 'Transaction Amount', value: `₦ ${parseFloat(amount).toLocaleString()}.00` },
        { label: 'Transaction Type', value: 'Electricity Bill Payment' },
        { label: 'Transaction Date', value: date },
        { label: 'Disco', value: disco },
        { label: 'Meter Type', value: meterType },
        { label: 'Meter Number', value: meterNumber },
        { label: 'Charges', value: `₦ ${parseFloat(charges).toLocaleString()}.00` },
        { label: 'Transaction Reference', value: reference },
        { label: 'Transaction Status', value: status }
      ];

      let yPos = this.scaleValue(180);
      details.forEach((detail, index) => {
        // Label
        ctx.fillStyle = '#333333';
        ctx.font = `bold ${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'left';
        ctx.fillText(detail.label, this.scaleValue(40), yPos);

        // Separator line
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.scaleValue(40), yPos + this.scaleValue(5));
        ctx.lineTo(this.scaleValue(360), yPos + this.scaleValue(5));
        ctx.stroke();

        // Value
        ctx.fillStyle = '#000000';
        ctx.font = `${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'right';
        ctx.fillText(detail.value, this.scaleValue(360), yPos);

        yPos += this.scaleValue(35);
      });

      // Add token if available
      if (token) {
        yPos += this.scaleValue(10);
        ctx.fillStyle = '#333333';
        ctx.font = `bold ${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'left';
        ctx.fillText('Meter Token', 40, yPos);

        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.scaleValue(40), yPos + this.scaleValue(5));
        ctx.lineTo(this.scaleValue(360), yPos + this.scaleValue(5));
        ctx.stroke();

        ctx.fillStyle = '#000000';
        ctx.font = `${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'right';
        ctx.fillText(token, 360, yPos);
      }

      // Footer - Short contact info
      ctx.fillStyle = '#666666';
      ctx.font = `${this.scaleValue(9)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('Support: contactcenter@chatmiimii.com', this.scaleValue(200), this.scaleValue(570));

      // Red line
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.scaleValue(50), this.scaleValue(590));
      ctx.lineTo(this.scaleValue(350), this.scaleValue(590));
      ctx.stroke();

      // Brand message
      ctx.fillStyle = '#000000';
      ctx.font = `${this.scaleValue(9)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      const brandMessage = 'MiiMii is powered by a CBN licensed partner and insured by NDIC. Send money, buy airtime, buy data, pay your bills and cable subscription with just a chat all inside whatsapp';
      // Split into multiple lines if needed (max ~50 chars per line)
      const words = brandMessage.split(' ');
      let line = '';
      yPos = this.scaleValue(610); // Reuse existing yPos variable
      words.forEach((word, index) => {
        const testLine = line + word + ' ';
        if (testLine.length > 50 && line.length > 0) {
          ctx.fillText(line.trim(), this.scaleValue(200), yPos);
          line = word + ' ';
          yPos += this.scaleValue(15);
        } else {
          line = testLine;
        }
      });
      if (line.trim().length > 0) {
        ctx.fillText(line.trim(), this.scaleValue(200), yPos);
      }

      // Convert to buffer
      const buffer = canvas.toBuffer('image/jpeg', { quality: 1.0 });
      
      // Validate the generated buffer
      if (!buffer || !Buffer.isBuffer(buffer)) {
        throw new Error('Failed to generate valid image buffer');
      }
      
      const bufferSizeInKB = buffer.length / 1024;
      logger.info('Electricity receipt generated successfully', {
        reference,
        disco,
        meterNumber,
        amount,
        bufferSize: `${bufferSizeInKB.toFixed(2)}KB`
      });

      return buffer;
    } catch (error) {
      logger.error('Failed to generate electricity receipt', { error: error.message, transactionData });
      throw error;
    }
  }

  async generateTransferReceipt(transactionData) {
    try {
      const {
        type,
        amount,
        fee,
        totalAmount,
        recipientName,
        recipientBank,
        recipientAccount,
        reference,
        date,
        status = 'Successful',
        senderName
      } = transactionData;

      // Create high-quality canvas
      const canvas = createCanvas(this.scaleValue(400), this.scaleValue(650));
      const ctx = canvas.getContext('2d');
      
      // Enable high-quality rendering
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

      // Set background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, this.scaleValue(400), this.scaleValue(650));

      // Header
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, this.scaleValue(400), this.scaleValue(80));

      // Load and draw logo
      const logo = await this.loadLogo();
      if (logo) {
        const logoSize = this.scaleValue(40);
        const logoX = this.scaleValue(30);
        const logoY = this.scaleValue(20);
        ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
      } else {
        ctx.fillStyle = '#ff6666';
        ctx.beginPath();
        ctx.arc(this.scaleValue(50), this.scaleValue(40), this.scaleValue(20), 0, 2 * Math.PI);
        ctx.fill();
      }

      // MiiMii.AI title
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${this.scaleValue(24)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('MiiMii.AI', this.scaleValue(200), this.scaleValue(35));

      // Transaction Receipt title
      ctx.fillStyle = '#000000';
      ctx.font = `bold italic ${this.scaleValue(28)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('Transaction Receipt', this.scaleValue(200), this.scaleValue(120));

      // Generated date
      ctx.font = `${this.scaleValue(12)}px Outfit, Arial`;
      ctx.fillStyle = '#666666';
      ctx.fillText(`Generated from The MiiMii AI on ${date}`, this.scaleValue(200), this.scaleValue(140));

      // Content area background
      ctx.fillStyle = '#f0f8f0';
      ctx.fillRect(this.scaleValue(20), this.scaleValue(160), this.scaleValue(360), this.scaleValue(370));

      // Transaction details
      const details = [
        { label: 'Transaction Amount', value: `₦ ${parseFloat(amount).toLocaleString()}.00` },
        { label: 'Transaction Type', value: type },
        { label: 'Transaction Date', value: date },
        { label: 'Recipient Name', value: recipientName },
        { label: 'Recipient Bank', value: recipientBank },
        { label: 'Recipient Account', value: recipientAccount },
        { label: 'Transaction Fee', value: `₦ ${parseFloat(fee).toLocaleString()}.00` },
        { label: 'Total Amount', value: `₦ ${parseFloat(totalAmount).toLocaleString()}.00` },
        { label: 'Transaction Reference', value: reference },
        { label: 'Transaction Status', value: status }
      ];

      let yPos = this.scaleValue(180);
      details.forEach((detail, index) => {
        // Label
        ctx.fillStyle = '#333333';
        ctx.font = `bold ${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'left';
        ctx.fillText(detail.label, this.scaleValue(40), yPos);

        // Separator line
        ctx.strokeStyle = '#cccccc';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(this.scaleValue(40), yPos + this.scaleValue(5));
        ctx.lineTo(this.scaleValue(360), yPos + this.scaleValue(5));
        ctx.stroke();

        // Value
        ctx.fillStyle = '#000000';
        ctx.font = `${this.scaleValue(10)}px Outfit, Arial`;
        ctx.textAlign = 'right';
        ctx.fillText(detail.value, this.scaleValue(360), yPos);

        yPos += this.scaleValue(35);
      });

      // Footer - Short contact info
      ctx.fillStyle = '#666666';
      ctx.font = `${this.scaleValue(9)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      ctx.fillText('Support: contactcenter@chatmiimii.com', this.scaleValue(200), this.scaleValue(570));

      // Red line
      ctx.strokeStyle = '#ff0000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(this.scaleValue(50), this.scaleValue(590));
      ctx.lineTo(this.scaleValue(350), this.scaleValue(590));
      ctx.stroke();

      // Brand message
      ctx.fillStyle = '#000000';
      ctx.font = `${this.scaleValue(9)}px Outfit, Arial`;
      ctx.textAlign = 'center';
      const brandMessage = 'MiiMii is powered by a CBN licensed partner and insured by NDIC. Send money, buy airtime, buy data, pay your bills and cable subscription with just a chat all inside whatsapp';
      // Split into multiple lines if needed (max ~50 chars per line)
      const words = brandMessage.split(' ');
      let line = '';
      yPos = this.scaleValue(610); // Reuse existing yPos variable
      words.forEach((word, index) => {
        const testLine = line + word + ' ';
        if (testLine.length > 50 && line.length > 0) {
          ctx.fillText(line.trim(), this.scaleValue(200), yPos);
          line = word + ' ';
          yPos += this.scaleValue(15);
        } else {
          line = testLine;
        }
      });
      if (line.trim().length > 0) {
        ctx.fillText(line.trim(), this.scaleValue(200), yPos);
      }

      // Convert to buffer
      const buffer = canvas.toBuffer('image/jpeg', { quality: 1.0 });
      
      // Validate the generated buffer
      if (!buffer || !Buffer.isBuffer(buffer)) {
        throw new Error('Failed to generate valid image buffer');
      }
      
      const bufferSizeInKB = buffer.length / 1024;
      logger.info('Transfer receipt generated successfully', {
        reference,
        recipientName,
        amount,
        bufferSize: `${bufferSizeInKB.toFixed(2)}KB`
      });

      return buffer;
    } catch (error) {
      logger.error('Failed to generate transfer receipt', { error: error.message, transactionData });
      throw error;
    }
  }
}

module.exports = new ReceiptService();
