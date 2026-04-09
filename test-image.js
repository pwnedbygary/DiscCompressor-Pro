const { app, nativeImage } = require('electron');
const fs = require('fs');
app.whenReady().then(() => {
  const buf = fs.readFileSync('assets/tray-icon-64.png');
  const img1 = nativeImage.createFromBuffer(buf);
  console.log('From buffer empty?', img1.isEmpty());
  const img2 = nativeImage.createFromPath(require('path').resolve('assets/tray-icon-64.png'));
  console.log('From path empty?', img2.isEmpty());
  app.quit();
});
