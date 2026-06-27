const { createCanvas, loadImage } = require('canvas');
const path = require('path');

class NewReceipt {
  async generate(data) {
    const canvas = createCanvas(800, 1400);
    const ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    return canvas.toBuffer("image/png");
  }
}

module.exports = new NewReceipt();
