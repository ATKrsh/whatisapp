const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');

// Disable GPU to prevent crash on systems with restricted GPU access
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('no-sandbox');

// Show any uncaught errors instead of silently dying
process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Fatal Error', err.message + '\n\n' + err.stack);
  app.quit();
});

let mainWindow;

// Only allow a single instance
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    try {
      const net = require('net');
      const server = require('./index');

      function startServer() {
        server.listen(3000, () => {
          console.log('WhatIsApp backend running on port 3000 inside Electron');
          createWindow();
        }).on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            const { execSync } = require('child_process');
            try {
              execSync('for /f "tokens=5" %a in (\'netstat -aon ^| find ":3000 "\') do taskkill /F /PID %a', { shell: 'cmd.exe', stdio: 'ignore' });
            } catch(e) {}
            setTimeout(startServer, 1500);
          } else {
            dialog.showErrorBox('Server Error', err.message);
          }
        });
      }
      startServer();
    } catch(err) {
      dialog.showErrorBox('Initialization Error', err.message + '\n\n' + err.stack);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL('http://localhost:3000');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  const showFallback = setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      mainWindow.show();
      mainWindow.focus();
    }
  }, 10000);
  mainWindow.once('ready-to-show', () => clearTimeout(showFallback));

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    if (errorCode === -3) return;
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'Page Load Failed',
      message: `Could not load WhatIsApp.\n\nError: ${errorDescription} (${errorCode})\n\nThe server may still be starting. Click Retry.`,
      buttons: ['Retry', 'Quit']
    }).then(({ response }) => {
      if (response === 0) {
        mainWindow.loadURL('http://localhost:3000');
      } else {
        app.quit();
      }
    });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  ipcMain.on('window-minimize', () => {
    mainWindow.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    app.quit(); // Assuming WhatIsApp we just close it for now
  });
}

ipcMain.on('app-quit', () => {
  app.quit();
});
