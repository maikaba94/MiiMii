const { createCanvas } = require('canvas');

class ReceiptService {
  async generateReceipt(data) {
    const canvas = createCanvas(800, 1400);
    const ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Red header
    ctx.fillStyle = "#e30613";
    ctx.fillRect(0, 0, canvas.width, 140);

    // Title
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 44px Arial";
    ctx.textAlign = "center";
    ctx.fillText("Transaction Receipt", 400, 85);

    return canvas.toBuffer("image/png");
  }
}

module.exports = new ReceiptService();
